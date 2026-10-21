// Frame accurate cutting of one video stream ("smart render").
// Only the frames between the cut start and the next keyframe (head), and the frames between the last keyframe and the cut end (tail),
// are re-encoded. Everything in between is copied losslessly. The parts are then joined with the concat demuxer.
//
// Both ends of a segment are handled, including open GOPs (leading B-frames), and the
// re-encoded parts are matched to the source (codec, profile, level, pixel format, colors, interlacing and B-frame reorder delay),
// so that the decode timestamps of the joined stream stay monotonic.
//
// This module has no runtime imports, so that it can be driven by a plain Node.js script (see test-manual/smartRender).

export interface FfRunner {
  ffprobe: (args: string[]) => Promise<string>,
  ffmpeg: (args: string[]) => Promise<{ stderr: string }>,
}

// all times are in seconds, in the file's own timestamps (not relative to the file's start time)
export interface VideoPacket {
  pts: number,
  dts: number,
  duration: number,
  keyframe: boolean,
  // false if the file has no dts for this packet (then `dts` is the pts)
  dtsKnown?: boolean,
}

export interface SmartRenderStream {
  index: number,
  codec_name?: string | undefined,
  profile?: string | undefined,
  level?: number | undefined,
  pix_fmt?: string | undefined,
  color_range?: string | undefined,
  color_space?: string | undefined,
  color_transfer?: string | undefined,
  color_primaries?: string | undefined,
  field_order?: string | undefined,
  has_b_frames?: number | undefined,
  bit_rate?: string | undefined,
  avg_frame_rate?: string | undefined,
  r_frame_rate?: string | undefined,
}

export type PlanPart =
  // `from` is the pts of the first frame to encode. `decodeFrom` is the pts of a keyframe at or before it, if known
  // `forceIdrAt` (frame number in the part) makes the encoder start a new IDR picture there, see fixHeadJoin
  | { type: 'encode', from: number, frames: number | undefined, duration: number, decodeFrom: number | undefined, forceIdrAt?: number | undefined }
  // copy all packets with pts >= `from` and dts < `untilDts` (if defined)
  | { type: 'copy', from: number, untilDts: number | undefined, duration: number | undefined };

export interface SmartRenderPlan {
  parts: PlanPart[],
  // output timeline positions (seconds from the output start) where an encoded and a copied part meet
  joins: number[],
  // total output video duration, if known
  duration: number | undefined,
}

const fixedCodecs = new Set(['h264', 'hevc', 'mpeg2video', 'mpeg1video']);

export function parseFrameRate(rate: string | undefined) {
  if (rate == null) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return undefined;
  return num / den;
}

export function getFrameDuration(stream: Pick<SmartRenderStream, 'avg_frame_rate' | 'r_frame_rate'>) {
  const fps = parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate);
  return fps != null ? 1 / fps : undefined;
}

export function parsePackets(ffprobeJson: string): VideoPacket[] {
  const { packets = [] } = JSON.parse(ffprobeJson) as { packets?: { pts_time?: string, dts_time?: string, duration_time?: string, flags?: string }[] };
  return packets.flatMap((p) => {
    const pts = parseFloat(p.pts_time ?? '');
    if (Number.isNaN(pts)) return [];
    const dts = parseFloat(p.dts_time ?? '');
    const duration = parseFloat(p.duration_time ?? '');
    return [{
      pts,
      dts: Number.isNaN(dts) ? pts : dts,
      dtsKnown: !Number.isNaN(dts),
      duration: Number.isNaN(duration) ? 0 : duration,
      keyframe: (p.flags ?? '')[0] === 'K',
    }];
  });
}

export function mergePackets(...lists: VideoPacket[][]) {
  const byKey = new Map<string, VideoPacket>();
  for (const list of lists) {
    for (const p of list) byKey.set(`${p.dts}/${p.pts}`, p);
  }
  return [...byKey.values()].sort((a, b) => a.dts - b.dts);
}

