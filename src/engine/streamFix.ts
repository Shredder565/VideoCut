// Recording repair for TV recordings (MPEG-TS, M2TS, MPEG-PS): a lossless remux that repairs the timestamps and drops damaged data,
// so that the result plays, seeks and cuts properly.
//
// Recordings typically have:
// - timestamp discontinuities: a jump (forwards or backwards) where the broadcaster's clock was reset, at a splice,
//   or where two recordings were joined byte-wise. Players and editors see a file that is hours long, or whose timeline folds back on itself.
// - 33-bit wraparound: MPEG timestamps wrap every 26.5 hours, so a recording can cross the wrap.
// - corrupt data from reception errors: packets flagged as corrupt by the demuxer, or missing packets (gaps). A frame after
//   missing or corrupt data can't be decoded cleanly until the next keyframe.
// - undecodable frames at the start (the recording started in the middle of a GOP), and audio that starts later or earlier than the video.
//
// How it works:
// 1. analyzeStream() reads all packet timestamps with ffprobe (no decoding, so it's fast even for long recordings), and finds the problems.
//    Optionally it also decodes the whole file to count decoding errors.
// 2. planStreamFix() decides, per packet, which packets to drop and how much to shift the timestamps of each kept packet:
//    - The "master" stream (the first video stream, or the first audio stream if there is no video) is split into segments at each
//      discontinuity. Each segment is moved so that it follows the previous one after exactly one frame duration, i.e. the timeline is
//      rebuilt from the frame order and frame rate at the discontinuities, while gaps inside a segment (lost data) are kept, so audio stays in sync.
//    - Every packet of the other streams is moved with the master segment it belongs to (by timestamp range and file position), so audio
//      stays aligned to the video at each discontinuity. Where the previous segment's audio would overlap the next segment's by a little,
//      the next segment is moved a little further (the last video frame is shown slightly longer), so the audio stays complete and seamless;
//      larger overlaps are resolved by dropping the overlapping audio packets at the end of the previous segment.
//    - Damaged video frames, from a corrupt or missing packet until the next keyframe, are dropped, together with the leading pictures
//      of that keyframe (open GOP pictures that reference the frames before it). The same applies to the start of the file and of each segment.
//    - Optionally the start is trimmed so that video and audio start together, at a keyframe.
//    - Finally everything is shifted so that the output starts at zero (this also removes a 33-bit wraparound).
// 3. fixStream() runs ffmpeg with stream copy. ffmpeg's own timestamp handling is disabled with -copyts, and the plan is applied per stream with
//    the `setts` (timestamp shift by packet number) and `noise` (drop by packet number) bitstream filters. Both see the packets in the same order
//    as ffprobe listed them, because the same input options are used and -copyinkf stops ffmpeg from dropping packets itself.
//    The output is then analyzed again to verify it.
//
// This module has no runtime imports, so that it can be driven by a plain Node.js script (see test-manual/streamFix).

import type { FfRunner } from './smartRender.ts';

export type { FfRunner } from './smartRender.ts';

// Timestamps are kept in the stream's own time base units ("ticks"), like ffmpeg, so that no precision is lost. `n` is the packet's
// number within its stream, in file order. It is the same number that the `setts` (N) and `noise` (n) bitstream filters see.
export interface StreamFixPacket {
  n: number,
  pts: number | undefined,
  dts: number | undefined,
  // 0 if unknown
  duration: number,
  keyframe: boolean,
  // the demuxer flagged the packet as corrupt (e.g. MPEG-TS continuity counter errors)
  corrupt: boolean,
  // byte position in the file
  pos: number | undefined,
}

export interface StreamFixStreamInfo {
  index: number,
  codecType: string,
  codecName: string | undefined,
  // seconds per tick
  timeBase: number,
  // seconds. Video: one frame (from the frame rate), audio: the typical packet duration
  frameDuration: number | undefined,
  sampleRate: number | undefined,
  channels: number | undefined,
  language: string | undefined,
  // cover art etc., not a real video stream
  attachedPic: boolean,
  // false if the container doesn't store decode timestamps (Matroska), so the demuxer guesses them from the presentation timestamps
  dtsStored: boolean,
  packetCount: number,
  // seconds, in the file's own timestamps
  firstTime: number | undefined,
}

export type TimestampProblemKind =
  // the timestamps jump by more than `gapThreshold` (forwards), or go backwards: a discontinuity
  | 'jump'
  // small backwards step, or the same timestamp twice
  | 'backwards'
  // a forward step smaller than `gapThreshold`, larger than expected: lost data. Kept as it is by the fix
  | 'gap'
  // the timestamps cross the 33-bit MPEG wraparound (26.5 hours)
  | 'wrap';

export interface TimestampProblem {
  kind: TimestampProblemKind,
  streamIndex: number,
  // number of the first packet after the problem
  packet: number,
  // seconds, in the file's own timestamps: the last good timestamp before the problem, and the one after it
  from: number,
  to: number,
  // seconds: how much the timestamps differ from what was expected (negative when going backwards)
  size: number,
  // approximate position in the content (seconds from its start, with discontinuities removed), for showing to the user
  at: number,
}

export interface StreamFixReport {
  path: string,
  // ffmpeg format name, e.g. "mpegts", "mpeg"
  container: string,
  // seconds, as the container claims (can be far off with discontinuities)
  duration: number | undefined,
  startTime: number | undefined,
  // seconds of actual content of the master stream, with discontinuities removed
  contentDuration: number | undefined,
  streams: StreamFixStreamInfo[],
  // the stream that the timeline is built from: the first video stream, else the first audio stream
  masterStreamIndex: number | undefined,
  timestampProblems: TimestampProblem[],
  // packets flagged as corrupt by the demuxer (all streams)
  corruptPackets: number,
  // video frames that can't be decoded cleanly because of corrupt or missing data before them (not counting the start of the file)
  damagedFrames: number,
  // video frames at the start of the file (or of a segment after a discontinuity) that can't be decoded because they
  // reference frames before the start (the recording started mid-GOP)
  undecodableStartFrames: number,
  // packets without any timestamp
  missingTimestamps: number,
  // seconds: first audio timestamp minus first video timestamp (positive: the audio starts later). Undefined without video or audio
  avOffset: number | undefined,
  // only with `decodeCheck`: number of decoder error messages, and a few of them
  decodeErrors: number | undefined,
  decodeErrorSamples: string[],
  needsFix: boolean,
  // human readable, one per kind of problem
  problems: string[],
  // human readable remarks that are not problems (e.g. gaps that will be kept)
  notes: string[],
  // all packets per stream index, needed by fixStream()
  packets: Map<number, StreamFixPacket[]>,
}

export interface StreamFixAnalyzeOptions {
  // forward timestamp steps larger than this (seconds) are discontinuities that get removed, smaller ones are gaps (lost data) that are kept
  gapThreshold?: number | undefined,
  // decode all video and audio streams to count decoding errors (slower: a full decode)
  decodeCheck?: boolean | undefined,
}

