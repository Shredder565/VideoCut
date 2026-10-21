/* eslint-disable no-continue */ // the signal scanning loops read more clearly with early continues
// Automatic commercial (ad break) detection.
//
// One ffmpeg pass decodes the video and audio once and measures, cheaply:
//  - black frames   (blackdetect on a downscaled copy of the picture, frame accurate)
//  - silence        (silencedetect on a downmixed, 8 kHz copy of the audio)
//  - scene cuts     (scdet on the downscaled picture)
//  - loudness       (astats RMS level per fixed window, e.g. 1 s)
// Then the signals are combined with heuristics (see `findAdBreaks`) into likely ad breaks,
// which are returned as segments (seconds relative to the file start, like the clips on the timeline)
// for the user to review, accept or adjust.
//
// Heuristics in short:
//  1. Break markers: TV stations separate commercial spots with a short (≈0.1–2 s) run of black frames
//     during which the audio is silent. A black interval that overlaps a silent interval is a "marker".
//  2. Spot spacing: commercials have standard lengths (10/15/20/30/45/60/90/120 s). Consecutive markers whose
//     spacing matches one of these lengths (within a tolerance) form a chain. A chain of >= 2 spots,
//     30 s – 8 min in total, is a candidate break. Programme content rarely has black+silence at such regular spacings.
//  3. Supporting evidence: within an ad block the cut rate (scene changes per minute) is usually higher and the
//     audio is often louder than the surrounding programme. This is used to
//       - drop an edge "spot" of a chain that looks like the programme (e.g. a fade-out in the programme that happens
//         to be 30 s after the break),
//       - add an adjacent segment of non-standard length that looks like the ads (a 25 s promo, or a partial spot
//         at the very start or end of the recording: pre-roll / post-roll),
//       - compute a confidence score, and drop chains that look exactly like their surroundings.
//
// This module has no runtime imports, so that it can be driven by a plain Node.js script (see test-manual/adDetect).

import type { FfRunner } from './smartRender.ts';

export interface AdDetectOptions {
  // --- analysis pass (changing these requires a new ffmpeg pass) ---
  // width of the downscaled picture used for black and cut detection
  analysisWidth: number,
  // blackdetect pix_th: a pixel is black if its luma is below this fraction of the luma range
  blackPixelThreshold: number,
  // blackdetect pic_th: a frame is black if at least this fraction of its pixels is black
  blackPictureRatio: number,
  // minimum duration of a run of black frames (seconds)
  minBlackDuration: number,
  // silencedetect noise level (dB) and minimum duration (seconds)
  silenceNoiseDb: number,
  minSilenceDuration: number,
  // scdet threshold (0-100) for counting a scene cut
  sceneThreshold: number,
  // length of the loudness measurement windows (seconds)
  loudnessWindow: number,
  // skip the in-loop deblocking filter when decoding (h264/hevc): faster, and irrelevant for these measurements
  fastDecode: boolean,

  // --- combination heuristics (can be re-run on the same signals with `findAdBreaks`) ---
  // a black interval and a silent interval belong to the same marker if they are at most this far apart (seconds)
  markerTolerance: number,
  // only use markers whose black and silence coincide. If the file has no audio, black alone is used.
  requireSilence: boolean,
  // black runs longer than this are not separators between spots (e.g. a dark scene)
  maxSeparatorDuration: number,
  // standard commercial spot lengths (seconds)
  spotLengths: number[],
  // allowed deviation of a spot from a standard length (seconds)
  spotTolerance: number,
  // longest segment that may be added to a break because it looks like the ads, without having a standard length
  maxIrregularSpot: number,
  // a break needs at least this many spots
  minSpots: number,
  // a break must be this long (seconds)
  minBreakLength: number,
  maxBreakLength: number,
  // how much programme before and after a break to compare it with (seconds)
  contextLength: number,
  // breaks with a lower confidence (0..1) are not returned
  minConfidence: number,
}

export const defaultAdDetectOptions: AdDetectOptions = {
  analysisWidth: 160,
  blackPixelThreshold: 0.1,
  blackPictureRatio: 0.98,
  minBlackDuration: 0.08,
  silenceNoiseDb: -50,
  minSilenceDuration: 0.1,
  sceneThreshold: 10,
  loudnessWindow: 1,
  fastDecode: true,

  markerTolerance: 0.4,
  requireSilence: true,
  maxSeparatorDuration: 5,
  spotLengths: [10, 15, 20, 30, 45, 60, 90, 120],
  spotTolerance: 1,
  maxIrregularSpot: 125,
  minSpots: 2,
  minBreakLength: 25,
  maxBreakLength: 8 * 60,
  contextLength: 120,
  minConfidence: 0.45,
};