// Decide which parts of [cutFrom, cutTo) to encode and which to copy.
// `packets` must cover the start of the segment until at least one keyframe after `cutFrom`,
// and (unless `toEnd`) the end of the segment from at least one keyframe before `cutTo` until after `cutTo`.
// `toEnd` means the segment goes to the end of the file, so there is no tail to encode.
export function planSmartRender({ packets, cutFrom, cutTo, frameDuration, toEnd }: {
  packets: VideoPacket[],
  cutFrom: number,
  cutTo: number,
  frameDuration: number,
  toEnd: boolean,
}): SmartRenderPlan {
  // tolerance when comparing a frame's time with a cut time
  const tol = frameDuration / 4;
  const byPts = [...packets].sort((a, b) => a.pts - b.pts);
  const keyframes = byPts.filter((p) => p.keyframe);

  const framesBetween = (from: number, to: number) => byPts.filter((p) => p.pts >= from - tol && p.pts < to - tol);
  const spanOf = (frames: VideoPacket[]) => {
    const first = frames[0]!;
    const last = frames.at(-1)!;
    return (last.pts + (last.duration || frameDuration)) - first.pts;
  };

  const encodePart = (from: number, frames: number | undefined, duration: number): PlanPart => ({
    type: 'encode', from, frames, duration, decodeFrom: keyframes.findLast((k) => k.pts <= from + tol)?.pts,
  });

  const encodeAll = (): SmartRenderPlan => {
    const frames = framesBetween(cutFrom, cutTo);
    if (frames.length === 0) throw new Error('No video frames in segment');
    // the packets may only cover the start and the end of a long segment
    const hasGap = frames.some((f, i) => i > 0 && f.pts - frames[i - 1]!.pts > 1);
    if (hasGap) return { parts: [encodePart(frames[0]!.pts, undefined, cutTo - frames[0]!.pts)], joins: [], duration: undefined };
    const duration = spanOf(frames);
    return { parts: [encodePart(frames[0]!.pts, frames.length, duration)], joins: [], duration };
  };

  const startKeyframe = keyframes.find((k) => k.pts >= cutFrom - tol);
  if (startKeyframe == null) {
    if (toEnd) throw new Error('No keyframe after the cut start');
    return encodeAll();
  }

  let endKeyframe: VideoPacket | undefined;
  // first output time not covered by the copied part. For an open GOP, the leading B-frames of `endKeyframe`
  // (displayed before it, decoded after it) can't be copied without it, so they are encoded too.
  let copyEnd: number | undefined;
  if (!toEnd) {
    endKeyframe = keyframes.findLast((k) => k.pts <= cutTo + tol);
    if (endKeyframe == null || endKeyframe.pts <= startKeyframe.pts) return encodeAll();
    const leading = packets.filter((p) => p.dts >= endKeyframe!.dts && p.pts < endKeyframe!.pts);
    copyEnd = Math.min(endKeyframe.pts, ...leading.map((p) => p.pts));
    if (copyEnd <= startKeyframe.pts) return encodeAll();
  }

  const parts: PlanPart[] = [];
  const joins: number[] = [];
  let position = 0;

  const headFrames = framesBetween(cutFrom, startKeyframe.pts);
  if (headFrames.length > 0) {
    const duration = startKeyframe.pts - headFrames[0]!.pts;
    parts.push(encodePart(headFrames[0]!.pts, headFrames.length, duration));
    position += duration;
    joins.push(position);
  }

  const copyDuration = copyEnd != null ? copyEnd - startKeyframe.pts : undefined;
  parts.push({ type: 'copy', from: startKeyframe.pts, untilDts: endKeyframe?.dts, duration: copyDuration });

  if (copyEnd != null) {
    position += copyDuration!;
    const tailFrames = framesBetween(copyEnd, cutTo);
    if (tailFrames.length > 0) {
      joins.push(position);
      const duration = spanOf(tailFrames);
      parts.push(encodePart(tailFrames[0]!.pts, tailFrames.length, duration));
      position += duration;
    }
  }

  return { parts, joins, duration: copyEnd != null ? position : undefined };
}