export type StreamFixFormat = 'mpegts' | 'matroska' | 'mp4' | 'mpeg';

export interface StreamFixOptions extends StreamFixAnalyzeOptions {
  // output container. Default: MPEG-PS input gives "mpeg", everything else "mpegts" (M2TS if the output file name ends in .m2ts/.mts)
  format?: StreamFixFormat | undefined,
  // 'all': all streams the output container can hold (default), 'main': the master video stream and all audio streams
  tracks?: 'all' | 'main' | undefined,
  // trim the start so that video and audio start together, on a video keyframe (default true)
  fixAvOffset?: boolean | undefined,
  // drop video frames that can't be decoded cleanly after corrupt or missing data, until the next keyframe (default true).
  // If false, only packets flagged as corrupt are dropped.
  dropDamaged?: boolean | undefined,
}

export interface StreamFixStreamPlan {
  index: number,
  // per packet number: seconds to add to its timestamps
  offsets: number[],
  // per packet number: dropped?
  drop: boolean[],
  dropped: number,
}

export interface StreamFixPlan {
  format: StreamFixFormat,
  m2ts: boolean,
  streams: StreamFixStreamPlan[],
  // input streams that are not copied, with the reason
  skippedStreams: { index: number, reason: string }[],
  // human readable list of what the fix does
  actions: string[],
}

export interface StreamFixResult {
  outPath: string,
  plan: StreamFixPlan,
  // human readable list of what was done
  actions: string[],
  ffmpegArgs: string[],
  // analysis of the output file
  verification: StreamFixReport,
  // problems that the output still has (empty if all is good)
  remainingProblems: string[],
  ok: boolean,
}

const defaultGapThreshold = 5;
// MPEG-TS and MPEG-PS timestamps are 33 bit, 90 kHz
const mpegWrapSeconds = 2 ** 33 / 90000;
// how far outside a master segment's time range a packet of another stream may be (e.g. audio starting before the video)
const segmentMargin = 10;
// never drop more than this (seconds) of video after damage while waiting for a keyframe
// (some H.264 broadcasts mark only rare IDR frames as keyframes)
const maxDamageDrop = 10;
// never drop more than this (seconds) of video at the start to make it start together with the audio
const maxAvTrim = 10;
// at a discontinuity, move the next segment by up to this much (seconds) to keep the audio seamless
const maxSpliceShift = 0.1;

const fmtS = (s: number) => `${s.toFixed(3)} s`;
const fmtMs = (s: number) => `${Math.round(s * 1000)} ms`;

function parseRational(value: string | undefined) {
  if (value == null) return undefined;
  const [num, den] = value.split('/').map(Number);
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return undefined;
  return num / den;
}