export interface TimeInterval { start: number, end: number }

// The raw measurements of the analysis pass. Times are seconds relative to the file start.
export interface AdDetectSignals {
  duration: number,
  hasAudio: boolean,
  black: TimeInterval[],
  silence: TimeInterval[],
  cuts: number[],
  // RMS level (dB, -Infinity for digital silence) per window starting at `time`
  loudness: { time: number, db: number }[],
  loudnessWindow: number,
}

export interface AdBreakMarker {
  // middle of the black interval
  time: number,
  blackStart: number,
  blackEnd: number,
  blackDuration: number,
  silent: boolean,
}

export interface AdBreak {
  start: number,
  end: number,
  confidence: number,
  reasons: string[],
  // number of spots (segments between markers) in the break
  spots: number,
}

export interface AdDetectStats {
  duration: number,
  analysisSeconds: number,
  // analysis time per minute of video
  secondsPerMinute: number,
  blackIntervals: number,
  silentIntervals: number,
  sceneCuts: number,
  markers: number,
  silentMarkers: number,
  hasAudio: boolean,
  // median loudness and cut rate outside the detected breaks
  programLoudnessDb: number | undefined,
  programCutsPerMinute: number | undefined,
}

export interface AdDetectResult {
  breaks: AdBreak[],
  markers: AdBreakMarker[],
  stats: AdDetectStats,
  signals: AdDetectSignals,
}

// A runner may optionally stream ffmpeg's stderr (for progress) and support aborting.
export interface AdDetectRunner extends FfRunner {
  ffmpegStreaming?: (args: string[], opts: { onStderr: (chunk: string) => void, signal?: AbortSignal | undefined }) => Promise<{ stderr: string }>,
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    const err = new Error('Ad break detection was aborted');
    err.name = 'AbortError';
    throw err;
  }
}

interface ProbeResult {
  startTime: number,
  duration: number | undefined,
  streams: { index: number, codec_type?: string, disposition?: { attached_pic?: number } }[],
}

async function probe(runner: FfRunner, path: string): Promise<ProbeResult> {
  const stdout = await runner.ffprobe(['-v', 'error', '-show_entries', 'format=start_time,duration:stream=index,codec_type:stream_disposition=attached_pic', '-of', 'json', path]);
  const { format, streams = [] } = JSON.parse(stdout) as { format?: { start_time?: string, duration?: string }, streams?: ProbeResult['streams'] };
  const startTime = parseFloat(format?.start_time ?? '');
  const duration = parseFloat(format?.duration ?? '');
  return { startTime: Number.isNaN(startTime) ? 0 : startTime, duration: Number.isNaN(duration) ? undefined : duration, streams };
}

export function buildAnalysisArgs({ path, videoStreamIndex, audioStreamIndex, options }: {
  path: string,
  videoStreamIndex: number,
  audioStreamIndex: number | undefined,
  options: AdDetectOptions,
}) {
  const o = options;
  // Downscaling makes black and cut detection much cheaper than at full resolution, and does not change
  // whether a frame is (almost) entirely black. Every frame is still decoded, so black runs are frame accurate.
  const video = `[0:${videoStreamIndex}]scale=${o.analysisWidth}:-2:flags=fast_bilinear,`
    + `blackdetect=d=${o.minBlackDuration}:pix_th=${o.blackPixelThreshold}:pic_th=${o.blackPictureRatio},`
    + `scdet=threshold=${o.sceneThreshold}[v]`;
  // Downmix to mono 8 kHz (cheap), detect silence, then measure the RMS level per window.
  const windowSamples = Math.max(1, Math.round(8000 * o.loudnessWindow));
  const audio = audioStreamIndex != null
    ? `;[0:${audioStreamIndex}]aresample=8000,aformat=sample_fmts=flt:channel_layouts=mono,`
      + `silencedetect=n=${o.silenceNoiseDb}dB:d=${o.minSilenceDuration},`
      + `asetnsamples=n=${windowSamples}:p=0,`
      + 'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,'
      + 'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level[a]'
    : '';
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'info', '-stats_period', '1',
    ...(o.fastDecode ? ['-skip_loop_filter', 'all'] : []),
    '-threads', '0',
    '-i', path,
    '-filter_complex', video + audio,
    '-map', '[v]', ...(audioStreamIndex != null ? ['-map', '[a]'] : []),
    '-fps_mode', 'passthrough', '-sn', '-dn',
    '-f', 'null', '-',
  ];
}