const x264Profiles: Record<string, string> = {
  'constrained baseline': 'baseline',
  baseline: 'baseline',
  main: 'main',
  extended: 'main',
  high: 'high',
  'high 10': 'high10',
  'high 4:2:2': 'high422',
  'high 4:4:4 predictive': 'high444',
};

function getColorArgs(stream: SmartRenderStream) {
  const args: string[] = [];
  const isKnown = (v: string | undefined): v is string => v != null && v !== '' && v !== 'unknown' && v !== 'reserved';
  if (isKnown(stream.color_primaries)) args.push('-color_primaries', stream.color_primaries);
  if (isKnown(stream.color_transfer)) args.push('-color_trc', stream.color_transfer);
  if (isKnown(stream.color_space)) args.push('-colorspace', stream.color_space);
  if (stream.color_range === 'tv' || stream.color_range === 'pc') args.push('-color_range', stream.color_range);
  return args;
}

// 'tt'/'tb' = top field first, 'bb'/'bt' = bottom field first
function getFieldOrder(stream: SmartRenderStream) {
  if (stream.field_order === 'tt' || stream.field_order === 'tb') return 'tff';
  if (stream.field_order === 'bb' || stream.field_order === 'bt') return 'bff';
  return undefined;
}

// Encoder arguments that produce frames compatible with the source stream, so the parts can be joined.
// The B-frame reorder delay must match the source, or the joined stream's decode timestamps go backwards.
export function getEncoderArgs(stream: SmartRenderStream, { bitrate }: { bitrate: number | undefined }): string[] {
  const reorderDelay = stream.has_b_frames ?? 0;
  const pixFmtArgs = stream.pix_fmt ? ['-pix_fmt', stream.pix_fmt] : [];
  const colorArgs = getColorArgs(stream);
  const fieldOrder = getFieldOrder(stream);
  const codec = stream.codec_name;

  if (codec === 'h264') {
    const profile = stream.profile ? x264Profiles[stream.profile.toLowerCase()] : undefined;
    const level = stream.level != null && stream.level > 0 ? (stream.level / 10).toFixed(1) : undefined;
    const params = [
      'keyint=infinite',
      'scenecut=0',
      `bframes=${reorderDelay > 0 ? 3 : 0}`,
      `b-pyramid=${reorderDelay >= 2 ? 'normal' : 'none'}`,
      ...(fieldOrder ? ['interlaced=1', `${fieldOrder}=1`] : []),
    ];
    return [
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
      ...(profile ? ['-profile:v', profile] : []),
      ...(level ? ['-level:v', level] : []),
      ...pixFmtArgs, ...colorArgs,
      '-x264-params', params.join(':'),
    ];
  }

  if (codec === 'hevc') {
    const profile = stream.profile?.toLowerCase().replaceAll(' ', '');
    const params = [
      'log-level=error',
      'keyint=-1',
      'scenecut=0',
      'open-gop=0',
      'repeat-headers=1',
      `bframes=${reorderDelay > 0 ? 3 : 0}`,
      `b-pyramid=${reorderDelay >= 2 ? 1 : 0}`,
      ...(stream.level != null && stream.level > 0 ? [`level-idc=${(stream.level / 30).toFixed(1)}`] : []),
    ];
    return [
      '-c:v', 'libx265', '-preset', 'medium', '-crf', '18',
      ...(profile === 'main' || profile === 'main10' ? ['-profile:v', profile] : []),
      ...pixFmtArgs, ...colorArgs,
      '-x265-params', params.join(':'),
    ];
  }

  if (codec === 'mpeg2video' || codec === 'mpeg1video') {
    return [
      '-c:v', codec, '-q:v', '2', '-g', '1000000', '-sc_threshold', '1000000000',
      '-bf', reorderDelay > 0 ? '2' : '0',
      ...(fieldOrder && codec === 'mpeg2video' ? ['-flags', '+ildct+ilme', '-top', fieldOrder === 'tff' ? '1' : '0'] : []),
      ...pixFmtArgs, ...colorArgs,
    ];
  }

  // Other codecs: best effort
  const encoder = { av1: 'libsvtav1', vp9: 'libvpx-vp9', vp8: 'libvpx' }[codec ?? ''] ?? codec;
  if (encoder == null) throw new Error('Unknown video codec');
  return [
    '-c:v', encoder,
    ...(bitrate != null ? ['-b:v', String(Math.round(bitrate * 1.5))] : []),
    ...(reorderDelay > 0 ? ['-bf', String(reorderDelay)] : []),
    ...pixFmtArgs, ...colorArgs,
  ];
}

