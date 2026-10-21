// Joining several video files into one ("smart join"), even when their codec parameters differ,
// while re-encoding as little as possible:
// - inputs that match the target format are copied losslessly,
// - inputs that match but need a frame accurate start/end (cut range, open GOP or mid-GOP start) are smart rendered
//   (only the frames around the cut points are re-encoded, see smartRender.ts),
// - incompatible inputs are re-encoded to the target format (scaled/padded, frame rate converted).
// Audio is copied when all inputs' audio matches the target, otherwise only the mismatching inputs' audio is re-encoded.
//
// Every input becomes one intermediate file (video + audio) whose audio is trimmed to the input's video, and the
// intermediates are joined with the concat demuxer. Audio is placed by timestamp relative to its own video, so A/V
// offsets don't accumulate across joins.
//
// Like smartRender.ts this module has no runtime imports, so it can be driven by a plain Node.js script (see test-manual/smartJoin).

import {
  getConcatList, getCopyPartArgs, getDecodeErrors, getEncodePartArgs, getEncoderArgs, getIntermediateFormat, mergePackets, parseFrameRate,
  parsePackets, planSmartRender, readPacketsForPlan, smartRenderVideo,
  type FfRunner, type SmartRenderPlan, type SmartRenderStream,
} from './smartRender.ts';

export interface JoinRunner extends FfRunner {
  writeFile: (path: string, content: string) => Promise<void>,
  // must not fail if the file doesn't exist
  removeFile: (path: string) => Promise<void>,
}

// The subset of ffprobe's stream info used here
export interface JoinProbeStream extends SmartRenderStream {
  codec_type?: string | undefined,
  width?: number | undefined,
  height?: number | undefined,
  sample_aspect_ratio?: string | undefined,
  time_base?: string | undefined,
  sample_rate?: string | undefined,
  channels?: number | undefined,
  channel_layout?: string | undefined,
  disposition?: { attached_pic?: number | undefined } | undefined,
}

export interface JoinInputSpec {
  path: string,
  // optional range to keep, in seconds relative to the file's start (like ffmpeg -ss / the app's timeline)
  cutFrom?: number | undefined,
  cutTo?: number | undefined,
}

export interface JoinInputInfo {
  path: string,
  // format start time (seconds, in the file's own timestamps)
  startTime: number,
  duration: number | undefined,
  bitrate: number | undefined,
  video: JoinProbeStream | undefined,
  audio: JoinProbeStream | undefined,
  streamCounts: { video: number, audio: number, subtitle: number, other: number },
  // pts (file's own timestamps) of the first keyframe in decode order
  firstKeyframePts: number | undefined,
  // why the file can't be copied from its first packet (mid-GOP start, leading B-frames of an open GOP)
  startIssue: string | undefined,
}

export type JoinVideoAction = 'copy' | 'smart' | 'encode';
export type JoinAudioAction = 'copy' | 'encode' | 'silence' | 'none';

export interface JoinInputPlan {
  index: number,
  path: string,
  // effective range, relative to the file's start. undefined = from the first decodable frame / to the end
  cutFrom: number | undefined,
  cutTo: number | undefined,
  info: JoinInputInfo,
  action: JoinVideoAction,
  reasons: string[],
  audioAction: JoinAudioAction,
  audioReasons: string[],
  // for 'smart': the expected smart render plan (file's own timestamps), if it could be computed
  smartPlan?: SmartRenderPlan | undefined,
  // for 'smart': re-encode the first GOP even if the cut starts on a keyframe, because that keyframe doesn't reset the
  // decoder (H.264/HEVC open GOP recovery point / CRA). Joined after another input, its frames would be output in the wrong order.
  idrHead?: boolean | undefined,
}

export type FieldOrder = 'progressive' | 'tff' | 'bff';

export interface JoinTargetVideo {
  stream: JoinProbeStream,
  width: number,
  height: number,
  sar: string,
  frameRate: string,
  fps: number,
  fieldOrder: FieldOrder,
  bitrate: number | undefined,
}

export interface JoinTargetAudio {
  stream: JoinProbeStream,
  codec: string,
  sampleRate: number,
  channels: number,
  channelLayout: string,
  bitrate: number | undefined,
}

export interface JoinPlan {
  inputs: JoinInputPlan[],
  // index of the input whose parameters are the target format
  targetIndex: number,
  audioTargetIndex: number | undefined,
  target: { video: JoinTargetVideo, audio: JoinTargetAudio | undefined },
  intermediate: { format: string, ext: string },
  // human readable summary, one line per input plus notes
  summary: string[],
}

export interface JoinPartResult {
  index: number,
  path: string,
  action: JoinVideoAction,
  audioAction: JoinAudioAction,
  frames: number,
  // seconds of output video of this part, and where it starts in the output (from the output's first frame)
  duration: number,
  outStart: number,
  // number of re-encoded video frames (all of them for 'encode', head/tail for 'smart')
  encodedFrames: number,
  // where the input's first output frame is in the input (file's own timestamps)
  sourceStart: number,
  // first and end time of this part's audio relative to its first video frame (undefined if the part has no audio)
  audioStart: number | undefined,
  audioEnd: number | undefined,
}

export interface JoinResult {
  outPath: string,
  parts: JoinPartResult[],
  frames: number,
  duration: number,
  // problems found by the verification (empty if all is good, or if verification was disabled)
  problems: string[],
  // non-fatal observations (e.g. an input with timestamp gaps)
  warnings: string[],
}

const fmt = (n: number) => n.toFixed(6);
// for expressions: "+1.000000" / "-1.000000"
const signed = (n: number) => (n < 0 ? `-${fmt(-n)}` : `+${fmt(n)}`);

// Audio intermediates are written with this offset added, so that pre-roll and encoder priming never give negative timestamps
const audioBase = 10;
// tolerance when comparing audio packet times
const audioEps = 0.0005;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function parseRatio(ratio: string | undefined, sep = ':') {
  if (ratio == null) return undefined;
  const [num, den] = ratio.split(sep).map(Number);
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return undefined;
  return [num, den] as const;
}

export function normalizeSar(sar: string | undefined) {
  const r = parseRatio(sar);
  if (r == null) return '1:1';
  const g = gcd(r[0], r[1]);
  return `${r[0] / g}:${r[1] / g}`;
}

export function normalizeFieldOrder(fieldOrder: string | undefined): FieldOrder {
  if (fieldOrder === 'tt' || fieldOrder === 'tb') return 'tff';
  if (fieldOrder === 'bb' || fieldOrder === 'bt') return 'bff';
  return 'progressive';
}

// The stream's frame rate as a rational string. r_frame_rate is exact, but for interlaced video it can be the field rate.
export function getStreamFrameRate(stream: Pick<SmartRenderStream, 'avg_frame_rate' | 'r_frame_rate'>) {
  const r = parseFrameRate(stream.r_frame_rate);
  const a = parseFrameRate(stream.avg_frame_rate);
  if (r != null && (a == null || Math.abs(r - a) / a < 0.01)) return { frameRate: stream.r_frame_rate!, fps: r };
  if (a != null) return { frameRate: stream.avg_frame_rate!, fps: a };
  return undefined;
}

function defaultChannelLayout(channels: number | undefined) {
  return ({ 1: 'mono', 2: 'stereo', 3: '2.1', 4: 'quad', 5: '5.0', 6: '5.1', 8: '7.1' } as Record<number, string>)[channels ?? 2] ?? 'stereo';
}

function normalizeLayout(stream: JoinProbeStream) {
  const layout = stream.channel_layout;
  if (layout == null || layout === '' || layout === 'unknown') return defaultChannelLayout(stream.channels);
  // "5.1(side)" and "5.1" are the same for our purposes
  return layout.replace('(side)', '');
}