const num = String.raw`(-?[\d.]+(?:e[-+]?\d+)?|-?inf|nan)`;
const blackRe = new RegExp(String.raw`black_start:\s*${num}\s+black_end:\s*${num}`);
const silenceStartRe = new RegExp(String.raw`silence_start:\s*${num}`);
const silenceEndRe = new RegExp(String.raw`silence_end:\s*${num}`);
const scdRe = new RegExp(String.raw`lavfi\.scd\.score:\s*${num},\s*lavfi\.scd\.time:\s*${num}`);
const ptsTimeRe = new RegExp(String.raw`\]\s*frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*${num}`);
const rmsRe = new RegExp(String.raw`lavfi\.astats\.Overall\.RMS_level=${num}`);
const progressRe = /time=\s*(-?)(\d+):(\d+):([\d.]+)/;

function parseNum(s: string | undefined) {
  if (s == null) return NaN;
  if (s === 'inf') return Infinity;
  if (s === '-inf') return -Infinity;
  return parseFloat(s);
}

// Parse the log of the analysis pass. Times in the log are already relative to the file start,
// because ffmpeg (without -copyts) shifts the input timestamps so that the file starts at 0.
export function parseAnalysisLog(stderr: string, { duration, hasAudio, loudnessWindow }: { duration: number, hasAudio: boolean, loudnessWindow: number }): AdDetectSignals {
  const black: TimeInterval[] = [];
  const silence: TimeInterval[] = [];
  const cuts: number[] = [];
  const loudness: { time: number, db: number }[] = [];
  let silenceStart: number | undefined;
  let lastPtsTime: number | undefined;

  for (const line of stderr.split(/\r\n|\r|\n/)) {
    let m = blackRe.exec(line);
    if (m) {
      black.push({ start: parseNum(m[1]), end: parseNum(m[2]) });
      continue;
    }
    m = silenceStartRe.exec(line);
    if (m) {
      silenceStart = Math.max(0, parseNum(m[1]));
      continue;
    }
    m = silenceEndRe.exec(line);
    if (m) {
      silence.push({ start: silenceStart ?? 0, end: parseNum(m[1]) });
      silenceStart = undefined;
      continue;
    }
    m = scdRe.exec(line);
    if (m) {
      cuts.push(parseNum(m[2]));
      continue;
    }
    m = ptsTimeRe.exec(line);
    if (m) {
      lastPtsTime = parseNum(m[1]);
      continue;
    }
    m = rmsRe.exec(line);
    if (m && lastPtsTime != null) {
      loudness.push({ time: lastPtsTime, db: parseNum(m[1]) });
      lastPtsTime = undefined;
    }
  }
  // silence until the end of the file
  if (silenceStart != null) silence.push({ start: silenceStart, end: duration });

  return {
    duration,
    hasAudio,
    black: black.filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end)).sort((a, b) => a.start - b.start),
    silence: silence.sort((a, b) => a.start - b.start),
    cuts: cuts.filter((c) => Number.isFinite(c)).sort((a, b) => a - b),
    loudness,
    loudnessWindow,
  };
}

// ---------------------------------------------------------------------------------------------
// Combining the signals