export function getIntermediateFormat(codec: string | undefined) {
  return codec != null && fixedCodecs.has(codec) ? { format: 'mpegts', ext: 'ts' } : { format: 'matroska', ext: 'mkv' };
}

const fmt = (n: number) => n.toFixed(6);

export function getEncodePartArgs({ inputPath, streamIndex, part, startTime, frameDuration, encoderArgs, format, outPath }: {
  inputPath: string,
  streamIndex: number,
  part: Extract<PlanPart, { type: 'encode' }>,
  startTime: number,
  frameDuration: number,
  encoderArgs: string[],
  format: string,
  outPath: string,
}) {
  // ffmpeg's frame accurate seeking (-ss before -i while encoding) is not reliable, e.g. with open GOP H.264 in MPEG-TS
  // it can start at the keyframe *after* the seek time. So seek to before a keyframe preceding the part (-ss is relative to the file's
  // start time), keep the file's timestamps (-copyts) and pick the exact frames with the trim filter.
  const tol = frameDuration / 4;
  const seek = part.decodeFrom != null ? part.decodeFrom - startTime - 1 : part.from - startTime - 30;
  return [
    '-hide_banner', '-nostdin', '-y',
    '-copyts',
    '-ss', fmt(Math.max(seek, 0)),
    '-i', inputPath,
    '-map', `0:${streamIndex}`,
    ...(part.frames != null
      ? ['-vf', `trim=start=${fmt(part.from - tol)}`, '-frames:v', String(part.frames)]
      : ['-vf', `trim=start=${fmt(part.from - tol)}:end=${fmt(part.from + part.duration - tol)}`]),
    '-fps_mode', 'passthrough',
    ...encoderArgs,
    ...(part.forceIdrAt != null ? ['-force_key_frames', `expr:eq(n,${part.forceIdrAt})`, '-forced-idr', '1'] : []),
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-f', format, outPath,
  ];
}

export function getCopyPartArgs({ inputPath, streamIndex, part, startTime, frameDuration, reorderDelay, format, outPath }: {
  inputPath: string,
  streamIndex: number,
  part: Extract<PlanPart, { type: 'copy' }>,
  startTime: number,
  frameDuration: number,
  reorderDelay: number,
  format: string,
  outPath: string,
}) {
  const tol = frameDuration / 4;
  // Drop the leading B-frames of the first keyframe (they belong to the encoded head), and from the last keyframe on
  // in decode order (it and its leading B-frames belong to the encoded tail). -copyts keeps the file's timestamps so these can be compared.
  const dropExpr = [
    `lt(pts*tb\\,${fmt(part.from - tol)})`,
    ...(part.untilDts != null ? [`gte(dts*tb\\,${fmt(part.untilDts - tol)})`] : []),
  ].join('+');
  // Seeking with stream copy lands on the keyframe at or before the seek time
  const seek = Math.max(part.from - startTime - tol, 0);
  // stop reading a while after the last keyframe (its leading B-frames come after it in the file)
  const readDuration = part.duration != null ? part.duration + 10 : undefined;
  return [
    '-hide_banner', '-nostdin', '-y',
    '-copyts',
    '-ss', fmt(seek),
    ...(readDuration != null ? ['-t', fmt(readDuration)] : []),
    '-i', inputPath,
    '-map', `0:${streamIndex}`,
    '-c', 'copy',
    // With an open GOP, the first keyframe's dts leaves room for its dropped leading B-frames, which would overlap the encoded head's dts.
    // Move it to where the encoder's dts would be: pts minus the reorder delay. (setts needs `pts` too, or it sets pts to the dts)
    '-bsf:v', `noise=drop=${dropExpr},setts=pts=PTS:dts=if(lt(abs(PTS*TB-${fmt(part.from)})\\,${fmt(tol)})\\,max(DTS\\,PTS-${fmt(reorderDelay * frameDuration)}/TB)\\,DTS)`,
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-f', format, outPath,
  ];
}