function parseBitrate(s: string | undefined) {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function getAudioEncoder(codec: string) {
  return ({ aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis' } as Record<string, string>)[codec] ?? codec;
}

const losslessAudio = new Set(['flac', 'alac', 'truehd']);
// audio codecs that can go into an MPEG-TS intermediate
const tsAudioCodecs = new Set(['aac', 'ac3', 'eac3', 'mp2', 'mp3', 'opus', 'dts']);

// Differences that prevent copying an input's video into the target stream (empty = compatible)
export function getVideoMismatches(target: JoinTargetVideo, s: JoinProbeStream) {
  const reasons: string[] = [];
  const t = target.stream;
  if (s.codec_name !== t.codec_name) return [`codec ${s.codec_name ?? '?'} ≠ ${t.codec_name ?? '?'}`];
  if ((s.profile ?? '') !== (t.profile ?? '')) reasons.push(`profile ${s.profile ?? '?'} ≠ ${t.profile ?? '?'}`);
  if ((s.pix_fmt ?? '') !== (t.pix_fmt ?? '')) reasons.push(`pixel format ${s.pix_fmt ?? '?'} ≠ ${t.pix_fmt ?? '?'}`);
  if (s.width !== target.width || s.height !== target.height) reasons.push(`resolution ${s.width}x${s.height} ≠ ${target.width}x${target.height}`);
  const sar = normalizeSar(s.sample_aspect_ratio);
  if (sar !== target.sar) reasons.push(`pixel aspect ${sar} ≠ ${target.sar}`);
  const rate = getStreamFrameRate(s);
  if (rate == null) reasons.push('unknown frame rate');
  else if (Math.abs(rate.fps - target.fps) / target.fps > 0.001) reasons.push(`frame rate ${rate.fps.toFixed(3)} ≠ ${target.fps.toFixed(3)} fps`);
  const fieldOrder = normalizeFieldOrder(s.field_order);
  if (fieldOrder !== target.fieldOrder) reasons.push(`field order ${fieldOrder} ≠ ${target.fieldOrder}`);
  // a different B-frame reorder delay would make the joined decode timestamps go backwards
  if ((s.has_b_frames ?? 0) !== (t.has_b_frames ?? 0)) reasons.push(`B-frame reorder delay ${s.has_b_frames ?? 0} ≠ ${t.has_b_frames ?? 0}`);
  return reasons;
}

export function getAudioMismatches(target: JoinTargetAudio, s: JoinProbeStream) {
  const reasons: string[] = [];
  if (s.codec_name !== target.codec) return [`codec ${s.codec_name ?? '?'} ≠ ${target.codec}`];
  if (s.codec_name === 'aac' && (s.profile ?? '') !== (target.stream.profile ?? '')) reasons.push(`profile ${s.profile ?? '?'} ≠ ${target.stream.profile ?? '?'}`);
  const sampleRate = parseInt(s.sample_rate ?? '', 10);
  if (sampleRate !== target.sampleRate) reasons.push(`sample rate ${sampleRate} ≠ ${target.sampleRate} Hz`);
  if (s.channels !== target.channels || normalizeLayout(s) !== target.channelLayout) reasons.push(`channels ${normalizeLayout(s)} ≠ ${target.channelLayout}`);
  return reasons;
}

function videoKey(s: JoinProbeStream) {
  return JSON.stringify([s.codec_name, s.profile, s.pix_fmt, s.width, s.height, normalizeSar(s.sample_aspect_ratio), getStreamFrameRate(s)?.fps.toFixed(3), normalizeFieldOrder(s.field_order), s.has_b_frames ?? 0]);
}

function audioKey(s: JoinProbeStream) {
  return JSON.stringify([s.codec_name, s.codec_name === 'aac' ? s.profile : undefined, s.sample_rate, s.channels, normalizeLayout(s)]);
}

// index of the first item of the largest group (ties: the group that appears first)
function pickMajority<T>(items: { index: number, value: T }[], key: (v: T) => string) {
  const groups = new Map<string, number[]>();
  for (const { index, value } of items) {
    const k = key(value);
    groups.set(k, [...(groups.get(k) ?? []), index]);
  }
  let best: number[] | undefined;
  for (const g of groups.values()) {
    if (best == null || g.length > best.length) best = g;
  }
  return best?.[0];
}

const reliableMarker = Symbol('reliableIntervals');

// ffprobe's -read_intervals with a start time (which makes it seek) sometimes returns no packets, or only the last few,
// for the same file and arguments (seen with the bundled FFmpeg 8 on Windows, roughly 1 in 10-30 runs; ffmpeg -ss is not
// affected). This wraps a runner so that packet reads with a start time are checked: if the packets don't cover the
// requested interval (allowing for the file's own start and end), the read is retried, and then done without seeking
// (reading the whole file and keeping the requested interval).
export function withReliableIntervals<T extends FfRunner>(runner: T): T {
  if ((runner as { [reliableMarker]?: boolean })[reliableMarker]) return runner;
  const ranges = new Map<string, Promise<{ start: number, end: number } | undefined>>();
  const getRange = async (path: string) => {
    let range = ranges.get(path);
    if (range == null) {
      range = runner.ffprobe(['-v', 'error', '-show_entries', 'format=start_time,duration', '-of', 'json', path]).then((stdout) => {
        const { format } = JSON.parse(stdout) as { format?: { start_time?: string, duration?: string } };
        const start = parseFloat(format?.start_time ?? '');
        const duration = parseFloat(format?.duration ?? '');
        return Number.isFinite(start) && Number.isFinite(duration) ? { start, end: start + duration } : undefined;
      }, () => undefined);
      ranges.set(path, range);
    }
    return range;
  };
  interface Packet { pts_time?: string, dts_time?: string }
  const timeOf = (pk: Packet) => {
    const t = parseFloat(pk.pts_time ?? pk.dts_time ?? '');
    return Number.isFinite(t) ? t : undefined;
  };

  const ffprobe = async (args: string[]) => {
    const i = args.indexOf('-read_intervals');
    const match = i !== -1 ? /^(-?[\d.]+)%(-?[\d.]+)?$/.exec(args[i + 1] ?? '') : null;
    const isPacketJson = args.includes('json') && args.some((a) => a.includes('packet='));
    if (match == null || !isPacketJson) return runner.ffprobe(args);
    const start = Number(match[1]);
    const end = match[2] != null ? Number(match[2]) : undefined;
    const range = await getRange(args.at(-1)!);
    // (the file's start/end in the format can differ a bit from a stream's)
    const slack = 1;
    const covers = (stdout: string) => {
      const { packets = [] } = JSON.parse(stdout) as { packets?: Packet[] };
      const times = packets.flatMap((pk) => {
        const t = timeOf(pk);
        return t != null ? [t] : [];
      });
      if (range == null) return times.length > 0;
      const wantFrom = Math.max(start, range.start);
      const wantTo = Math.min(end ?? range.end, range.end);
      if (wantTo < wantFrom) return true;
      if (times.length === 0) return false;
      return Math.min(...times) <= wantFrom + slack && Math.max(...times) >= wantTo - slack;
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const stdout = await runner.ffprobe(args);
      if (covers(stdout)) return stdout;
    }
    const stdout = await runner.ffprobe([...args.slice(0, i), ...args.slice(i + 2)]);
    const parsed = JSON.parse(stdout) as { packets?: Packet[] };
    const packets = (parsed.packets ?? []).filter((pk) => {
      const t = timeOf(pk);
      return t == null || (t >= start - 2 && (end == null || t <= end));
    });
    return JSON.stringify({ ...parsed, packets });
  };
  return Object.assign(Object.create(runner) as T, runner, { ffprobe, [reliableMarker]: true });
}

async function probeVideoPackets(runner: FfRunner, path: string, streamIndex: number, readIntervals: string) {
  const stdout = await runner.ffprobe([
    '-v', 'error', ...(readIntervals !== '%' ? ['-read_intervals', readIntervals] : []), '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts_time,dts_time,duration_time,flags', '-of', 'json', path,
  ]);
  return parsePackets(stdout);
}

export async function probeJoinInput(runner: FfRunner, path: string): Promise<JoinInputInfo> {
  const stdout = await runner.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  const { streams = [], format = {} } = JSON.parse(stdout) as { streams?: JoinProbeStream[], format?: { start_time?: string, duration?: string, bit_rate?: string } };
  const isVideo = (s: JoinProbeStream) => s.codec_type === 'video' && !s.disposition?.attached_pic;
  const videos = streams.filter((s) => isVideo(s));
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle');
  const startTime = parseFloat(format.start_time ?? '');
  const duration = parseFloat(format.duration ?? '');
  const video = videos[0];

  let firstKeyframePts: number | undefined;
  let startIssue: string | undefined;
  if (video != null) {
    for (const count of [200, 2000]) {
      // eslint-disable-next-line no-await-in-loop
      const packets = await probeVideoPackets(runner, path, video.index, `%+#${count}`);
      const keyIndex = packets.findIndex((p) => p.keyframe);
      const key = packets[keyIndex];
      // eslint-disable-next-line no-continue
      if (key == null) continue;
      firstKeyframePts = key.pts;
      const nextKey = packets.findIndex((p, i) => i > keyIndex && p.keyframe);
      // leading frames: decoded after the keyframe but shown before it (open GOP)
      const leading = packets.slice(keyIndex + 1, nextKey === -1 ? undefined : nextKey).filter((p) => p.pts < key.pts - 1e-6);
      if (keyIndex > 0) startIssue = `starts mid-GOP (${keyIndex} packet(s) before the first keyframe)`;
      else if (leading.length > 0) startIssue = `starts with an open GOP (${leading.length} leading frame(s) before the first keyframe)`;
      break;
    }
  }

  return {
    path,
    startTime: Number.isNaN(startTime) ? 0 : startTime,
    duration: Number.isNaN(duration) ? undefined : duration,
    bitrate: parseBitrate(format.bit_rate),
    video,
    audio: audios[0],
    streamCounts: { video: videos.length, audio: audios.length, subtitle: subtitles.length, other: streams.length - videos.length - audios.length - subtitles.length },
    firstKeyframePts,
    startIssue,
  };
}

function getTargetVideo(info: JoinInputInfo): JoinTargetVideo {
  const s = info.video!;
  const rate = getStreamFrameRate(s);
  if (rate == null) throw new Error(`Unknown frame rate: ${info.path}`);
  if (s.width == null || s.height == null) throw new Error(`Unknown resolution: ${info.path}`);
  return {
    stream: s,
    width: s.width,
    height: s.height,
    sar: normalizeSar(s.sample_aspect_ratio),
    frameRate: rate.frameRate,
    fps: rate.fps,
    fieldOrder: normalizeFieldOrder(s.field_order),
    bitrate: parseBitrate(s.bit_rate) ?? info.bitrate,
  };
}

function getTargetAudio(s: JoinProbeStream): JoinTargetAudio {
  return {
    stream: s,
    codec: s.codec_name ?? 'aac',
    sampleRate: parseInt(s.sample_rate ?? '48000', 10),
    channels: s.channels ?? 2,
    channelLayout: normalizeLayout(s),
    bitrate: parseBitrate(s.bit_rate),
  };
}

// codecs whose decoders order frames by picture order count, which only resets at an IDR (H.264) / IRAP (HEVC)
const pocCodecs = new Set(['h264', 'hevc']);

function isDecoderReset(codec: string | undefined, nalType: number) {
  if (codec === 'h264') return nalType === 5;
  // BLA, IDR (a CRA in the middle of a stream doesn't reset the picture order count)
  if (codec === 'hevc') return nalType >= 16 && nalType <= 20;
  return true;
}

// NAL unit type of the first slice of the keyframe at (or just before) `seek` (seconds from the file's start)
export async function getKeyframeNalType(runner: FfRunner, { path, streamIndex, codec, seek }: { path: string, streamIndex: number, codec: string | undefined, seek: number }) {
  const { stderr } = await runner.ffmpeg([
    '-hide_banner', '-nostdin', '-v', 'info',
    ...(seek > 0.001 ? ['-ss', fmt(seek + 0.001)] : []),
    '-i', path, '-map', `0:${streamIndex}`, '-frames:v', '1', '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-',
  ]);
  const types = [...stderr.matchAll(/nal_unit_type\s+[01]+ = (\d+)/g)].map((m) => Number(m[1]));
  // first slice (VCL NAL unit)
  const isSlice = (t: number) => (codec === 'hevc' ? t <= 31 : t >= 1 && t <= 5);
  return types.find((t) => isSlice(t));
}

// Smart render plan for one input (file's own timestamps). The first `skipKeyframes` keyframes at or after the cut start
// are treated as normal frames, so the head is re-encoded up to the next keyframe (the encoder starts with an IDR).
export async function planSmartJoinPart(runner: FfRunner, { path, stream, from, to, toEnd, skipKeyframes }: {
  path: string,
  stream: JoinProbeStream,
  from: number,
  to: number,
  toEnd: boolean,
  skipKeyframes: number,
}) {
  const rate = getStreamFrameRate(stream);
  if (rate == null) throw new Error('Unknown frame rate');
  const frameDuration = 1 / rate.fps;
  const tol = frameDuration / 4;
  let packets = await readPacketsForPlan(runner, { path, streamIndex: stream.index, cutFrom: from, cutTo: to, toEnd });
  if (skipKeyframes > 0) {
    const keyframesFrom = () => packets.filter((pk) => pk.keyframe && pk.pts >= from - tol).sort((x, y) => x.pts - y.pts);
    let keys = keyframesFrom();
    // make sure we have the packets up to the keyframe after the skipped ones
    while (keys.length > 0 && keys.length <= skipKeyframes && (toEnd || keys.at(-1)!.pts < to)) {
      // eslint-disable-next-line no-await-in-loop
      const more = await readPacketsForPlan(runner, { path, streamIndex: stream.index, cutFrom: keys.at(-1)!.pts + tol * 2, cutTo: to, toEnd });
      const before = keys.length;
      packets = mergePackets(packets, more);
      keys = keyframesFrom();
      if (keys.length === before) break;
    }
    const skip = new Set(keys.slice(0, skipKeyframes).map((k) => `${k.dts}/${k.pts}`));
    packets = packets.map((pk) => (skip.has(`${pk.dts}/${pk.pts}`) ? { ...pk, keyframe: false } : pk));
  }
  return planSmartRender({ packets, cutFrom: from, cutTo: to, frameDuration, toEnd });
}

// Decode the start of a video file and check that the frames come out in order, without gaps or duplicates.
// Catches H.264/HEVC joins where the decoder can't order the frames after an encoded part (picture order count discontinuity).
export async function checkDecodeOrder(runner: FfRunner, { path, frameDuration, duration }: { path: string, frameDuration: number, duration: number | undefined }) {
  const { stderr } = await runner.ffmpeg([
    '-hide_banner', '-nostdin', '-v', 'info', '-i', path, '-map', '0:v:0',
    ...(duration != null ? ['-t', fmt(duration)] : []),
    '-vf', 'showinfo', '-f', 'null', '-',
  ]);
  const problems: string[] = [];
  if (/non monotonically increasing dts/.test(stderr)) problems.push('decoder output timestamps go backwards');
  const times = [...stderr.matchAll(/Parsed_showinfo.*? pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  if (times.length === 0) problems.push('no frames decoded');
  for (let i = 1; i < times.length; i += 1) {
    const step = times[i]! - times[i - 1]!;
    if (step < frameDuration * 0.5 || step > frameDuration * 1.5) {
      problems.push(`frame order/gap problem at ${times[i - 1]!.toFixed(3)}s -> ${times[i]!.toFixed(3)}s`);
      break;
    }
  }
  return problems;
}

// Like smartRenderVideo, but for a plan made by planSmartJoinPart
async function renderSmartJoinPart({ runner, path, stream, plan, startTime, outPathPrefix, tempFiles, bitrate }: {
  runner: JoinRunner,
  path: string,
  stream: JoinProbeStream,
  plan: SmartRenderPlan,
  startTime: number,
  outPathPrefix: string,
  tempFiles: string[],
  bitrate: number | undefined,
}) {
  const frameDuration = 1 / getStreamFrameRate(stream)!.fps;
  const { format, ext } = getIntermediateFormat(stream.codec_name);
  const encoderArgs = getEncoderArgs(stream, { bitrate });
  const files: { path: string, duration: number | undefined }[] = [];
  for (const [i, part] of plan.parts.entries()) {
    const outPath = `${outPathPrefix}-${i}.${ext}`;
    tempFiles.push(outPath);
    const args = part.type === 'encode'
      ? getEncodePartArgs({ inputPath: path, streamIndex: stream.index, part, startTime, frameDuration, encoderArgs, format, outPath })
      : getCopyPartArgs({ inputPath: path, streamIndex: stream.index, part, startTime, frameDuration, reorderDelay: stream.has_b_frames ?? 0, format, outPath });
    // eslint-disable-next-line no-await-in-loop
    await runner.ffmpeg(args);
    files.push({ path: outPath, duration: part.duration });
  }
  const concatListPath = `${outPathPrefix}-list.txt`;
  tempFiles.push(concatListPath);
  await runner.writeFile(concatListPath, getConcatList(files));
  return { plan, concatListPath, videoFrom: plan.parts[0]!.from - startTime };
}

const frameRange = (from: number | undefined, to: number | undefined) => `${from != null ? from.toFixed(3) : 'start'}-${to != null ? to.toFixed(3) : 'end'}s`;

// Probe the inputs and decide, for each one, how its video and audio get into the joined file.
export async function planJoin({ runner: rawRunner, inputs }: { runner: FfRunner, inputs: JoinInputSpec[] }): Promise<JoinPlan> {
  if (inputs.length === 0) throw new Error('Nothing to join');
  const runner = withReliableIntervals(rawRunner);
  const infos: JoinInputInfo[] = [];
  for (const input of inputs) {
    // eslint-disable-next-line no-await-in-loop
    const info = await probeJoinInput(runner, input.path);
    if (info.video == null) throw new Error(`No video stream: ${input.path}`);
    if (info.firstKeyframePts == null) throw new Error(`No keyframe found: ${input.path}`);
    infos.push(info);
  }

  const targetIndex = pickMajority(infos.map((info, index) => ({ index, value: info.video! })), videoKey)!;
  const targetVideo = getTargetVideo(infos[targetIndex]!);
  const withAudio = infos.flatMap((info, index) => (info.audio != null ? [{ index, value: info.audio }] : []));
  const audioTargetIndex = pickMajority(withAudio, audioKey);
  const targetAudio = audioTargetIndex != null ? getTargetAudio(infos[audioTargetIndex]!.audio!) : undefined;

  const videoCodec = targetVideo.stream.codec_name;
  let intermediate = getIntermediateFormat(videoCodec);
  if (intermediate.format === 'mpegts' && targetAudio != null && !tsAudioCodecs.has(targetAudio.codec)) intermediate = { format: 'matroska', ext: 'mkv' };

  const plans: JoinInputPlan[] = [];
  for (const [index, info] of infos.entries()) {
    const spec = inputs[index]!;
    const video = info.video!;
    const reasons: string[] = [];
    let action: JoinVideoAction;
    let smartPlan: SmartRenderPlan | undefined;

    // the first frame we can output: the first keyframe (anything before it, or shown before it in an open GOP, can't be decoded)
    const firstDecodable = info.firstKeyframePts! - info.startTime;
    let { cutFrom } = spec;
    if (cutFrom != null && cutFrom < firstDecodable - 1e-6 && info.startIssue != null) cutFrom = firstDecodable;
    const { cutTo } = spec;
    const hasCut = (cutFrom != null && cutFrom > 1e-6) || cutTo != null;

    const mismatches = getVideoMismatches(targetVideo, video);
    let idrHead = false;
    if (mismatches.length > 0) {
      action = 'encode';
      reasons.push(`re-encode to the target format: ${mismatches.join(', ')}`);
      if (info.startIssue != null) reasons.push(`${info.startIssue}: frames before the first keyframe are dropped`);
      if (hasCut) reasons.push(`cut ${frameRange(cutFrom, cutTo)}`);
    } else {
      const needSmart = hasCut || info.startIssue != null;
      if (info.startIssue != null) {
        reasons.push(`${info.startIssue}: start at the first keyframe`);
        cutFrom ??= firstDecodable;
      }
      if (hasCut) reasons.push(`frame accurate cut ${frameRange(cutFrom, cutTo)}`);
      const toEnd = cutTo == null;
      const from = (cutFrom ?? firstDecodable) + info.startTime;
      const to = (cutTo ?? info.duration ?? 1e6) + info.startTime;
      try {
        // the keyframe that the copied video would start with
        let copyStart: number | undefined = info.firstKeyframePts;
        if (needSmart) {
          // eslint-disable-next-line no-await-in-loop
          smartPlan = await planSmartJoinPart(runner, { path: info.path, stream: video, from, to, toEnd, skipKeyframes: 0 });
          const first = smartPlan.parts[0]!;
          copyStart = first.type === 'copy' ? first.from : undefined;
        }
        if (index > 0 && copyStart != null && pocCodecs.has(video.codec_name ?? '')) {
          // eslint-disable-next-line no-await-in-loop
          const nalType = await getKeyframeNalType(runner, { path: info.path, streamIndex: video.index, codec: video.codec_name, seek: copyStart - info.startTime });
          if (nalType != null && !isDecoderReset(video.codec_name, nalType)) {
            idrHead = true;
            cutFrom ??= firstDecodable;
            reasons.push(`starts on a keyframe that doesn't reset the decoder (NAL type ${nalType}): re-encode its first GOP so the join decodes in order`);
            // eslint-disable-next-line no-await-in-loop
            smartPlan = await planSmartJoinPart(runner, { path: info.path, stream: video, from, to, toEnd, skipKeyframes: 1 });
          }
        }
        if (smartPlan != null) {
          const encoded = smartPlan.parts.reduce((sum, p) => sum + (p.type === 'encode' ? (p.frames ?? 0) : 0), 0);
          const hasUnknown = smartPlan.parts.some((p) => p.type === 'encode' && p.frames == null);
          reasons.push(encoded === 0 && !hasUnknown ? 'no frames need re-encoding' : `re-encode ${hasUnknown ? 'some' : encoded} frame(s) at the cut points, copy the rest`);
        }
      } catch (err) {
        reasons.push(`could not pre-plan the smart render (${err instanceof Error ? err.message : String(err)})`);
      }
      if (needSmart || idrHead) {
        action = 'smart';
      } else {
        action = 'copy';
        reasons.push(index === targetIndex ? 'defines the target format' : 'matches the target format');
      }
    }
    if (video.level != null && targetVideo.stream.level != null && video.level !== targetVideo.stream.level && action !== 'encode') {
      reasons.push(`level ${video.level} differs from ${targetVideo.stream.level} (decodable, kept)`);
    }
    if (info.streamCounts.video > 1 || info.streamCounts.audio > 1 || info.streamCounts.subtitle > 0 || info.streamCounts.other > 0) {
      reasons.push(`only the first video and audio streams are joined (has ${info.streamCounts.video} video, ${info.streamCounts.audio} audio, ${info.streamCounts.subtitle} subtitle, ${info.streamCounts.other} other)`);
    }

    let audioAction: JoinAudioAction;
    const audioReasons: string[] = [];
    if (targetAudio == null) {
      audioAction = 'none';
    } else if (info.audio == null) {
      audioAction = 'silence';
      audioReasons.push('no audio: insert silence');
    } else {
      const audioMismatches = getAudioMismatches(targetAudio, info.audio);
      if (audioMismatches.length > 0) {
        audioAction = 'encode';
        audioReasons.push(`re-encode audio: ${audioMismatches.join(', ')}`);
      } else {
        audioAction = 'copy';
      }
    }

    plans.push({ index, path: info.path, cutFrom, cutTo, info, action, reasons, audioAction, audioReasons, smartPlan, idrHead });
  }

  const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
  const t = targetVideo;
  const summary = [
    `Target: ${t.stream.codec_name} ${t.stream.profile ?? ''} ${t.width}x${t.height} SAR ${t.sar} ${t.fps.toFixed(3)} fps ${t.fieldOrder} ${t.stream.pix_fmt ?? ''} (from #${targetIndex + 1})`.replaceAll(/\s+/g, ' ')
    + (targetAudio != null ? `; audio ${targetAudio.codec} ${targetAudio.sampleRate} Hz ${targetAudio.channelLayout} (from #${audioTargetIndex! + 1})` : '; no audio'),
    ...plans.map((p) => `#${p.index + 1} ${name(p.path)}: video ${p.action} (${p.reasons.join('; ')}), audio ${p.audioAction}${p.audioReasons.length > 0 ? ` (${p.audioReasons.join('; ')})` : ''}`),
  ];

  return { inputs: plans, targetIndex, audioTargetIndex, target: { video: targetVideo, audio: targetAudio }, intermediate, summary };
}

// --- running the plan ---

const colorMatrices: Record<string, string> = { bt709: 'bt709', smpte170m: 'bt601', bt470bg: 'bt601', fcc: 'fcc', smpte240m: 'smpte240m', bt2020nc: 'bt2020' };

// Video filters that convert `src` to the target format: deinterlace if needed, scale + pad keeping the display aspect, set SAR, convert frame rate
export function getConversionFilters(src: JoinProbeStream, target: JoinTargetVideo) {
  const filters: string[] = [];
  const srcField = normalizeFieldOrder(src.field_order);
  const srcSar = parseRatio(normalizeSar(src.sample_aspect_ratio))!;
  const tgtSar = parseRatio(target.sar)!;
  const srcRate = getStreamFrameRate(src);
  const w = src.width ?? target.width;
  const h = src.height ?? target.height;
  const needScale = w !== target.width || h !== target.height || normalizeSar(src.sample_aspect_ratio) !== target.sar;
  const needFps = srcRate == null || Math.abs(srcRate.fps - target.fps) / target.fps > 0.001;

  if (srcField !== 'progressive' && (needScale || needFps || target.fieldOrder === 'progressive')) {
    filters.push('bwdif=mode=send_frame:parity=auto');
  } else if (srcField !== 'progressive' && srcField !== target.fieldOrder) {
    filters.push(`fieldorder=${target.fieldOrder}`);
  }

  if (needScale) {
    const srcDar = (w * srcSar[0]) / (h * srcSar[1]);
    const boxDar = (target.width * tgtSar[0]) / (target.height * tgtSar[1]);
    let sw: number;
    let sh: number;
    if (srcDar > boxDar) {
      sw = target.width;
      sh = Math.min(target.height, Math.round((target.width * tgtSar[0]) / (tgtSar[1] * srcDar) / 2) * 2);
    } else {
      sh = target.height;
      sw = Math.min(target.width, Math.round((target.height * srcDar * tgtSar[1]) / tgtSar[0] / 2) * 2);
    }
    const inMatrix = colorMatrices[src.color_space ?? ''] ?? (h <= 576 ? 'bt601' : 'bt709');
    const outMatrix = colorMatrices[target.stream.color_space ?? ''] ?? (target.height <= 576 ? 'bt601' : 'bt709');
    filters.push(`scale=${sw}:${sh}:flags=lanczos:in_color_matrix=${inMatrix}:out_color_matrix=${outMatrix}`);
    if (sw !== target.width || sh !== target.height) filters.push(`pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`);
  }
  filters.push(`setsar=${target.sar.replace(':', '/')}`);
  if (needFps) filters.push(`fps=${target.frameRate}`);
  return filters;
}

// smartRender's encoder settings are meant for short heads/tails (one GOP). For whole inputs, use a regular GOP size.
export function getFullEncodeArgs(target: JoinTargetVideo) {
  const gop = Math.max(1, Math.round(target.fps * 2));
  const mpegGop = Math.max(1, Math.round(target.fps / 2));
  const args = getEncoderArgs(target.stream, { bitrate: target.bitrate });
  return args.map((arg, i) => {
    if (args[i - 1] === '-g' && arg === '1000000') return String(mpegGop);
    return arg.replace('keyint=infinite', `keyint=${gop}`).replace('keyint=-1', `keyint=${gop}`);
  });
}

function getAudioEncodeArgs(target: JoinTargetAudio) {
  // the probed bit rate is often the average of variable bit rate audio (very low for quiet audio), so don't go below a sane minimum
  const minimum = target.codec === 'ac3' || target.codec === 'eac3' ? 96000 * Math.max(target.channels, 2) : 64000 * target.channels;
  const bitrate = Math.max(target.bitrate ?? (target.codec === 'ac3' || target.codec === 'eac3' ? 384000 : 192000), minimum);
  return [
    '-c:a', getAudioEncoder(target.codec),
    ...(!losslessAudio.has(target.codec) && !target.codec.startsWith('pcm_') ? ['-b:a', String(bitrate)] : []),
  ];
}

interface AudioPacket { pts: number, duration: number }

async function probeAudioPackets(runner: FfRunner, path: string, streamIndex: number, from: number | undefined, to: number | undefined): Promise<AudioPacket[]> {
  const stdout = await runner.ffprobe([
    '-v', 'error',
    ...(from != null ? ['-read_intervals', `${fmt(Math.max(from, 0))}%${to != null ? fmt(to) : ''}`] : []),
    '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', path,
  ]);
  const { packets = [] } = JSON.parse(stdout) as { packets?: { pts_time?: string, duration_time?: string }[] };
  return packets.flatMap((p) => {
    const pts = parseFloat(p.pts_time ?? '');
    const duration = parseFloat(p.duration_time ?? '');
    return Number.isNaN(pts) ? [] : [{ pts, duration: Number.isNaN(duration) ? 0 : duration }];
  }).sort((a, b) => a.pts - b.pts);
}

// Info about a video intermediate: first frame time, frame count, duration (first frame to the end of the last frame)
async function probeVideoPart(runner: FfRunner, path: string, frameDuration: number) {
  const stdout = await runner.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets:format=start_time,duration', '-of', 'json', path]);
  const { streams = [], format = {} } = JSON.parse(stdout) as { streams?: { nb_read_packets?: string }[], format?: { start_time?: string, duration?: string } };
  const frames = parseInt(streams[0]?.nb_read_packets ?? '', 10);
  if (!(frames > 0)) throw new Error(`No video frames in ${path}`);
  const head = await probeVideoPackets(runner, path, 0, '%+#100');
  let first = Math.min(...head.map((p) => p.pts));
  const end = parseFloat(format.start_time ?? '0') + parseFloat(format.duration ?? '0');
  const tail = await probeVideoPackets(runner, path, 0, `${fmt(Math.max(end - 10, 0))}%`);
  let last = Math.max(...head.map((p) => p.pts), ...tail.map((p) => p.pts));
  // The container duration can be an estimate. If the numbers don't add up, read all the timestamps
  if (!Number.isFinite(first) || !Number.isFinite(last) || Math.abs((last + frameDuration - first) / frameDuration - frames) > 2) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const all = await probeVideoPackets(runner, path, 0, '%');
      first = Math.min(...all.map((p) => p.pts));
      last = Math.max(...all.map((p) => p.pts));
      if (Number.isFinite(first) && Number.isFinite(last)) break;
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) throw new Error(`Could not read the timestamps of ${path}`);
  }
  const duration = last + frameDuration - first;
  return { first, frames, duration };
}

// encoder delay (priming) and frame duration of the target audio encoder, measured by encoding a bit of silence
async function measureAudioEncoder(runner: JoinRunner, target: JoinTargetAudio, path: string) {
  await runner.ffmpeg([
    '-hide_banner', '-nostdin', '-y', '-v', 'error', '-copyts',
    '-f', 'lavfi', '-i', `anullsrc=r=${target.sampleRate}:cl=${target.channelLayout},atrim=end=0.5,asetpts=PTS+${audioBase}/TB`,
    ...getAudioEncodeArgs(target), '-f', 'nut', path,
  ]);
  const packets = await probeAudioPackets(runner, path, 0, undefined, undefined);
  const first = packets[0];
  const frameDuration = packets[1]?.duration || first?.duration;
  if (first == null || !frameDuration) throw new Error('Could not measure the audio encoder');
  return { priming: Math.max(0, audioBase - first.pts), frameDuration };
}

function joinPath(dir: string, name: string) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Join was cancelled');
};

// Pick the audio packets for one part: those starting at or after `aStart` and before the end of the part's video `d`.
// Times are relative to the part's first video frame, which is at `base` in the audio file's timeline.
async function selectAudio(runner: FfRunner, { path, streamIndex, base, aStart, d }: { path: string, streamIndex: number, base: number, aStart: number, d: number }) {
  const lo = base + aStart - audioEps;
  const hi = base + d - audioEps;
  let packets = await probeAudioPackets(runner, path, streamIndex, lo - 3, Math.min(lo + 3, hi + 2));
  const first = packets.find((p) => p.pts >= lo && p.pts < hi);
  if (first == null) return undefined;
  let endPackets = d - aStart > 4 ? await probeAudioPackets(runner, path, streamIndex, hi - 4, hi + 2) : packets;
  let last = endPackets.findLast((p) => p.pts < hi && p.pts >= first.pts);
  if (last == null) {
    // the audio ends before the video does: find its last packet
    packets = await probeAudioPackets(runner, path, streamIndex, first.pts - 1, hi + 2);
    endPackets = packets;
    last = endPackets.findLast((p) => p.pts < hi && p.pts >= first.pts);
  }
  if (last == null) return undefined;
  const lastDuration = last.duration || first.duration;
  return { first: first.pts, last: last.pts, start: first.pts - base, end: last.pts + lastDuration - base };
}

// --- verification ---

interface OutPacket { stream: number, pts: number, dts: number | undefined, duration: number }

async function probeOutPackets(runner: FfRunner, path: string, from: number, to: number) {
  const stdout = await runner.ffprobe(['-v', 'error', '-read_intervals', `${fmt(Math.max(from, 0))}%${fmt(to)}`, '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time', '-of', 'json', path]);
  const { packets = [] } = JSON.parse(stdout) as { packets?: { stream_index?: number, pts_time?: string, dts_time?: string, duration_time?: string }[] };
  return packets.flatMap((p): OutPacket[] => {
    const pts = parseFloat(p.pts_time ?? '');
    const dts = parseFloat(p.dts_time ?? '');
    const duration = parseFloat(p.duration_time ?? '');
    return Number.isNaN(pts) ? [] : [{ stream: p.stream_index ?? -1, pts, dts: Number.isNaN(dts) ? undefined : dts, duration: Number.isNaN(duration) ? 0 : duration }];
  });
}

// Check a joined file: frame count = sum of the parts, no missing/duplicate frames and monotonic timestamps at the joins,
// each part's audio at its planned offset from its video, and a clean decode. Returns a list of problems (empty if all is good).
export async function verifyJoin({ runner: rawRunner, outPath, parts, frameDuration, hasAudio, avTolerance = 0.003, fullDecode = true }: {
  runner: FfRunner,
  outPath: string,
  parts: Pick<JoinPartResult, 'frames' | 'outStart' | 'audioStart'>[],
  frameDuration: number,
  hasAudio: boolean,
  avTolerance?: number,
  fullDecode?: boolean,
}) {
  const runner = withReliableIntervals(rawRunner);
  const problems: string[] = [];
  const stdout = await runner.ffprobe(['-v', 'error', '-count_packets', '-show_entries', 'stream=index,codec_type,nb_read_packets', '-of', 'json', outPath]);
  const { streams = [] } = JSON.parse(stdout) as { streams?: { index: number, codec_type?: string, nb_read_packets?: string }[] };
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  if (videoStream == null) return ['No video stream in the output'];
  if (hasAudio && audioStream == null) problems.push('No audio stream in the output');
  const expectedFrames = parts.reduce((sum, p) => sum + p.frames, 0);
  const frames = parseInt(videoStream.nb_read_packets ?? '', 10);
  if (frames !== expectedFrames) problems.push(`Output has ${frames} video frames, expected ${expectedFrames}`);

  const head = await probeVideoPackets(runner, outPath, videoStream.index, '%+#100');
  const outStart = Math.min(...head.map((p) => p.pts));

  for (const [k, part] of parts.entries()) {
    const at = outStart + part.outStart;
    const label = k === 0 ? 'the start' : `join ${k} (${part.outStart.toFixed(3)}s)`;
    // eslint-disable-next-line no-await-in-loop
    const packets = await probeOutPackets(runner, outPath, at - 2, at + 2);
    const videoPackets = packets.filter((p) => p.stream === videoStream.index);
    const near = videoPackets.filter((p) => Math.abs(p.pts - at) <= frameDuration * 8);
    const times = near.map((p) => p.pts).sort((a, b) => a - b);
    if (!times.some((t) => Math.abs(t - at) < frameDuration / 4)) problems.push(`No frame at ${label}`);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i]! - times[i - 1]!;
      if (gap > frameDuration * 1.5) problems.push(`Missing frame(s) near ${label}`);
      if (gap < frameDuration * 0.5) problems.push(`Duplicate frame near ${label}`);
    }
    const withDts = near.filter((p) => p.dts != null);
    if (withDts.some((p, i) => i > 0 && p.dts! <= withDts[i - 1]!.dts!)) problems.push(`Video decode timestamps go backwards near ${label}`);

    if (audioStream != null) {
      const audioPackets = packets.filter((p) => p.stream === audioStream.index);
      if (audioPackets.some((p, i) => i > 0 && p.pts < audioPackets[i - 1]!.pts + audioPackets[i - 1]!.duration - 0.0015)) problems.push(`Audio packets overlap near ${label}`);
      if (part.audioStart != null) {
        const expected = at + part.audioStart;
        const nearest = audioPackets.reduce<OutPacket | undefined>((best, p) => (best == null || Math.abs(p.pts - expected) < Math.abs(best.pts - expected) ? p : best), undefined);
        const offset = nearest != null ? nearest.pts - expected : Infinity;
        if (Math.abs(offset) > avTolerance) problems.push(`A/V offset at ${label} is ${Number.isFinite(offset) ? `${(offset * 1000).toFixed(1)} ms` : 'unknown (no audio)'}`);
      }
    }
  }

  if (fullDecode) {
    const { stderr } = await runner.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-i', outPath, '-map', '0:v:0', ...(audioStream != null ? ['-map', '0:a:0'] : []), '-f', 'null', '-']);
    const errors = getDecodeErrors(stderr);
    if (errors.length > 0) problems.push(`Decoding errors (${errors.length}): ${errors[0]}`);
  }

  return [...new Set(problems)];
}