function parseNum(value: string | undefined) {
  if (value == null || value === 'N/A' || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Decoder messages that are not about damaged data
const harmlessDecodeMessages = [/^Last message repeated/, /mmco: unref short failure/];

export function getDecodeErrors(stderr: string) {
  return stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !harmlessDecodeMessages.some((re) => re.test(line)));
}

// ffprobe "compact" output with keys: one line per section, `section|key=value|key=value`
function parseCompactLine(line: string) {
  const fields = new Map<string, string>();
  for (const part of line.split('|')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return fields;
}

export function parseStreamFixPackets(compactOutput: string) {
  const byStream = new Map<number, StreamFixPacket[]>();
  // Packets that the demuxer split out of a bigger one (e.g. several audio frames in one PES packet) have no position.
  // Use the position of the last packet that had one: close enough to tell which part of the file a packet comes from.
  const lastPos = new Map<number, number>();
  const add = (f: Map<string, string>, streamIndex: number) => {
    let list = byStream.get(streamIndex);
    if (list == null) {
      list = [];
      byStream.set(streamIndex, list);
    }
    const flags = f.get('flags') ?? '';
    const pos = parseNum(f.get('pos')) ?? lastPos.get(streamIndex);
    if (pos != null) lastPos.set(streamIndex, pos);
    list.push({
      n: list.length,
      pts: parseNum(f.get('pts')),
      dts: parseNum(f.get('dts')),
      duration: parseNum(f.get('duration')) ?? 0,
      keyframe: flags[0] === 'K',
      corrupt: flags.includes('C'),
      pos,
    });
  };
  for (const line of compactOutput.split(/\r?\n/)) {
    if (line.startsWith('packet')) {
      const f = parseCompactLine(line);
      const streamIndex = parseNum(f.get('stream_index'));
      if (streamIndex != null) add(f, streamIndex);
    }
  }
  return byStream;
}

// Input options used for both probing and fixing, so that ffprobe and ffmpeg see the same packets.
// +genpts fills in missing presentation timestamps where they can be derived.
const inputArgs = ['-fflags', '+genpts'];

interface RawStream {
  index: number,
  codec_type?: string,
  codec_name?: string,
  time_base?: string,
  avg_frame_rate?: string,
  r_frame_rate?: string,
  sample_rate?: string,
  channels?: number,
  tags?: { language?: string },
  disposition?: { attached_pic?: number },
}

// Decode-order timestamp of a packet in ticks (dts, or pts if there is no dts)
const tsOf = (p: StreamFixPacket) => p.dts ?? p.pts;

function typicalDuration(packets: StreamFixPacket[]) {
  const durations = packets.slice(0, 500).map((p) => p.duration).filter((d) => d > 0).sort((a, b) => a - b);
  return durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : undefined;
}

interface Segment {
  // packet numbers (inclusive) of the master stream
  first: number,
  last: number,
  // seconds, file's own timestamps
  firstTs: number,
  lastTs: number,
  // seconds, the range of presentation times (including the last packet's duration)
  minTime: number,
  maxTime: number,
  posStart: number | undefined,
  posEnd: number | undefined,
  // seconds: the normal step from one packet to the next (one frame)
  step: number,
}

interface StreamScan {
  problems: TimestampProblem[],
  // packets that repeat or go slightly back in time: dropped by the fix
  duplicates: Set<number>,
  // packets that follow a gap (lost data)
  afterGap: Set<number>,
  segments: Segment[],
}

// Walk a stream's packets in file order and classify each timestamp step. Times in the problems are seconds.
function scanStream(packets: StreamFixPacket[], info: StreamFixStreamInfo, gapThreshold: number): StreamScan {
  const tb = info.timeBase;
  const problems: TimestampProblem[] = [];
  const duplicates = new Set<number>();
  const afterGap = new Set<number>();
  const segments: Segment[] = [];
  const nominal = info.frameDuration;
  const isVideo = info.codecType === 'video';
  // Containers like Matroska store no decode timestamps, and the demuxer can only guess them after the first few packets.
  // Packets without one are skipped here rather than using their presentation time, which isn't in decode order.
  const hasDts = packets.some((p) => p.dts != null);
  const step = nominal ?? (typicalDuration(packets) ?? 0) * tb;

  let seg: Segment | undefined;
  let prev: StreamFixPacket | undefined;
  const visit = (p: StreamFixPacket) => {
    const ts = hasDts ? p.dts : p.pts;
    if (ts == null) return;
    const t = ts * tb;
    const ptsT = (p.pts ?? ts) * tb;
    const dur = p.duration > 0 ? p.duration * tb : (nominal ?? 0);
    if (prev == null || seg == null) {
      seg = { first: p.n, last: p.n, firstTs: t, lastTs: t, minTime: Math.min(t, ptsT), maxTime: ptsT + dur, posStart: p.pos, posEnd: p.pos, step };
      segments.push(seg);
      prev = p;
      return;
    }
    const prevT = (hasDts ? prev.dts! : prev.pts!) * tb;
    const expected = prev.duration > 0 ? prev.duration * tb : (nominal ?? 0);
    const delta = t - prevT;
    // tolerance for timestamp jitter
    const tol = expected > 0 ? expected / 2 : 0.001;
    const problem = (kind: TimestampProblemKind): TimestampProblem => ({ kind, streamIndex: info.index, packet: p.n, from: prevT, to: t, size: delta - expected, at: 0 });

    if (delta <= -tol || delta > gapThreshold) {
      problems.push(problem(delta < 0 && delta > -1 ? 'backwards' : 'jump'));
      seg = { first: p.n, last: p.n, firstTs: t, lastTs: t, minTime: Math.min(t, ptsT), maxTime: ptsT + dur, posStart: p.pos, posEnd: p.pos, step };
      segments.push(seg);
      prev = p;
      return;
    }
    if (delta < tol && expected > 0) {
      // same (or almost the same) timestamp as the previous packet: a repeated packet
      problems.push(problem('backwards'));
      duplicates.add(p.n);
      return;
    }
    // Right after a video keyframe, a step of a few frames is normal when the keyframe's leading pictures (open GOP) were removed,
    // e.g. by an earlier fix or cut: the next picture is still presented right after the keyframe.
    const afterKeyframe = isVideo && prev.keyframe && p.pts != null && prev.pts != null && (p.pts - prev.pts) * tb <= expected * 4.5;
    if (expected > 0 && delta > expected * 1.5 + 0.0005 && !afterKeyframe) {
      problems.push(problem('gap'));
      // with guessed decode timestamps, a gap in the presentation timestamps shows up somewhere after it in decode order,
      // so it can't be tied to a packet
      if (info.dtsStored || !isVideo) afterGap.add(p.n);
    }
    seg.last = p.n;
    seg.lastTs = t;
    seg.minTime = Math.min(seg.minTime, t, ptsT);
    seg.maxTime = Math.max(seg.maxTime, ptsT + dur);
    if (p.pos != null) seg.posEnd = p.pos;
    if (seg.posStart == null) seg.posStart = p.pos;
    prev = p;
  };
  for (const p of packets) visit(p);
  return { problems, duplicates, afterGap, segments };
}

// Seconds to add to each master segment so that each one follows the previous one by one frame duration,
// starting from 0 for the first segment.
function getSegmentOffsets(segments: Segment[]) {
  const offsets: number[] = [0];
  for (let i = 1; i < segments.length; i += 1) {
    const prevSeg = segments[i - 1]!;
    // where the previous segment ends in the output (its last packet in decode order plus one frame)
    const expected = prevSeg.lastTs + offsets[i - 1]! + prevSeg.step;
    offsets.push(expected - segments[i]!.firstTs);
  }
  return offsets;
}

// Which master segment a packet of another stream belongs to. Undefined if none fits (a stray packet).
// - Only segments whose time range (with a generous margin, e.g. for audio that starts before the video) contains the packet's timestamp.
// - Of those, prefer the ones whose time range really contains it (within 1 s): with a jump the segments' ranges usually don't overlap,
//   and the streams are interleaved loosely, so the file position alone can be misleading right at a splice.
// - If that still leaves several (the timestamps jumped back into an earlier range), the one closest in the file.
function findSegment(segments: Segment[], time: number, pos: number | undefined) {
  const timeDist = (seg: Segment) => Math.max(seg.minTime - time, time - seg.maxTime, 0);
  const candidates = segments.flatMap((seg, i) => (timeDist(seg) <= segmentMargin ? [i] : []));
  const tight = candidates.filter((i) => timeDist(segments[i]!) <= 1);
  const pool = tight.length > 0 ? tight : candidates;
  if (pool.length <= 1) return pool[0];

  let best: number | undefined;
  let bestDist = Infinity;
  for (const i of pool) {
    const seg = segments[i]!;
    let dist = 0;
    if (pos != null && seg.posStart != null && seg.posEnd != null) {
      if (pos < seg.posStart) dist = seg.posStart - pos;
      else if (pos > seg.posEnd) dist = pos - seg.posEnd;
    }
    // equal (e.g. no position): the closer one in time
    dist += timeDist(seg) * 1e-6;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// The corrupt flag is set on the packet that was being assembled when the demuxer noticed the damage. With a parser that splits
// frames (MPEG video, H.264, audio) that is often the packet before the damaged one, so the next packet counts as corrupt too.
function getCorruptSet(packets: StreamFixPacket[], ignored = new Set<number>()) {
  const set = new Set<number>();
  for (const p of packets) {
    if (p.corrupt && !ignored.has(p.n)) {
      set.add(p.n);
      if (p.n + 1 < packets.length) set.add(p.n + 1);
    }
  }
  return set;
}

interface MasterAnalysis {
  scan: StreamScan,
  // per segment: seconds to add
  segmentOffsets: number[],
  // video packets that can't be decoded cleanly, and why
  damaged: Set<number>,
  startUndecodable: Set<number>,
  ignoredCorrupt: Set<number>,
}

// Find the video packets that won't decode cleanly. `dropDamaged` false: only the corrupt packets themselves.
function analyzeMaster(packets: StreamFixPacket[], info: StreamFixStreamInfo, gapThreshold: number, dropDamaged: boolean): MasterAnalysis {
  const scan = scanStream(packets, info, gapThreshold);
  const tb = info.timeBase;
  const segmentOffsets = getSegmentOffsets(scan.segments);

  // A corrupt flag right before a discontinuity is usually caused by the splice itself (the continuity counters don't match),
  // not by damaged data, so it is ignored there.
  const ignoredCorrupt = new Set<number>();
  for (const seg of scan.segments.slice(0, -1)) {
    for (let n = seg.last - 2; n <= seg.last; n += 1) if (packets[n]?.corrupt) ignoredCorrupt.add(n);
  }

  const corrupt = getCorruptSet(packets, ignoredCorrupt);

  const damaged = new Set<number>();
  const startUndecodable = new Set<number>();
  const isVideo = info.codecType === 'video';
  const segmentStarts = new Set(scan.segments.slice(1).map((s) => s.first));

  if (!isVideo) {
    // audio master: every packet decodes on its own
    for (const n of corrupt) damaged.add(n);
    return { scan, segmentOffsets, damaged, startUndecodable, ignoredCorrupt };
  }

  // State machine over the packets in decode (file) order.
  // 'start': at the start of the file or of a segment, until the first keyframe. 'damaged': after damage, until the next keyframe.
  let mode: 'ok' | 'start' | 'damaged' = 'start';
  let since = 0; // seconds, when the current damage started
  // the keyframe that ended a 'start' or 'damaged' state (or follows lost data): its leading pictures (open GOP) reference
  // the frames before it, so they are dropped too (into `leadingSet`)
  let leadingOf: StreamFixPacket | undefined;
  let leadingSet: Set<number> = startUndecodable;
  const visit = (p: StreamFixPacket) => {
    const ts = tsOf(p);
    const t = ts != null ? ts * tb : undefined;
    if (segmentStarts.has(p.n)) {
      // a new segment after a discontinuity: like the start of a file, it must start on a keyframe
      mode = 'start';
      leadingOf = undefined;
    }
    const isCorrupt = corrupt.has(p.n);
    const isDamage = isCorrupt || (dropDamaged && scan.afterGap.has(p.n) && !p.keyframe);

    if (mode === 'ok' && isDamage) {
      if (!dropDamaged) {
        damaged.add(p.n);
        return;
      }
      mode = 'damaged';
      since = t ?? since;
      leadingOf = undefined;
    }

    if (mode !== 'ok') {
      const giveUp = mode === 'damaged' && t != null && t - since > maxDamageDrop;
      if ((p.keyframe && !isCorrupt) || giveUp) {
        leadingSet = mode === 'start' ? startUndecodable : damaged;
        mode = 'ok';
        leadingOf = giveUp ? undefined : p;
      } else {
        (mode === 'start' ? startUndecodable : damaged).add(p.n);
      }
      return;
    }

    if (leadingOf != null) {
      if (p.keyframe) {
        leadingOf = undefined;
      } else if (p.pts != null && leadingOf.pts != null && p.pts < leadingOf.pts) {
        leadingSet.add(p.n);
        return;
      }
    }

    // a keyframe right after lost data: its leading pictures reference the lost data
    if (dropDamaged && p.keyframe && scan.afterGap.has(p.n)) {
      leadingOf = p;
      leadingSet = damaged;
    }
  };
  for (const p of packets) visit(p);
  return { scan, segmentOffsets, damaged, startUndecodable, ignoredCorrupt };
}

// Position (seconds into the content) of a master packet number
function contentPosition(segments: Segment[], segmentOffsets: number[], time: number, segIndex: number) {
  const first = segments[0]?.firstTs ?? 0;
  return time + (segmentOffsets[segIndex] ?? 0) - first;
}

async function probeInfo(runner: FfRunner, path: string) {
  const stdout = await runner.ffprobe(['-v', 'error', ...inputArgs, '-show_entries', 'format=format_name,start_time,duration:stream=index,codec_type,codec_name,time_base,avg_frame_rate,r_frame_rate,sample_rate,channels:stream_tags=language:stream_disposition=attached_pic', '-of', 'json', path]);
  const { format, streams = [] } = JSON.parse(stdout) as { format?: { format_name?: string, start_time?: string, duration?: string }, streams?: RawStream[] };
  return { format, streams };
}

// Analyze a recording: timestamp problems, corrupt data, undecodable frames and the A/V start offset.
export async function analyzeStream({ runner, path, onProgress, options = {} }: {
  runner: FfRunner,
  path: string,
  onProgress?: (stage: string, fraction: number) => void,
  options?: StreamFixAnalyzeOptions,
}): Promise<StreamFixReport> {
  const gapThreshold = options.gapThreshold ?? defaultGapThreshold;
  onProgress?.('Reading stream info', 0);
  const { format, streams: rawStreams } = await probeInfo(runner, path);
  const container = format?.format_name ?? 'unknown';

  onProgress?.('Reading packets', 0.05);
  // One pass over the file without decoding. "compact" output with keys is much smaller than JSON.
  const packetsOut = await runner.ffprobe(['-v', 'error', ...inputArgs, '-show_entries', 'packet=stream_index,pts,dts,duration,pos,flags', '-of', 'compact', path]);
  const packets = parseStreamFixPackets(packetsOut);
  onProgress?.('Analyzing timestamps', options.decodeCheck ? 0.4 : 0.8);

  const streams: StreamFixStreamInfo[] = rawStreams.map((s) => {
    const list = packets.get(s.index) ?? [];
    const timeBase = parseRational(s.time_base) ?? 1 / 90000;
    const fps = parseRational(s.avg_frame_rate) ?? parseRational(s.r_frame_rate);
    const typical = typicalDuration(list);
    const firstTs = list.map((p) => p.pts ?? p.dts).find((v) => v != null);
    return {
      index: s.index,
      codecType: s.codec_type ?? 'unknown',
      codecName: s.codec_name,
      timeBase,
      frameDuration: s.codec_type === 'video' && fps != null && fps < 1000 ? 1 / fps : (typical != null ? typical * timeBase : undefined),
      sampleRate: parseNum(s.sample_rate),
      channels: s.channels,
      language: s.tags?.language,
      attachedPic: s.disposition?.attached_pic === 1,
      dtsStored: !/matroska|webm/.test(container),
      packetCount: list.length,
      firstTime: firstTs != null ? firstTs * timeBase : undefined,
    };
  });

  const video = streams.find((s) => s.codecType === 'video' && !s.attachedPic && s.packetCount > 0);
  const audios = streams.filter((s) => s.codecType === 'audio' && s.packetCount > 0);
  const master = video ?? audios[0];

  const problems: string[] = [];
  const notes: string[] = [];
  const timestampProblems: TimestampProblem[] = [];
  let damagedFrames = 0;
  let undecodableStartFrames = 0;
  let contentDuration: number | undefined;
  let masterAnalysis: MasterAnalysis | undefined;

  if (master != null) {
    const list = packets.get(master.index)!;
    masterAnalysis = analyzeMaster(list, master, gapThreshold, true);
    const { scan, segmentOffsets } = masterAnalysis;
    // position of each problem in the content
    for (const prob of scan.problems) {
      const segIndex = scan.segments.findLastIndex((s) => s.first <= prob.packet);
      timestampProblems.push({ ...prob, at: contentPosition(scan.segments, segmentOffsets, prob.to, Math.max(segIndex, 0)) });
    }
    damagedFrames = masterAnalysis.damaged.size;
    undecodableStartFrames = masterAnalysis.startUndecodable.size;
    const lastSeg = scan.segments.at(-1);
    if (lastSeg != null) contentDuration = contentPosition(scan.segments, segmentOffsets, lastSeg.maxTime, scan.segments.length - 1);

    // the other audio/video streams: only report their problems (their timestamps follow the master's when fixed)
    const otherStreams = [...streams.filter((st) => st.codecType === 'video' && !st.attachedPic), ...audios].filter((s) => s.index !== master.index && s.packetCount > 0);
    for (const s of otherStreams) {
      const other = scanStream(packets.get(s.index)!, s, gapThreshold);
      for (const prob of other.problems) {
        const time = prob.to;
        const segIndex = findSegment(scan.segments, time, undefined);
        timestampProblems.push({ ...prob, at: segIndex != null ? contentPosition(scan.segments, segmentOffsets, time, segIndex) : Number.NaN });
      }
    }
  }

  // 33-bit wraparound. libavformat unwraps the timestamps relative to the start of the file, so a recording that crosses the wrap
  // has negative timestamps at the start (or ones beyond the wrap point).
  if (container.includes('mpegts') || container.includes('mpeg')) {
    const wrapped = streams.flatMap((s) => {
      const list = packets.get(s.index) ?? [];
      const times = list.map((p) => tsOf(p)).filter((v): v is number => v != null).map((v) => v * s.timeBase);
      if (times.length === 0) return [];
      const min = Math.min(...times.slice(0, 50));
      const max = Math.max(...times.slice(-50));
      if (min >= -0.5 && max <= mpegWrapSeconds) return [];
      // the first packet after the wrap point
      const wrapAt = list.find((p) => {
        const t = (tsOf(p) ?? Number.NaN) * s.timeBase;
        return min < 0 ? t >= 0 : t > mpegWrapSeconds;
      });
      return [{ kind: 'wrap' as const, streamIndex: s.index, packet: wrapAt?.n ?? 0, from: min, to: max, size: mpegWrapSeconds, at: 0 }];
    });
    if (wrapped[0] != null) timestampProblems.push(wrapped[0]);
  }

  const corruptPackets = [...packets.values()].reduce((acc, list) => acc + list.filter((p) => p.corrupt).length, 0);
  const missingTimestamps = [...packets.values()].reduce((acc, list) => acc + list.filter((p) => tsOf(p) == null).length, 0);

  // A/V start offset: first audio vs first video presentation time, in the first segment
  let avOffset: number | undefined;
  if (video != null && audios.length > 0) {
    const firstAudio = Math.min(...audios.map((a) => a.firstTime ?? Infinity));
    const vList = packets.get(video.index)!;
    const firstSeg = masterAnalysis?.scan.segments[0];
    const vTimes = vList.slice(0, firstSeg != null ? Math.min(firstSeg.last + 1, 200) : 200).map((p) => p.pts).filter((v): v is number => v != null);
    if (vTimes.length > 0 && Number.isFinite(firstAudio)) avOffset = firstAudio - Math.min(...vTimes) * video.timeBase;
  }

  let decodeErrors: number | undefined;
  let decodeErrorSamples: string[] = [];
  if (options.decodeCheck) {
    onProgress?.('Decoding', 0.5);
    const maps = [...(video != null ? ['-map', `0:${video.index}`] : []), ...audios.flatMap((a) => ['-map', `0:${a.index}`])];
    const { stderr } = await runner.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', ...inputArgs, '-i', path, ...maps, '-f', 'null', '-']);
    const errors = getDecodeErrors(stderr);
    decodeErrors = errors.length;
    decodeErrorSamples = errors.slice(0, 5);
  }

  // human readable summary
  const byKind = (kind: TimestampProblemKind) => timestampProblems.filter((p) => p.kind === kind);
  const describeAt = (p: TimestampProblem) => (Number.isFinite(p.at) ? `at ${fmtS(p.at)}` : '');
  // A discontinuity normally shows up in every stream. List it once (for the master stream), plus jumps in other streams
  // that the master stream doesn't have.
  const masterJumps = byKind('jump').filter((p) => p.streamIndex === master?.index);
  const jumps = [...masterJumps, ...byKind('jump').filter((p) => p.streamIndex !== master?.index && !masterJumps.some((m) => Math.abs(m.size - p.size) < 1))];
  if (jumps.length > 0) {
    const sample = jumps.slice(0, 3).map((p) => `${describeAt(p)} (stream ${p.streamIndex}, ${p.size >= 0 ? '+' : ''}${p.size.toFixed(3)} s)`).join(', ');
    problems.push(`${jumps.length} timestamp discontinuit${jumps.length === 1 ? 'y' : 'ies'}: ${sample}${jumps.length > 3 ? ', ...' : ''}`);
  }
  const backwards = byKind('backwards');
  if (backwards.length > 0) problems.push(`${backwards.length} packet(s) with timestamps going backwards or repeated, first ${describeAt(backwards[0]!)} (stream ${backwards[0]!.streamIndex})`);
  const wraps = byKind('wrap');
  if (wraps.length > 0) problems.push('Timestamps wrap around the 33-bit MPEG limit (26.5 hours)');
  if (corruptPackets > 0) problems.push(`${corruptPackets} packet(s) flagged as corrupt`);
  if (damagedFrames > 0) problems.push(`${damagedFrames} video frame(s) can't be decoded cleanly because of corrupt or missing data`);
  if (undecodableStartFrames > 0) problems.push(`${undecodableStartFrames} video frame(s) at the start or after a discontinuity can't be decoded (no keyframe before them)`);
  if (missingTimestamps > 0) problems.push(`${missingTimestamps} packet(s) without timestamps`);
  if (avOffset != null && Math.abs(avOffset) > 0.1) problems.push(`Audio starts ${fmtMs(Math.abs(avOffset))} ${avOffset > 0 ? 'after' : 'before'} the video`);
  if (decodeErrors != null && decodeErrors > 0) problems.push(`${decodeErrors} decoding error(s), e.g. "${decodeErrorSamples[0]}"`);

  const gaps = byKind('gap');
  if (gaps.length > 0) notes.push(`${gaps.length} gap(s) in the timestamps (lost data, kept as they are), first ${describeAt(gaps[0]!)} (stream ${gaps[0]!.streamIndex}, ${gaps[0]!.size.toFixed(3)} s)`);
  if (masterAnalysis != null && masterAnalysis.ignoredCorrupt.size > 0) notes.push(`${masterAnalysis.ignoredCorrupt.size} corrupt flag(s) right before a discontinuity (caused by the splice)`);
  const duration = parseNum(format?.duration);
  if (duration != null && contentDuration != null && jumps.length > 0) notes.push(`Container duration ${fmtS(duration)}, content ${fmtS(contentDuration)}`);

  // a corrupt flag caused by a splice is not a reason to fix by itself, the discontinuity is
  const ignored = masterAnalysis?.ignoredCorrupt.size ?? 0;
  const needsFix = jumps.length > 0 || backwards.length > 0 || wraps.length > 0 || corruptPackets - ignored > 0 || damagedFrames > 0
    || undecodableStartFrames > 0 || missingTimestamps > 0 || (avOffset != null && Math.abs(avOffset) > 0.1) || (decodeErrors ?? 0) > 0;

  onProgress?.('Done', 1);
  return {
    path,
    container,
    duration,
    startTime: parseNum(format?.start_time),
    contentDuration,
    streams,
    masterStreamIndex: master?.index,
    timestampProblems,
    corruptPackets,
    damagedFrames,
    undecodableStartFrames,
    missingTimestamps,
    avOffset,
    decodeErrors,
    decodeErrorSamples,
    needsFix,
    problems,
    notes,
    packets,
  };
}

const subtitleCodecs: Record<StreamFixFormat, Set<string>> = {
  mpegts: new Set(['dvb_subtitle', 'dvb_teletext', 'hdmv_pgs_subtitle', 'arib_caption']),
  matroska: new Set(['dvb_subtitle', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'subrip', 'ass']),
  mp4: new Set(['mov_text']),
  mpeg: new Set(['dvd_subtitle']),
};

export function getDefaultFormat(container: string): StreamFixFormat {
  // the MPEG-PS demuxer is called "mpeg", MPEG-TS "mpegts"
  if (container.split(',').includes('mpeg')) return 'mpeg';
  return 'mpegts';
}

function isM2tsPath(path: string) {
  return /\.(m2ts|mts)$/i.test(path);
}

// Decide what to do with every packet. Pure function of the analysis.
export function planStreamFix(report: StreamFixReport, options: StreamFixOptions = {}, outPath = ''): StreamFixPlan {
  const gapThreshold = options.gapThreshold ?? defaultGapThreshold;
  const format = options.format ?? getDefaultFormat(report.container);
  const fixAvOffset = options.fixAvOffset ?? true;
  const dropDamaged = options.dropDamaged ?? true;
  const tracks = options.tracks ?? 'all';
  const actions: string[] = [];
  const skippedStreams: { index: number, reason: string }[] = [];

  const master = report.streams.find((s) => s.index === report.masterStreamIndex);
  if (master == null) throw new Error('No video or audio stream to fix');

  // which streams to copy
  const selected = report.streams.filter((s) => {
    const skip = (reason: string) => {
      skippedStreams.push({ index: s.index, reason });
      return false;
    };
    if (s.packetCount === 0) return skip('no data');
    if (s.index === master.index) return true;
    if (s.codecType === 'audio') return true;
    if (tracks === 'main') return skip('not a main track');
    if (s.codecType === 'video') return s.attachedPic && format !== 'matroska' && format !== 'mp4' ? skip('cover art') : true;
    if (s.codecType === 'subtitle') return subtitleCodecs[format].has(s.codecName ?? '') ? true : skip(`${s.codecName ?? 'unknown'} subtitles not supported in ${format}`);
    return skip(`${s.codecType} stream`);
  });

  const masterPackets = report.packets.get(master.index) ?? [];
  const ma = analyzeMaster(masterPackets, master, gapThreshold, dropDamaged);
  const { segments } = ma.scan;

  // The other streams follow the master segment they belong to. Find it for each packet, and the packets to drop anyway.
  const others = selected.filter((s) => s.index !== master.index).map((s) => {
    const list = report.packets.get(s.index) ?? [];
    const corrupt = s.codecType === 'audio' || s.codecType === 'video' ? getCorruptSet(list) : new Set<number>();
    // After lost data, the first audio packet can contain the remains of a broken frame that the parser glued to it
    // (e.g. a 720 byte MP2 "frame" in a 576 byte stream), which the decoder rejects. Dropping it costs only one audio frame.
    if (s.codecType === 'audio') for (const n of scanStream(list, s, gapThreshold).afterGap) corrupt.add(n);
    const segOf = list.map((p) => {
      const ts = tsOf(p);
      return ts != null ? findSegment(segments, ts * s.timeBase, p.pos) : undefined;
    });
    return { s, list, corrupt, segOf };
  });

  // At a discontinuity, the audio of the previous segment usually doesn't end exactly one video frame duration before the next
  // segment's audio starts: with the video joined seamlessly, the audio would overlap (or have a gap). If it would overlap by a little,
  // move the next segment a little further instead, so that all audio is kept and stays seamless; the video then shows its last
  // frame a bit longer, which is invisible. Larger overlaps are resolved by dropping audio packets below.
  const audioOthers = others.filter((o) => o.s.codecType === 'audio');
  const audioRanges = audioOthers.map(({ s, list, corrupt, segOf }) => {
    const ranges = segments.map(() => ({ start: Infinity, end: -Infinity }));
    for (const p of list) {
      const seg = segOf[p.n];
      if (seg != null && !corrupt.has(p.n)) {
        const start = (p.pts ?? tsOf(p)!) * s.timeBase;
        const r = ranges[seg]!;
        r.start = Math.min(r.start, start);
        r.end = Math.max(r.end, start + (p.duration > 0 ? p.duration * s.timeBase : (s.frameDuration ?? 0)));
      }
    }
    return ranges;
  });
  const segmentOffsets = [...ma.segmentOffsets];
  let extraTotal = 0;
  for (let k = 1; k < segments.length; k += 1) {
    segmentOffsets[k] = segmentOffsets[k]! + extraTotal;
    const overlap = Math.max(0, ...audioRanges.map((ranges) => {
      const prev = ranges[k - 1]!;
      const next = ranges[k]!;
      return Number.isFinite(prev.end) && Number.isFinite(next.start) ? (prev.end + segmentOffsets[k - 1]!) - (next.start + segmentOffsets[k]!) : 0;
    }));
    if (overlap > 0 && overlap <= maxSpliceShift) {
      segmentOffsets[k] = segmentOffsets[k]! + overlap;
      extraTotal += overlap;
    }
  }

  // seconds to add, per packet, before the final shift to zero
  const plans = new Map<number, StreamFixStreamPlan>();
  {
    const offsets: number[] = [];
    const drop: boolean[] = [];
    let seg = 0;
    for (const p of masterPackets) {
      while (seg + 1 < segments.length && segments[seg + 1]!.first <= p.n) seg += 1;
      offsets.push(segmentOffsets[seg] ?? 0);
      drop.push(tsOf(p) == null || ma.scan.duplicates.has(p.n) || ma.damaged.has(p.n) || ma.startUndecodable.has(p.n));
    }
    plans.set(master.index, { index: master.index, offsets, drop, dropped: 0 });
  }

  if (segments.length > 1) actions.push(`Removed ${segments.length - 1} timestamp discontinuit${segments.length === 2 ? 'y' : 'ies'}, rebuilding the timeline of stream ${master.index} from its frame order and frame rate and moving the other streams with it`);
  if (ma.scan.duplicates.size > 0) actions.push(`Dropped ${ma.scan.duplicates.size} repeated packet(s) of stream ${master.index}`);
  if (ma.damaged.size > 0) actions.push(`Dropped ${ma.damaged.size} damaged video frame(s) (corrupt, or after corrupt or missing data until the next keyframe)`);
  if (ma.startUndecodable.size > 0) actions.push(`Dropped ${ma.startUndecodable.size} undecodable video frame(s) at the start${segments.length > 1 ? ' and after discontinuities' : ''}`);

  for (const { s, list, corrupt, segOf } of others) {
    const offsets: number[] = [];
    const drop: boolean[] = [];
    let stray = 0;
    let overlaps = 0;
    // the last kept audio packets: seconds after offset, and which segment they belong to
    const kept: { n: number, end: number, seg: number }[] = [];
    const isAudio = s.codecType === 'audio';
    // returns whether to drop the packet
    const visit = (p: StreamFixPacket) => {
      const ts = tsOf(p);
      const seg = segOf[p.n];
      if (ts == null || seg == null) {
        if (ts != null) stray += 1;
        return true;
      }
      if (corrupt.has(p.n)) return true;
      if (!isAudio) return false;
      // After moving, an audio packet must not start before the previous one ends (that happens at a splice):
      // a player would play it late, and everything after it would be out of sync.
      const start = (p.pts ?? ts) * s.timeBase + offsets[p.n]!;
      const dur = p.duration > 0 ? p.duration * s.timeBase : (s.frameDuration ?? 0);
      const tol = Math.min(0.002, dur / 4);
      const last = kept.at(-1);
      if (last != null && start < last.end - tol) {
        if (last.seg === seg) {
          overlaps += 1;
          return true;
        }
        // At a discontinuity, keep the start of the new segment complete and drop the end of the previous one instead
        while (kept.length > 0 && kept.at(-1)!.seg !== seg && start < kept.at(-1)!.end - tol) {
          drop[kept.pop()!.n] = true;
          overlaps += 1;
        }
      }
      kept.push({ n: p.n, end: start + dur, seg });
      if (kept.length > 50) kept.shift();
      return false;
    };
    for (const p of list) {
      const seg = segOf[p.n];
      offsets.push(seg != null ? segmentOffsets[seg]! : 0);
      drop.push(visit(p));
    }
    plans.set(s.index, { index: s.index, offsets, drop, dropped: 0 });
    if (stray > 0) actions.push(`Dropped ${stray} packet(s) of stream ${s.index} with timestamps that don't fit the video`);
    if (corrupt.size > 0) actions.push(`Dropped ${corrupt.size} corrupt packet(s) of stream ${s.index} (or right after lost data)`);
    if (overlaps > 0) actions.push(`Dropped ${overlaps} overlapping audio packet(s) of stream ${s.index} at discontinuities`);
  }

  const outTime = (s: StreamFixStreamInfo, plan: StreamFixStreamPlan, p: StreamFixPacket, which: 'pts' | 'dts') => {
    const v = which === 'pts' ? (p.pts ?? p.dts) : tsOf(p);
    return v == null ? undefined : v * s.timeBase + plan.offsets[p.n]!;
  };
  const streamOf = (index: number) => report.streams.find((s) => s.index === index)!;

  // Start video and audio together: start the video on the first keyframe at or after the start of the audio,
  // and drop the audio before the video starts
  const audioStreams = selected.filter((s) => s.codecType === 'audio');
  if (fixAvOffset && master.codecType === 'video' && audioStreams.length > 0) {
    const masterPlan = plans.get(master.index)!;
    const firstKept = (s: StreamFixStreamInfo) => {
      const plan = plans.get(s.index)!;
      const p = (report.packets.get(s.index) ?? []).find((pk) => !plan.drop[pk.n]);
      return p != null ? outTime(s, plan, p, 'pts') : undefined;
    };
    const audioStarts = audioStreams.map((s) => firstKept(s)).filter((v): v is number => v != null);
    const audioStart = audioStarts.length > 0 ? Math.max(...audioStarts) : undefined;
    const firstVideo = masterPackets.find((p) => !masterPlan.drop[p.n]);
    const videoStart = firstVideo != null ? outTime(master, masterPlan, firstVideo, 'pts') : undefined;
    const frame = master.frameDuration ?? 0.04;
    if (audioStart != null && videoStart != null) {
      let start = videoStart;
      let trimmedVideo = 0;
      // (if the audio starts much later, it's more likely missing at the start than late, so keep the video)
      if (audioStart > videoStart + frame / 2 && audioStart - videoStart <= maxAvTrim) {
        // drop video until a keyframe at or after the audio start
        const key = masterPackets.find((p) => !masterPlan.drop[p.n] && p.keyframe && (outTime(master, masterPlan, p, 'pts') ?? -Infinity) >= audioStart - frame / 2);
        if (key != null) {
          start = outTime(master, masterPlan, key, 'pts')!;
          const nextKey = masterPackets.find((q) => q.n > key.n && q.keyframe);
          for (const p of masterPackets.slice(0, nextKey?.n ?? masterPackets.length)) {
            // before the keyframe in decode order, or a leading picture of it
            const leading = p.n > key.n && p.pts != null && key.pts != null && p.pts < key.pts;
            if (!masterPlan.drop[p.n] && (p.n < key.n || leading)) {
              masterPlan.drop[p.n] = true;
              trimmedVideo += 1;
            }
          }
        }
      }
      let trimmedAudio = 0;
      for (const a of audioStreams) {
        const plan = plans.get(a.index)!;
        // keep the audio packet that starts closest to the video start
        const isEarly = (p: StreamFixPacket) => outTime(a, plan, p, 'pts')! < start - (p.duration > 0 ? p.duration * a.timeBase : (a.frameDuration ?? 0)) / 2;
        const kept = (report.packets.get(a.index) ?? []).filter((p) => !plan.drop[p.n]);
        const firstOnTime = kept.findIndex((p) => !isEarly(p));
        for (const p of kept.slice(0, firstOnTime === -1 ? kept.length : firstOnTime)) {
          plan.drop[p.n] = true;
          trimmedAudio += 1;
        }
      }
      if (trimmedVideo > 0 || trimmedAudio > 0) actions.push(`Aligned the start of video and audio: dropped ${trimmedVideo} video frame(s) and ${trimmedAudio} audio packet(s) at the start`);
    }
  }

  // Shift everything so that the output starts at 0 (removes a 33-bit wraparound too)
  let base = Infinity;
  for (const [index, plan] of plans) {
    const s = streamOf(index);
    // the first packets of each stream are enough, the timestamps only grow from there
    for (const p of (report.packets.get(index) ?? []).filter((pk) => !plan.drop[pk.n]).slice(0, 500)) {
      const t = outTime(s, plan, p, 'dts');
      if (t != null) base = Math.min(base, t, outTime(s, plan, p, 'pts') ?? t);
    }
  }
  if (Number.isFinite(base)) {
    for (const plan of plans.values()) {
      for (let i = 0; i < plan.offsets.length; i += 1) plan.offsets[i] = plan.offsets[i]! - base;
    }
    if (Math.abs(base) > 0.001) actions.push(`Shifted all timestamps by ${(-base).toFixed(3)} s so the output starts at zero`);
  }

  for (const plan of plans.values()) plan.dropped = plan.drop.filter(Boolean).length;
  const streamPlans = selected.map((s) => plans.get(s.index)!);
  if (skippedStreams.length > 0) actions.push(`Left out stream(s): ${skippedStreams.map((s) => `${s.index} (${s.reason})`).join(', ')}`);
  return { format, m2ts: format === 'mpegts' && isM2tsPath(outPath), streams: streamPlans, skippedStreams, actions };
}

// Compress per-packet values into runs of [first packet number, value]
function toRuns<T>(values: T[]) {
  const runs: { from: number, value: T }[] = [];
  for (const [i, v] of values.entries()) {
    if (runs.length === 0 || runs.at(-1)!.value !== v) runs.push({ from: i, value: v });
  }
  return runs;
}

const fmtOffset = (s: number) => s.toFixed(9);

// The bitstream filter chain for one stream: shift the timestamps by packet number (setts), then drop packets by number (noise).
// Commas inside the expressions are escaped, because the chain itself is comma separated.
export function getStreamBsf(plan: StreamFixStreamPlan) {
  const filters: string[] = [];
  const offsetRuns = toRuns(plan.offsets.map((o) => fmtOffset(o)));
  if (offsetRuns.length > 0 && !(offsetRuns.length === 1 && Number(offsetRuns[0]!.value) === 0)) {
    // offset(N) = first offset + sum of the steps at each run start. A flat sum instead of nested if()s keeps the expression parser shallow.
    const steps = offsetRuns.slice(1).map((run, i) => `+gte(N\\,${run.from})*(${fmtOffset(Number(run.value) - Number(offsetRuns[i]!.value))})`);
    const expr = offsetRuns[0]!.value + steps.join('');
    // setts evaluates `pts` and `dts` separately (and only for packets that have them)
    filters.push(`setts=pts=PTS+(${expr})/TB:dts=DTS+(${expr})/TB`);
  }
  const dropRanges: [number, number][] = [];
  for (const [i, d] of plan.drop.entries()) {
    const last = dropRanges.at(-1);
    if (d && last != null && last[1] === i - 1) last[1] = i;
    else if (d) dropRanges.push([i, i]);
  }
  if (dropRanges.length > 0) {
    const expr = dropRanges.map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})`)).join('+');
    filters.push(`noise=drop=${expr}`);
  }
  return filters.join(',');
}

export function getFixArgs({ path, outPath, plan }: { path: string, outPath: string, plan: StreamFixPlan }) {
  const muxerArgs: Record<StreamFixFormat, string[]> = {
    // By default the MPEG-TS muxer packs several audio frames into one PES packet, which has only one timestamp: the demuxer then
    // places the following frames back to back, so a gap between them (from dropped packets) would be lost and the audio after it
    // would play early. One frame per PES packet (like most broadcasts) keeps every frame's timestamp.
    mpegts: ['-f', 'mpegts', '-pes_payload_size', '0', ...(plan.m2ts ? ['-mpegts_m2ts_mode', '1'] : [])],
    matroska: ['-f', 'matroska'],
    // +faststart puts the index at the front, so that the file can be played while being read/streamed
    mp4: ['-f', 'mp4', '-movflags', '+faststart'],
    mpeg: ['-f', 'mpeg'],
  };
  return [
    '-hide_banner', '-nostdin', '-y',
    // Keep the input timestamps as they are: no shift to zero, and no automatic discontinuity correction by ffmpeg (which only handles
    // jumps over 10 s, moves the streams by whichever packet comes first, and leaves overlapping audio). Our bitstream filters do it instead.
    '-copyts',
    ...inputArgs,
    '-i', path,
    ...plan.streams.flatMap((s) => ['-map', `0:${s.index}`]),
    '-c', 'copy',
    // don't drop the non-keyframes at the start by ourselves: the bitstream filters count packets, so they must see all of them
    '-copyinkf',
    ...plan.streams.flatMap((s, outIndex) => {
      const bsf = getStreamBsf(s);
      return bsf !== '' ? [`-bsf:${outIndex}`, bsf] : [];
    }),
    // TV recordings can have sparse streams (subtitles, teletext) with long gaps between packets
    '-max_muxing_queue_size', '9999',
    // our timestamps already start at zero; never let the muxer shift single streams
    '-avoid_negative_ts', 'disabled',
    '-map_metadata', '0',
    ...muxerArgs[plan.format],
    outPath,
  ];
}

// Messages from the ffmpeg run that mean the output timestamps are not right
function getMuxWarnings(stderr: string) {
  return stderr.split(/\r?\n/).filter((l) => /non monotonic|Non-monotonic|Invalid timestamps|Application provided invalid/i.test(l)).map((l) => l.trim());
}

// Run the repair: remux `path` to `outPath`, and verify the output.
export async function fixStream({ runner, path, outPath, report: reportIn, options = {}, onProgress }: {
  runner: FfRunner,
  path: string,
  outPath: string,
  // from analyzeStream() of the same file with the same options, to save reading it again
  report?: StreamFixReport,
  options?: StreamFixOptions,
  onProgress?: (stage: string, fraction: number) => void,
}): Promise<StreamFixResult> {
  const report = reportIn ?? await analyzeStream({ runner, path, options: { gapThreshold: options.gapThreshold }, onProgress: (stage, f) => onProgress?.(stage, f * 0.3) });
  onProgress?.('Planning', 0.3);
  const plan = planStreamFix(report, options, outPath);
  const ffmpegArgs = getFixArgs({ path, outPath, plan });
  // Windows command lines are limited to 32767 characters
  const argsLength = ffmpegArgs.reduce((acc, a) => acc + a.length + 3, 0);
  if (argsLength > 32000) throw new Error(`The recording has too many problems to fix in one go (${plan.streams.reduce((acc, s) => acc + s.dropped, 0)} packets to drop)`);

  onProgress?.('Remuxing', 0.35);
  const { stderr } = await runner.ffmpeg(ffmpegArgs);
  const muxWarnings = getMuxWarnings(stderr);

  onProgress?.('Verifying', 0.7);
  const verification = await analyzeStream({ runner, path: outPath, options: { gapThreshold: options.gapThreshold, decodeCheck: options.decodeCheck } });
  // with fixAvOffset off, a different start of audio and video is expected
  const remainingProblems = verification.problems.filter((p) => (options.fixAvOffset ?? true) || !p.startsWith('Audio starts'));
  if (muxWarnings.length > 0) remainingProblems.push(`Muxer: ${muxWarnings[0]}${muxWarnings.length > 1 ? ` (and ${muxWarnings.length - 1} more)` : ''}`);
  // every kept packet must have made it to the output
  for (const [outIndex, s] of plan.streams.entries()) {
    const expected = s.drop.length - s.dropped;
    const actual = verification.packets.get(outIndex)?.length ?? 0;
    // the muxer may split or merge a few packets (e.g. MPEG-PS audio), so allow a small difference
    if (Math.abs(actual - expected) > Math.max(2, expected * 0.01)) remainingProblems.push(`Stream ${s.index}: ${actual} packets in the output, expected ${expected}`);
  }

  onProgress?.('Done', 1);
  return {
    outPath,
    plan,
    actions: plan.actions.length > 0 ? plan.actions : ['Remuxed (no timestamp changes needed)'],
    ffmpegArgs,
    verification,
    remainingProblems,
    ok: remainingProblems.length === 0,
  };
}