export function getConcatList(files: { path: string, duration: number | undefined }[]) {
  const escape = (path: string) => path.replaceAll('\\', '/').replaceAll("'", String.raw`'\''`);
  return [
    'ffconcat version 1.0',
    ...files.flatMap(({ path, duration }) => [
      `file '${escape(path)}'`,
      ...(duration != null ? [`duration ${fmt(duration)}`] : []),
    ]),
    '',
  ].join('\n');
}

async function probePackets(runner: FfRunner, { path, streamIndex, from, to }: { path: string, streamIndex: number, from: number, to: number }) {
  // -read_intervals uses the file's own timestamps
  const stdout = await runner.ffprobe([
    '-v', 'error',
    '-read_intervals', `${fmt(Math.max(from, 0))}%${fmt(to)}`,
    '-select_streams', String(streamIndex),
    '-show_entries', 'packet=pts_time,dts_time,duration_time,flags',
    '-of', 'json', path,
  ]);
  return parsePackets(stdout);
}

export async function probeStartTime(runner: FfRunner, path: string) {
  const stdout = await runner.ffprobe(['-v', 'error', '-show_entries', 'format=start_time,duration', '-of', 'json', path]);
  const { format } = JSON.parse(stdout) as { format?: { start_time?: string, duration?: string } };
  const startTime = parseFloat(format?.start_time ?? '');
  const duration = parseFloat(format?.duration ?? '');
  return { startTime: Number.isNaN(startTime) ? 0 : startTime, duration: Number.isNaN(duration) ? undefined : duration };
}

// Read enough packets around the cut points to plan the smart render. Times are in the file's own timestamps.
export async function readPacketsForPlan(runner: FfRunner, { path, streamIndex, cutFrom, cutTo, toEnd }: {
  path: string,
  streamIndex: number,
  cutFrom: number,
  cutTo: number,
  toEnd: boolean,
}) {
  // short segment: read it all at once
  if (cutTo - cutFrom <= 60) {
    const packets = await probePackets(runner, { path, streamIndex, from: cutFrom - 12, to: cutTo + 3 });
    const hasKeyframeAfterStart = packets.some((p) => p.keyframe && p.pts >= cutFrom);
    if (hasKeyframeAfterStart || toEnd) return packets;
    // no keyframe in the segment. Find the next one anyway, in case the segment only needs a head
  }

  let startPackets: VideoPacket[] = [];
  for (const window of [10, 30, 120, 600]) {
    startPackets = await probePackets(runner, { path, streamIndex, from: cutFrom - 12, to: cutFrom + window });
    const keyframe = startPackets.find((p) => p.keyframe && p.pts >= cutFrom);
    // make sure we also have the packets that follow the keyframe in decode order
    if (keyframe != null && startPackets.some((p) => p.dts > keyframe.dts + 1)) break;
  }

  if (toEnd) return startPackets;

  let endPackets: VideoPacket[] = [];
  for (const window of [10, 30, 120, 600]) {
    endPackets = await probePackets(runner, { path, streamIndex, from: cutTo - window, to: cutTo + 3 });
    if (endPackets.some((p) => p.keyframe && p.pts <= cutTo && p.pts > cutFrom)) break;
    if (cutTo - window <= cutFrom) break;
  }
  return mergePackets(startPackets, endPackets);
}