export async function runJoin({ runner: rawRunner, plan, outPath, tempDir, onProgress, signal, verify = true, keepTempFiles = false }: {
  runner: JoinRunner,
  plan: JoinPlan,
  outPath: string,
  tempDir: string,
  onProgress?: ((progress: number, stage: string) => void) | undefined,
  signal?: AbortSignal | undefined,
  // check the output (frame count, joins, A/V offsets, full decode). Default true
  verify?: boolean | undefined,
  // for debugging
  keepTempFiles?: boolean | undefined,
}): Promise<JoinResult> {
  const runner = withReliableIntervals(rawRunner);
  const tempFiles: string[] = [];
  const prefix = joinPath(tempDir, `smartjoin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const { format, ext } = plan.intermediate;
  const target = plan.target.video;
  const targetAudio = plan.target.audio;
  const frameDuration = 1 / target.fps;
  const warnings: string[] = [];

  // progress weights: encoding is much slower than copying
  const weights = plan.inputs.map((p) => {
    const duration = (p.cutTo ?? p.info.duration ?? 60) - (p.cutFrom ?? 0);
    return Math.max(duration, 0.1) * (p.action === 'encode' ? 1 : (p.action === 'smart' ? 0.3 : 0.05)) + (p.audioAction === 'encode' ? duration * 0.02 : 0);
  });
  const totalDuration = plan.inputs.reduce((sum, p) => sum + Math.max((p.cutTo ?? p.info.duration ?? 60) - (p.cutFrom ?? 0), 0), 0);
  const finalWeight = totalDuration * 0.05;
  const verifyWeight = verify ? totalDuration * 0.1 : 0;
  const totalWeight = weights.reduce((a, b) => a + b, 0) + finalWeight + verifyWeight;
  let doneWeight = 0;
  const report = (stage: string, extra = 0) => onProgress?.(Math.min(1, (doneWeight + extra) / totalWeight), stage);

  const temp = (name: string) => {
    const path = `${prefix}-${name}`;
    tempFiles.push(path);
    return path;
  };

  try {
    // measured when first needed
    let audioEncoder: { priming: number, frameDuration: number } | undefined;

    const parts: JoinPartResult[] = [];
    const concatFiles: { path: string, duration: number }[] = [];
    // output time (from the output's first frame) where the previous part's audio ended
    let audioEnd = 0;
    let outPos = 0;

    for (const [k, input] of plan.inputs.entries()) {
      throwIfAborted(signal);
      const name = input.path.split(/[\\/]/).pop();
      report(`#${k + 1} ${name}: ${input.action} video`);
      const { info } = input;
      const video = info.video!;
      const videoPath = temp(`${k}-video.${ext}`);
      let sourceStart: number;
      let encodedFrames = 0;

      let videoAction: JoinVideoAction = input.action;

      // re-encode the whole input (or its cut range) to the target format. Returns where its first output frame is in the source
      const encodeWhole = async () => {
        const srcRate = getStreamFrameRate(video);
        const srcTol = (srcRate != null ? 1 / srcRate.fps : frameDuration) / 4;
        // first frame to keep (file's own timestamps)
        let trimStart = input.cutFrom != null ? input.cutFrom + info.startTime : undefined;
        if (info.startIssue != null && (trimStart == null || trimStart < info.firstKeyframePts!)) trimStart = info.firstKeyframePts!;
        const trimEnd = input.cutTo != null ? input.cutTo + info.startTime : undefined;
        const seek = trimStart != null ? trimStart - info.startTime - 10 : 0;
        const trim = trimStart != null || trimEnd != null
          ? [`trim=${[...(trimStart != null ? [`start=${fmt(trimStart - srcTol)}`] : []), ...(trimEnd != null ? [`end=${fmt(trimEnd - srcTol)}`] : [])].join(':')}`]
          : [];
        const filters = [...trim, 'setpts=PTS-STARTPTS', ...getConversionFilters(video, target)];
        await runner.ffmpeg([
          '-hide_banner', '-nostdin', '-y', '-copyts',
          ...(seek > 0 ? ['-noaccurate_seek', '-ss', fmt(seek)] : []),
          '-i', input.path, '-map', `0:${video.index}`,
          '-vf', filters.join(','), '-fps_mode', 'passthrough',
          ...getFullEncodeArgs(target),
          '-map_metadata', '-1', '-map_chapters', '-1', '-f', format, videoPath,
        ]);
        // the time of the first frame that passed the trim
        const from = trimStart ?? info.firstKeyframePts!;
        const packets = await probeVideoPackets(runner, input.path, video.index, `${fmt(Math.max(from - 3, 0))}%${fmt(from + 3)}`);
        const first = Math.min(...packets.filter((pk) => pk.pts >= from - srcTol).map((pk) => pk.pts));
        return Number.isFinite(first) ? first : from;
      };

      if (input.action === 'copy') {
        await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-i', input.path, '-map', `0:${video.index}`, '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1', '-f', format, videoPath]);
        sourceStart = info.firstKeyframePts!;
      } else if (input.action === 'smart') {
        const toEnd = input.cutTo == null;
        const bitrate = parseBitrate(video.bit_rate) ?? info.bitrate;
        const from = (input.cutFrom ?? 0) + info.startTime;
        const to = (input.cutTo ?? info.duration ?? 1e6) + info.startTime;
        const checkOrder = pocCodecs.has(video.codec_name ?? '');
        // Normally smartRenderVideo. H.264/HEVC decoders order frames by picture order count, which doesn't continue correctly
        // from an encoded head into a copied non-IDR keyframe for some cut positions. If decoding shows that, re-encode up
        // to the next IDR keyframe instead, or the whole input if there is none.
        let skip = input.idrHead ? 1 : 0;
        let searchedIdr = false;
        let result: { plan: SmartRenderPlan, videoFrom: number } | undefined;
        for (; ;) {
          const outPathPrefix = `${prefix}-${k}-smart${skip}`;
          // eslint-disable-next-line no-await-in-loop
          const rendered = skip === 0 ? await smartRenderVideo({
            runner,
            inputPath: input.path,
            stream: video,
            cutFrom: input.cutFrom ?? 0,
            cutTo: input.cutTo ?? info.duration ?? 1e6,
            toEnd,
            outPathPrefix,
            tempFiles,
            writeFile: runner.writeFile,
            bitrate,
            onPart: (i, count) => report(`#${k + 1} ${name}: smart render part ${i + 1}/${count}`, weights[k]! * (i / Math.max(count, 1)) * 0.7),
          }) : await renderSmartJoinPart({
            runner,
            path: input.path,
            stream: video,
            // eslint-disable-next-line no-await-in-loop
            plan: await planSmartJoinPart(runner, { path: input.path, stream: video, from, to, toEnd, skipKeyframes: skip }),
            startTime: info.startTime,
            outPathPrefix,
            tempFiles,
            bitrate,
          });
          // eslint-disable-next-line no-await-in-loop
          await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', rendered.concatListPath, '-map', '0:v:0', '-c', 'copy', '-f', format, videoPath]);
          const [head, second] = rendered.plan.parts;
          if (!checkOrder || head?.type !== 'encode' || second == null) {
            result = rendered;
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          const orderProblems = await checkDecodeOrder(runner, { path: videoPath, frameDuration, duration: head.duration + 2 });
          if (orderProblems.length === 0) {
            result = rendered;
            break;
          }
          let nextSkip: number | undefined;
          if (!searchedIdr) {
            searchedIdr = true;
            // eslint-disable-next-line no-await-in-loop
            const packets = await probeVideoPackets(runner, input.path, video.index, `${fmt(Math.max(from - 1, 0))}%${fmt(toEnd ? from + 600 : Math.min(to, from + 600))}`);
            const keyframes = packets.filter((pk) => pk.keyframe && pk.pts >= from - frameDuration / 4 && (toEnd || pk.pts < to)).sort((x, y) => x.pts - y.pts);
            for (const [i, key] of keyframes.slice(0, 31).entries()) {
              // eslint-disable-next-line no-continue
              if (i <= skip) continue;
              // eslint-disable-next-line no-await-in-loop
              const nalType = await getKeyframeNalType(runner, { path: input.path, streamIndex: video.index, codec: video.codec_name, seek: key.pts - info.startTime });
              if (nalType != null && isDecoderReset(video.codec_name, nalType)) {
                nextSkip = i;
                break;
              }
            }
          }
          if (nextSkip == null) {
            warnings.push(`#${k + 1}: copying from the keyframe at ${second.from.toFixed(3)}s gives ${orderProblems[0]} and there is no IDR keyframe to copy from instead; re-encoding the whole input`);
            break;
          }
          warnings.push(`#${k + 1}: copying from the keyframe at ${second.from.toFixed(3)}s gives ${orderProblems[0]}; re-encoding up to the next IDR keyframe`);
          skip = nextSkip;
        }
        if (result != null) {
          encodedFrames = result.plan.parts.reduce((sum, pt) => sum + (pt.type === 'encode' ? (pt.frames ?? 0) : 0), 0);
          sourceStart = result.videoFrom + info.startTime;
        } else {
          videoAction = 'encode';
          sourceStart = await encodeWhole();
        }
      } else {
        sourceStart = await encodeWhole();
      }

      const v = await probeVideoPart(runner, videoPath, frameDuration);
      if (videoAction === 'encode') encodedFrames = v.frames;
      const expectedFrames = Math.round(v.duration / frameDuration);
      if (Math.abs(expectedFrames - v.frames) > 0) warnings.push(`#${k + 1}: ${v.frames} frames in ${v.duration.toFixed(3)}s (timestamp gaps or variable frame rate)`);

      throwIfAborted(signal);
      report(`#${k + 1} ${name}: audio ${input.audioAction}`, weights[k]! * 0.8);

      // The part's audio, relative to its first video frame: from `aStart` (after the previous part's audio) until the end of its video
      const aStart = Math.max(0, audioEnd - outPos);
      const partPath = temp(`${k}-part.${ext}`);
      let audioRange: { first: number, last: number, start: number, end: number } | undefined;
      let audioFile: { path: string, streamIndex: number, base: number, seek: number | undefined } | undefined;
      let { audioAction } = input;

      if (audioAction === 'copy') {
        const streamIndex = info.audio!.index;
        audioRange = await selectAudio(runner, { path: input.path, streamIndex, base: sourceStart, aStart, d: v.duration });
        if (audioRange != null) audioFile = { path: input.path, streamIndex, base: sourceStart, seek: Math.max(0, audioRange.first - info.startTime - 5) };
        else audioAction = 'silence';
      }
      if (audioAction === 'encode' || audioAction === 'silence') {
        audioEncoder ??= await measureAudioEncoder(runner, targetAudio!, temp('audiotest.nut'));
        const enc = audioEncoder;
        const ta = targetAudio!;
        // start the encoder input early by `preRoll`, so that a packet starts exactly at aStart (after the encoder delay)
        const preRoll = Math.ceil(enc.priming / enc.frameDuration - 1e-6) * enc.frameDuration - enc.priming;
        const inStart = audioBase + aStart - preRoll;
        const inEnd = audioBase + v.duration + enc.frameDuration * 2;
        const rawPath = temp(`${k}-audio.nut`);
        // Fill gaps and pad the start with silence so the audio starts exactly at inStart. aresample's first_pts is in the
        // input's sample rate here, so convert the sample rate in a separate step.
        const sync = (rate: number) => `aresample=async=1:min_hard_comp=0.001:first_pts=${Math.round(inStart * rate)}`;
        const common = [`aresample=${ta.sampleRate}`, `aformat=channel_layouts=${ta.channelLayout}`, 'apad', `atrim=end=${fmt(inEnd)}`];
        if (audioAction === 'encode') {
          const shift = audioBase - sourceStart;
          const seek = sourceStart + aStart - info.startTime - 5;
          await runner.ffmpeg([
            '-hide_banner', '-nostdin', '-y', '-copyts',
            ...(seek > 0 ? ['-noaccurate_seek', '-ss', fmt(seek)] : []),
            '-i', input.path, '-map', `0:${info.audio!.index}`,
            '-af', [`asetpts=PTS${signed(shift)}/TB`, `atrim=start=${fmt(inStart)}`, sync(parseInt(info.audio!.sample_rate ?? '', 10) || ta.sampleRate), ...common].join(','),
            ...getAudioEncodeArgs(ta), '-f', 'nut', rawPath,
          ]);
        } else {
          await runner.ffmpeg([
            '-hide_banner', '-nostdin', '-y', '-copyts',
            '-f', 'lavfi', '-i', `anullsrc=r=${ta.sampleRate}:cl=${ta.channelLayout}`,
            '-af', [`atrim=end=${fmt(inEnd - inStart)}`, `asetpts=PTS${signed(inStart)}/TB`, sync(ta.sampleRate), ...common].join(','),
            ...getAudioEncodeArgs(ta), '-f', 'nut', rawPath,
          ]);
        }
        audioRange = await selectAudio(runner, { path: rawPath, streamIndex: 0, base: audioBase, aStart, d: v.duration });
        if (audioRange == null) throw new Error(`#${k + 1}: no audio after encoding`);
        audioFile = { path: rawPath, streamIndex: 0, base: audioBase, seek: undefined };
      }

      if (audioFile != null && audioRange != null) {
        // keep the selected packets and move them to the video intermediate's timeline
        const shift = v.first - audioFile.base;
        const tol = audioEps / 2;
        await runner.ffmpeg([
          '-hide_banner', '-nostdin', '-y', '-copyts',
          '-i', videoPath,
          ...(audioFile.seek != null && audioFile.seek > 0 ? ['-ss', fmt(audioFile.seek)] : []),
          '-i', audioFile.path,
          '-map', '0:v:0', '-map', `1:${audioFile.streamIndex}`, '-c', 'copy',
          '-bsf:a', `noise=drop=lt(pts*tb\\,${fmt(audioRange.first - tol)})+gt(pts*tb\\,${fmt(audioRange.last + tol)}),setts=pts=PTS${signed(shift)}/TB:dts=DTS${signed(shift)}/TB`,
          '-map_metadata', '-1', '-map_chapters', '-1', '-f', format, partPath,
        ]);
        audioEnd = outPos + audioRange.end;
      } else {
        await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-i', videoPath, '-map', '0:v:0', '-c', 'copy', '-f', format, partPath]);
      }

      parts.push({
        index: k,
        path: input.path,
        action: videoAction,
        audioAction,
        frames: v.frames,
        duration: v.duration,
        outStart: outPos,
        encodedFrames,
        sourceStart,
        audioStart: audioRange?.start,
        audioEnd: audioRange?.end,
      });
      concatFiles.push({ path: partPath, duration: v.duration });
      outPos += v.duration;
      doneWeight += weights[k]!;
    }

    throwIfAborted(signal);
    report('Joining');
    const listPath = temp('list.txt');
    await runner.writeFile(listPath, getConcatList(concatFiles));
    await runner.ffmpeg([
      '-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v:0', ...(targetAudio != null ? ['-map', '0:a:0'] : []), '-c', 'copy',
      '-map_metadata', '-1', '-map_chapters', '-1', outPath,
    ]);
    doneWeight += finalWeight;

    const frames = parts.reduce((sum, p) => sum + p.frames, 0);
    let problems: string[] = [];
    if (verify) {
      throwIfAborted(signal);
      report('Verifying');
      problems = await verifyJoin({ runner, outPath, parts, frameDuration, hasAudio: targetAudio != null });
    }
    onProgress?.(1, 'Done');
    return { outPath, parts, frames, duration: outPos, problems, warnings };
  } finally {
    for (const path of keepTempFiles ? [] : tempFiles) {
      // eslint-disable-next-line no-await-in-loop
      await runner.removeFile(path).catch(() => undefined);
    }
  }
}

// one line per part, for logs and the UI
export function describeJoinResult(result: JoinResult) {
  return result.parts.map((p) => {
    const name = p.path.split(/[\\/]/).pop();
    const video = p.action === 'copy' ? 'video copied' : (p.action === 'smart' ? `video smart rendered (${p.encodedFrames} of ${p.frames} frames re-encoded)` : `video re-encoded (${p.frames} frames)`);
    const audio = ({ none: 'no audio', copy: 'audio copied', silence: 'silent audio inserted', encode: 'audio re-encoded' } as const)[p.audioAction];
    return `#${p.index + 1} ${name}: ${video}, ${audio}, ${p.frames} frames at ${p.outStart.toFixed(3)}s`;
  });
}