function median(values: number[]) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mergeIntervals(intervals: TimeInterval[], maxGap: number) {
  const out: TimeInterval[] = [];
  for (const iv of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last != null && iv.start - last.end <= maxGap) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export function findMarkers(signals: AdDetectSignals, options: AdDetectOptions): AdBreakMarker[] {
  // a black "fade" can be split into several runs by a few slightly brighter frames: join them
  const black = mergeIntervals(signals.black, 0.2).filter((b) => b.end - b.start >= options.minBlackDuration - 1e-6);
  const silence = signals.silence.filter((s) => s.end - s.start >= options.minSilenceDuration - 1e-6);
  return black.map((b) => {
    const tol = options.markerTolerance;
    // separators are short: the silence usually starts slightly before and ends after the black (or the other way round)
    const silent = silence.some((s) => s.start <= b.end + tol && s.end >= b.start - tol);
    return {
      time: round((b.start + b.end) / 2),
      blackStart: round(b.start),
      blackEnd: round(b.end),
      blackDuration: round(b.end - b.start),
      silent,
    };
  });
}

interface Features { loudness: number | undefined, cutRate: number | undefined, seconds: number }

// Compares stretches of the recording by their median loudness and their cut rate
class FeatureIndex {
  private signals: AdDetectSignals;

  private cuts: number[];

  constructor(signals: AdDetectSignals, markers: AdBreakMarker[]) {
    this.signals = signals;
    // fades to and from black trigger the scene detector; those are not "cuts" in the content
    this.cuts = signals.cuts.filter((c) => !markers.some((m) => c >= m.blackStart - 0.5 && c <= m.blackEnd + 0.5));
  }

  features(intervals: TimeInterval[]): Features {
    // ignore the edges (black / silent separators)
    const ivs = intervals.map((iv) => ({ start: iv.start + 0.5, end: iv.end - 0.5 })).filter((iv) => iv.end > iv.start);
    const seconds = ivs.reduce((acc, iv) => acc + iv.end - iv.start, 0);
    if (seconds < 3) return { loudness: undefined, cutRate: undefined, seconds };
    const w = this.signals.loudnessWindow;
    const levels = this.signals.loudness
      .filter((l) => ivs.some((iv) => l.time >= iv.start && l.time + w <= iv.end + w / 2) && l.db > -70)
      .map((l) => l.db);
    const cuts = this.cuts.filter((c) => ivs.some((iv) => c >= iv.start && c <= iv.end)).length;
    return { loudness: median(levels), cutRate: cuts / (seconds / 60), seconds };
  }
}

// Distance between two stretches in "noticeable difference" units:
// 3 dB of loudness, or a cut rate difference of 6/min + 30 % count as 1.
function featureDistance(a: Features, b: Features) {
  let d = 0;
  let n = 0;
  if (a.loudness != null && b.loudness != null) {
    d += Math.abs(a.loudness - b.loudness) / 3;
    n += 1;
  }
  if (a.cutRate != null && b.cutRate != null) {
    d += Math.abs(a.cutRate - b.cutRate) / (6 + 0.3 * Math.max(a.cutRate, b.cutRate));
    n += 1;
  }
  return n > 0 ? d : undefined;
}

// Does `segment` look like the ads (true), like the programme (false), or can't we tell (undefined)?
function classifySegment(segment: Features, ads: Features, programme: Features) {
  const contrast = featureDistance(ads, programme);
  // the ads and the programme are not distinguishable by these features
  if (contrast == null || contrast < 1) return undefined;
  const toAds = featureDistance(segment, ads);
  const toProgramme = featureDistance(segment, programme);
  if (toAds == null || toProgramme == null) return undefined;
  return toAds < toProgramme;
}

interface Candidate {
  // indexes into `points`
  first: number,
  last: number,
}

export function findAdBreaks(signals: AdDetectSignals, partialOptions: Partial<AdDetectOptions> = {}): { breaks: AdBreak[], markers: AdBreakMarker[], programLoudnessDb: number | undefined, programCutsPerMinute: number | undefined } {
  const o: AdDetectOptions = { ...defaultAdDetectOptions, ...partialOptions };
  const { duration } = signals;
  const markers = findMarkers(signals, o);
  const features = new FeatureIndex(signals, markers);

  // Separators used for chaining. Without audio, black alone has to do.
  const useSilence = o.requireSilence && signals.hasAudio;
  const separators = markers.filter((m) => (!useSilence || m.silent) && m.blackDuration <= o.maxSeparatorDuration);

  // Points of the chain: the separators, plus virtual points at the start and end of the recording
  // (a recording often starts or ends in the middle of an ad break).
  interface Point { time: number, start: number, end: number, virtual: boolean }
  const points: Point[] = [
    { time: 0, start: 0, end: 0, virtual: true },
    ...separators.map((m) => ({ time: m.time, start: m.blackStart, end: m.blackEnd, virtual: false })),
    { time: duration, start: duration, end: duration, virtual: true },
  ];

  // How well does the segment between points i and i+1 match a standard spot length?
  // Compare both the content length (end of one black to start of the next) and the distance between the black centres,
  // because some stations count the separator as part of the spot.
  const spotError = (i: number) => {
    const a = points[i]!;
    const b = points[i + 1]!;
    const lengths = [b.start - a.end, b.time - a.time];
    let best = Infinity;
    for (const L of o.spotLengths) for (const len of lengths) best = Math.min(best, Math.abs(len - L));
    return best;
  };
  const isRegular = (i: number) => !points[i]!.virtual && !points[i + 1]!.virtual && spotError(i) <= o.spotTolerance;
  const segmentOf = (i: number): TimeInterval => ({ start: points[i]!.end, end: points[i + 1]!.start });
  const segLength = (i: number) => points[i + 1]!.time - points[i]!.time;

  // 1. Chains of consecutive spot-length segments (at least one segment for now)
  let candidates: Candidate[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    if (!isRegular(i)) continue;
    const prev = candidates.at(-1);
    if (prev != null && prev.last === i) prev.last = i + 1;
    else candidates.push({ first: i, last: i + 1 });
  }

  const spanOf = (c: Candidate): TimeInterval => ({ start: points[c.first]!.time, end: points[c.last]!.time });
  const segmentsOf = (c: Candidate, except?: number) => {
    const out: TimeInterval[] = [];
    for (let i = c.first; i < c.last; i += 1) if (i !== except) out.push(segmentOf(i));
    return out;
  };
  // The programme around a stretch: up to `contextLength` before and after it, minus other candidates
  const contextOf = (span: TimeInterval, others: Candidate[]) => {
    let ivs: TimeInterval[] = [
      { start: Math.max(0, span.start - o.contextLength), end: span.start },
      { start: span.end, end: Math.min(duration, span.end + o.contextLength) },
    ];
    for (const other of others) {
      const os = spanOf(other);
      ivs = ivs.flatMap((iv) => {
        if (os.end <= iv.start || os.start >= iv.end) return [iv];
        return [{ start: iv.start, end: os.start }, { start: os.end, end: iv.end }].filter((x) => x.end - x.start > 1);
      });
    }
    return ivs.filter((iv) => iv.end - iv.start > 1);
  };

  const notes = new Map<Candidate, Set<string>>();
  const note = (c: Candidate, s: string) => {
    if (!notes.has(c)) notes.set(c, new Set());
    notes.get(c)!.add(s);
  };

  // 2. Remove segments that look like the programme: at an edge the chain is trimmed, in the middle it is split.
  // A black+silent fade in the programme that happens to be a spot length away from a break would otherwise extend
  // the break into the programme, and a programme section of exactly 60/90/120 s between two breaks would join them.
  // The segment that differs most from the rest of the chain is removed first, then the chain is checked again.
  const trim = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of candidates) {
        if (c.last - c.first < 2) continue;
        const others = candidates.filter((x) => x !== c);
        const ctx = features.features(contextOf(spanOf(c), others));
        let worst: { i: number, d: number } | undefined;
        for (let i = c.first; i < c.last; i += 1) {
          const seg = features.features([segmentOf(i)]);
          const rest = features.features(segmentsOf(c, i));
          if (classifySegment(seg, rest, ctx) !== false) continue;
          const d = featureDistance(seg, rest) ?? 0;
          if (worst == null || d > worst.d) worst = { i, d };
        }
        if (worst == null) continue;
        const { i } = worst;
        const parts = [{ first: c.first, last: i }, { first: i + 1, last: c.last }].filter((p) => p.last > p.first);
        const idx = candidates.indexOf(c);
        candidates.splice(idx, 1, ...parts);
        for (const p of parts) {
          for (const s of notes.get(c) ?? []) note(p, s);
          note(p, i === c.first || i === c.last - 1 ? 'trimmed an edge segment that looks like the programme' : 'split where a segment looks like the programme');
        }
        changed = true;
        break;
      }
    }
  };

  // 3. Extend chains by an adjacent segment of non-standard length that looks like the ads, e.g. a promo,
  // or a partial spot at the start or end of the recording. Chains that meet are merged.
  const extend = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of candidates) {
        for (const side of ['before', 'after'] as const) {
          const edge = side === 'before' ? c.first - 1 : c.last;
          if (edge < 0 || edge >= points.length - 1) continue;
          if (segLength(edge) > o.maxIrregularSpot) continue;
          const others = candidates.filter((x) => x !== c);
          const seg = segmentOf(edge);
          const span = spanOf(c);
          const ctx = contextOf({ start: Math.min(span.start, seg.start), end: Math.max(span.end, seg.end) }, others);
          const verdict = classifySegment(features.features([seg]), features.features(segmentsOf(c)), features.features(ctx));
          const touchesEnd = points[edge]!.virtual || points[edge + 1]!.virtual;
          // At the very start/end there is often no programme to compare with on that side; a partial spot still has
          // to look like the ads. Elsewhere a regular segment would already be part of the chain.
          if (verdict !== true) continue;
          if (side === 'before') c.first = edge;
          else c.last = edge + 1;
          if (touchesEnd) note(c, side === 'before' ? 'pre-roll: the recording starts inside an ad break' : 'post-roll: the recording ends inside an ad break');
          else note(c, 'includes a segment of non-standard length that looks like the ads');
          changed = true;
        }
      }
      // merge chains that now touch or overlap
      candidates.sort((a, b) => a.first - b.first);
      const merged: Candidate[] = [];
      for (const c of candidates) {
        const prev = merged.at(-1);
        if (prev != null && c.first <= prev.last) {
          prev.last = Math.max(prev.last, c.last);
          for (const s of notes.get(c) ?? []) note(prev, s);
          changed = true;
        } else {
          merged.push(c);
        }
      }
      candidates = merged;
    }
  };

  trim();
  extend();
  trim();

  // 4. Score and filter
  const breaks: (AdBreak & { candidate: Candidate })[] = [];
  for (const c of candidates) {
    const spots = c.last - c.first;
    const span = spanOf(c);
    const length = span.end - span.start;
    const regular: number[] = [];
    for (let i = c.first; i < c.last; i += 1) if (isRegular(i)) regular.push(spotError(i));
    if (spots < o.minSpots || regular.length === 0) continue;
    if (length < o.minBreakLength || length > o.maxBreakLength) continue;

    const reasons = [`${spots} spots separated by black + ${useSilence ? 'silence' : 'black (no audio)'}`];
    const meanErr = regular.reduce((a, b) => a + b, 0) / regular.length;
    reasons.push(`${regular.length} of ${spots} spots have a standard length (mean deviation ${meanErr.toFixed(2)} s)`);

    let confidence = 0.35 + 0.1 * Math.min(spots - 1, 3);
    if (meanErr <= 0.3) confidence += 0.1;

    const others = candidates.filter((x) => x !== c);
    const ctx = contextOf(span, others);
    const fBlock = features.features(segmentsOf(c));
    const fCtx = features.features(ctx);
    let contrast = false;
    if (fBlock.cutRate != null && fCtx.cutRate != null && fBlock.cutRate >= fCtx.cutRate * 1.5 && fBlock.cutRate - fCtx.cutRate >= 3) {
      confidence += 0.15;
      contrast = true;
      reasons.push(`more cuts than the programme around it (${fBlock.cutRate.toFixed(0)}/min vs ${fCtx.cutRate.toFixed(0)}/min)`);
    }
    if (fBlock.loudness != null && fCtx.loudness != null) {
      const diff = fBlock.loudness - fCtx.loudness;
      if (diff >= 1.5) {
        confidence += 0.1;
        contrast = true;
        reasons.push(`louder than the programme around it (+${diff.toFixed(1)} dB)`);
      }
    }
    const hasContext = fCtx.seconds >= 10;
    if (hasContext && !contrast) {
      confidence -= 0.15;
      reasons.push('looks like the programme around it (no change in cut rate or loudness)');
    }
    for (const s of notes.get(c) ?? []) reasons.push(s);
    confidence = Math.max(0, Math.min(1, confidence));
    if (confidence < o.minConfidence) continue;
    breaks.push({ start: round(span.start), end: round(span.end), confidence: round(confidence), reasons, spots, candidate: c });
  }

  // programme statistics (everything outside the breaks)
  let programme: TimeInterval[] = [{ start: 0, end: duration }];
  for (const b of breaks) {
    programme = programme.flatMap((iv) => [{ start: iv.start, end: Math.min(iv.end, b.start) }, { start: Math.max(iv.start, b.end), end: iv.end }]).filter((iv) => iv.end - iv.start > 1);
  }
  const fProg = features.features(programme);

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    breaks: breaks.map(({ candidate: _c, ...b }) => b),
    markers,
    programLoudnessDb: fProg.loudness != null ? round(fProg.loudness) : undefined,
    programCutsPerMinute: fProg.cutRate != null ? round(fProg.cutRate) : undefined,
  };
}