export interface SmartRenderResult {
  plan: SmartRenderPlan,
  // pass this to ffmpeg as `-f concat -safe 0 -i <concatListPath>` to read the frame accurate video stream
  concatListPath: string,
  // where the output video's first frame is (relative to the file's start, like cutFrom). The cut start rarely falls exactly on a frame,
  // so other streams must be cut from here, not from cutFrom, to stay in sync with the video (which starts at 0 in the concat output)
  videoFrom: number,
}

// The decoded frame times of the first `duration` seconds of a file (or concat list), and whether the decoder complained about the order
async function decodeFrameTimes(runner: FfRunner, { path, duration, isConcatList }: { path: string, duration: number, isConcatList: boolean }) {
  const { stderr } = await runner.ffmpeg([
    '-hide_banner', '-nostdin', '-v', 'info',
    ...(isConcatList ? ['-f', 'concat', '-safe', '0'] : []),
    '-i', path, '-map', '0:v:0', '-t', fmt(duration), '-vf', 'showinfo', '-f', 'null', '-',
  ]);
  const times = [...stderr.matchAll(/Parsed_showinfo.*? pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  return { times, outOfOrder: /non monotonically increasing dts/.test(stderr) };
}

// True if there are enough frames, evenly spaced and in order
function isFrameSequenceOk(times: number[], frameDuration: number, expectedFrames: number) {
  if (times.length < expectedFrames) return false;
  for (let i = 1; i < times.length; i += 1) {
    const step = times[i]! - times[i - 1]!;
    if (step < frameDuration * 0.5 || step > frameDuration * 1.5) return false;
  }
  return true;
}

// MaxPicOrderCntLsb from the H.264 SPS of a file
async function getMaxPocLsb(runner: FfRunner, path: string, streamIndex: number) {
  const { stderr } = await runner.ffmpeg(['-hide_banner', '-nostdin', '-v', 'info', '-i', path, '-map', `0:${streamIndex}`, '-frames:v', '1', '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-']);
  const m = /log2_max_pic_order_cnt_lsb_minus4\s+[01]+ = (\d+)/.exec(stderr);
  return m != null ? 2 ** (Number(m[1]) + 4) : undefined;
}

// A re-encoded head followed by a copied H.264/HEVC keyframe that is not an IDR picture (open GOP recovery point):
// the decoder derives the copied picture's order count (POC) from the head's last reference picture. The head starts at
// POC 0, so depending on where the cut is, the copied keyframe's POC can come out lower than the head's frames, and the
// frames around the join are shown out of order or dropped. Starting a second IDR inside the head shifts the head's last
// POC by half of the POC range, which puts the copied keyframe on the right side. If that is not enough (or the head is
// too short for it), the head and the copied middle are encoded as one part instead (slower, but always in order).
async function fixHeadJoin({ runner, inputPath, stream, plan, files, concatListPath, frameDuration, writeFile, renderPart }: {
  runner: FfRunner,
  inputPath: string,
  stream: SmartRenderStream,
  plan: SmartRenderPlan,
  files: { path: string, duration: number | undefined }[],
  concatListPath: string,
  frameDuration: number,
  writeFile: (path: string, content: string) => Promise<void>,
  renderPart: (part: PlanPart, i: number) => Promise<{ path: string, duration: number | undefined }>,
}): Promise<{ plan: SmartRenderPlan, files: { path: string, duration: number | undefined }[] }> {
  const [head, copy] = plan.parts;
  if (head?.type !== 'encode' || copy?.type !== 'copy' || (stream.codec_name !== 'h264' && stream.codec_name !== 'hevc')) return { plan, files };

  const headFrames = head.frames ?? Math.round(head.duration / frameDuration);
  // decode the head and a couple of seconds of the copied part
  const checkDuration = head.duration + 2;
  const isJoinOk = async () => {
    const { times, outOfOrder } = await decodeFrameTimes(runner, { path: concatListPath, duration: checkDuration, isConcatList: true });
    return !outOfOrder && isFrameSequenceOk(times, frameDuration, headFrames + 1);
  };

  if (await isJoinOk()) return { plan, files };

  const maxPocLsb = stream.codec_name === 'h264' ? await getMaxPocLsb(runner, inputPath, stream.index) : undefined;
  // POC advances by 2 per frame, so this many frames is half the POC range
  const halfRangeFrames = maxPocLsb != null ? maxPocLsb / 4 : undefined;
  const candidates = halfRangeFrames != null ? [halfRangeFrames, halfRangeFrames - 2, halfRangeFrames + 2].filter((n) => n >= 1 && n < headFrames) : [];
  for (const forceIdrAt of candidates) {
    console.log('Smart render: head/copy join out of order, retrying with an IDR at head frame', forceIdrAt);
    // eslint-disable-next-line no-await-in-loop
    const newFiles = [await renderPart({ ...head, forceIdrAt }, 0), ...files.slice(1)];
    // eslint-disable-next-line no-await-in-loop
    await writeFile(concatListPath, getConcatList(newFiles));
    // eslint-disable-next-line no-await-in-loop
    if (await isJoinOk()) return { plan: { ...plan, parts: [{ ...head, forceIdrAt }, ...plan.parts.slice(1)] }, files: newFiles };
  }

  console.warn('Smart render: cannot join the head to the copied part in order, encoding them as one part');
  const merged: PlanPart = { type: 'encode', from: head.from, frames: undefined, duration: copy.duration != null ? head.duration + copy.duration : 1e9, decodeFrom: head.decodeFrom };
  // the parts after the copied one keep their files, only the list changes
  const newFiles = [await renderPart(merged, 0), ...files.slice(2)];
  await writeFile(concatListPath, getConcatList(newFiles));
  return { plan: { parts: [merged, ...plan.parts.slice(2)], joins: plan.joins.slice(1), duration: plan.duration }, files: newFiles };
}

// Produce the video stream of [cutFrom, cutTo) (relative to the file's start, like ffmpeg's -ss), frame accurately.
export async function smartRenderVideo({ runner, inputPath, stream, cutFrom, cutTo, toEnd, outPathPrefix, tempFiles, writeFile, bitrate, onPart }: {
  runner: FfRunner,
  inputPath: string,
  stream: SmartRenderStream,
  cutFrom: number,
  cutTo: number,
  toEnd: boolean,
  // temp files will be named <outPathPrefix>-<n>.<ext>
  outPathPrefix: string,
  // the temporary files are added here as they are created, for the caller to delete when done (also on failure)
  tempFiles: string[],
  writeFile: (path: string, content: string) => Promise<void>,
  bitrate?: number | undefined,
  onPart?: (index: number, count: number) => void,
}): Promise<SmartRenderResult> {
  const frameDuration = getFrameDuration(stream);
  if (frameDuration == null) throw new Error('Smart render needs a known frame rate');

  const { startTime } = await probeStartTime(runner, inputPath);
  const absFrom = cutFrom + startTime;
  const absTo = cutTo + startTime;

  const packets = await readPacketsForPlan(runner, { path: inputPath, streamIndex: stream.index, cutFrom: absFrom, cutTo: absTo, toEnd });
  const plan = planSmartRender({ packets, cutFrom: absFrom, cutTo: absTo, frameDuration, toEnd });
  console.log('Smart render plan', plan);

  const { format, ext } = getIntermediateFormat(stream.codec_name);
  const encoderArgs = getEncoderArgs(stream, { bitrate });

  const concatListPath = `${outPathPrefix}-list.txt`;
  tempFiles.push(concatListPath);

  const renderPart = async (part: PlanPart, i: number) => {
    const outPath = `${outPathPrefix}-${i}.${ext}`;
    if (!tempFiles.includes(outPath)) tempFiles.push(outPath);
    const args = part.type === 'encode'
      ? getEncodePartArgs({ inputPath, streamIndex: stream.index, part, startTime, frameDuration, encoderArgs, format, outPath })
      : getCopyPartArgs({ inputPath, streamIndex: stream.index, part, startTime, frameDuration, reorderDelay: stream.has_b_frames ?? 0, format, outPath });
    await runner.ffmpeg(args);
    return { path: outPath, duration: part.duration };
  };

  const files: { path: string, duration: number | undefined }[] = [];
  for (const [i, part] of plan.parts.entries()) {
    onPart?.(i, plan.parts.length);
    files.push(await renderPart(part, i));
  }
  await writeFile(concatListPath, getConcatList(files));

  const { plan: finalPlan } = await fixHeadJoin({ runner, inputPath, stream, plan, files, concatListPath, frameDuration, writeFile, renderPart });

  return { plan: finalPlan, concatListPath, videoFrom: finalPlan.parts[0]!.from - startTime };
}

// Decoder messages that also show up when a plain keyframe cut starts on an open GOP I-frame (memory management
// operations that refer to pictures from before the cut). The decoded pictures are still correct.
const harmlessDecodeMessages = [/mmco: unref short failure/];

export function getDecodeErrors(stderr: string) {
  return stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('Last message repeated') && !harmlessDecodeMessages.some((re) => re.test(line)));
}

// Check the joins of a smart rendered output file: no missing or duplicate frames, and no decoding errors.
// Returns a list of problems (empty if all is good).
export async function verifySmartRender({ runner, outPath, videoStreamIndex, plan, frameDuration }: {
  runner: FfRunner,
  outPath: string,
  videoStreamIndex: number,
  plan: SmartRenderPlan,
  frameDuration: number,
}) {
  const problems: string[] = [];
  const { startTime } = await probeStartTime(runner, outPath);

  for (const join of plan.joins) {
    const at = startTime + join;
    const packets = await probePackets(runner, { path: outPath, streamIndex: videoStreamIndex, from: at - 2, to: at + 2 });
    const near = packets.filter((p) => Math.abs(p.pts - at) <= frameDuration * 6);
    const times = near.map((p) => p.pts).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i]! - times[i - 1]!;
      if (gap > frameDuration * 1.5) problems.push(`Missing frame(s) near ${join.toFixed(3)}s`);
      if (gap < frameDuration * 0.5) problems.push(`Duplicate frame near ${join.toFixed(3)}s`);
    }
    // packets are in file (decode) order
    const withDts = near.filter((p) => p.dtsKnown !== false);
    if (withDts.some((p, i) => i > 0 && p.dts <= withDts[i - 1]!.dts)) problems.push(`Decode timestamps go backwards near ${join.toFixed(3)}s`);

    // Decode across the join, but only from the start of the file: seeking into an open GOP gives harmless errors
    // for its leading B-frames that we can't tell apart from real ones.
    if (join <= 15) {
      const { stderr } = await runner.ffmpeg([
        '-hide_banner', '-nostdin', '-v', 'error',
        '-i', outPath, '-t', fmt(join + 2),
        '-map', `0:${videoStreamIndex}`, '-f', 'null', '-',
      ]);
      const errors = getDecodeErrors(stderr);
      if (errors.length > 0) problems.push(`Decoding errors near ${join.toFixed(3)}s: ${errors[0]}`);
    }
  }

  if (plan.duration != null) {
    const { duration: outDuration } = await probeStartTime(runner, outPath);
    // the container duration can include audio, so only flag clearly wrong lengths
    if (outDuration != null && Math.abs(outDuration - plan.duration) > Math.max(frameDuration * 3, 0.2)) {
      problems.push(`Output is ${outDuration.toFixed(3)}s long, expected ${plan.duration.toFixed(3)}s`);
    }
  }

  return [...new Set(problems)];
}