// ---------------------------------------------------------------------------------------------

export async function analyzeSignals({ runner, path, videoStreamIndex, audioStreamIndex, options: partialOptions, onProgress, signal }: {
  runner: AdDetectRunner,
  path: string,
  videoStreamIndex?: number | undefined,
  audioStreamIndex?: number | undefined,
  options?: Partial<AdDetectOptions> | undefined,
  onProgress?: ((progress: number) => void) | undefined,
  signal?: AbortSignal | undefined,
}): Promise<AdDetectSignals> {
  const options = { ...defaultAdDetectOptions, ...partialOptions };
  throwIfAborted(signal);
  const info = await probe(runner, path);
  const notAttachedPic = (s: ProbeResult['streams'][number]) => !s.disposition?.attached_pic;
  const vIndex = videoStreamIndex ?? info.streams.find((s) => s.codec_type === 'video' && notAttachedPic(s))?.index;
  if (vIndex == null) throw new Error('No video stream to analyze');
  const aIndex = audioStreamIndex ?? info.streams.find((s) => s.codec_type === 'audio')?.index;

  const args = buildAnalysisArgs({ path, videoStreamIndex: vIndex, audioStreamIndex: aIndex, options });
  throwIfAborted(signal);
  onProgress?.(0);

  let stderr: string;
  if (runner.ffmpegStreaming != null) {
    let buf = '';
    ({ stderr } = await runner.ffmpegStreaming(args, {
      signal,
      onStderr: (chunk) => {
        if (onProgress == null || info.duration == null || info.duration <= 0) return;
        buf = (buf + chunk).slice(-2000);
        const lines = buf.split(/\r|\n/);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const m = progressRe.exec(lines[i]!);
          if (m) {
            const t = (m[1] ? -1 : 1) * (parseInt(m[2]!, 10) * 3600 + parseInt(m[3]!, 10) * 60 + parseFloat(m[4]!));
            onProgress(Math.max(0, Math.min(0.99, t / info.duration)));
            break;
          }
        }
      },
    }));
  } else {
    ({ stderr } = await runner.ffmpeg(args));
  }
  throwIfAborted(signal);

  // duration fallback: the last time reported by ffmpeg
  let { duration } = info;
  if (duration == null) {
    const all = [...stderr.matchAll(new RegExp(progressRe, 'g'))];
    const m = all.at(-1);
    duration = m ? parseInt(m[2]!, 10) * 3600 + parseInt(m[3]!, 10) * 60 + parseFloat(m[4]!) : 0;
  }
  return parseAnalysisLog(stderr, { duration, hasAudio: aIndex != null, loudnessWindow: options.loudnessWindow });
}

// Analyze a recording and return likely ad breaks. Times are seconds relative to the file start.
export async function detectAdBreaks({ runner, path, videoStreamIndex, audioStreamIndex, options, onProgress, signal }: {
  runner: AdDetectRunner,
  path: string,
  // absolute stream indexes (as in ffprobe). Default: the first video / audio stream
  videoStreamIndex?: number | undefined,
  audioStreamIndex?: number | undefined,
  options?: Partial<AdDetectOptions> | undefined,
  // 0..1. Only reported during the analysis if the runner implements `ffmpegStreaming`
  onProgress?: ((progress: number) => void) | undefined,
  signal?: AbortSignal | undefined,
}): Promise<AdDetectResult> {
  const t0 = Date.now();
  const signals = await analyzeSignals({ runner, path, videoStreamIndex, audioStreamIndex, options, onProgress, signal });
  const analysisSeconds = (Date.now() - t0) / 1000;
  const { breaks, markers, programLoudnessDb, programCutsPerMinute } = findAdBreaks(signals, options);
  onProgress?.(1);
  return {
    breaks,
    markers,
    signals,
    stats: {
      duration: signals.duration,
      analysisSeconds: round(analysisSeconds),
      secondsPerMinute: signals.duration > 0 ? round(analysisSeconds / (signals.duration / 60)) : 0,
      blackIntervals: signals.black.length,
      silentIntervals: signals.silence.length,
      sceneCuts: signals.cuts.length,
      markers: markers.length,
      silentMarkers: markers.filter((m) => m.silent).length,
      hasAudio: signals.hasAudio,
      programLoudnessDb,
      programCutsPerMinute,
    },
  };
}
