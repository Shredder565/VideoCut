// Exporting the clips (segments) of one input file, either as separate files or merged into one.
//
// Two modes:
// - 'smart': frame accurate. The first selected video stream is smart rendered (only the frames around the cut points are
//   re-encoded, see smartRender.ts). The other selected streams (audio, subtitles) are stream copied, starting where the
//   video's first frame actually is, and muxed with the video. Merged exports go through the joiner (smartJoin.ts).
// - 'keyframe': fast. Everything is stream copied from the keyframe at or before the clip start, so the output can start a
//   little early (the leading frames of an open GOP keyframe, which can't be decoded, are left out).
// Without a selected video stream, both modes stream copy the clip with an accurate seek (to the audio packet).
//
// Output files are never overwritten: an existing name gets " (2)", " (3)", ... appended.
// Temporary files go next to the outputs and are removed when done, also on failure or cancel.
//
// Like smartRender.ts this module only imports the engine modules, so it can be driven by a plain Node.js script (see test-manual/exporter).

import { getConcatList, getFrameDuration, parsePackets, probeStartTime, smartRenderVideo, verifySmartRender, type FfRunner, type SmartRenderStream } from './smartRender.ts';
import { planJoin, runJoin, withReliableIntervals, type JoinRunner } from './smartJoin.ts';

export interface ExportClip {
  // seconds relative to the file start (ffmpeg -ss style)
  start: number,
  end: number,
  name?: string | undefined,
}

export interface ExportRequest {
  // `duration`: duration of the file
  input: { path: string, duration: number },
  // in output order
  clips: ExportClip[],
  // absolute ffprobe stream indexes to keep (any mix of video/audio/subtitle)
  streamIndexes: number[],
  outDir: string,
  // input file name without extension
  baseName: string,
  // ffmpeg muxer + extension, e.g. { format: 'mp4', ext: '.mp4' }, { format: 'matroska', ext: '.mkv' }, { format: 'mpegts', ext: '.ts' }
  container: { format: string, ext: string },
  // smart: frame accurate (smart render); keyframe: fast stream copy from the keyframe at/before the start
  mode: 'smart' | 'keyframe',
  // true: one output file with all clips joined
  merge: boolean,
}

export interface ExportResult {
  outputPaths: string[],
  warnings: string[],
}

export type ExportRunner = JoinRunner & {
  exists: (path: string) => Promise<boolean>,
};

// The subset of ffprobe's stream info used here
interface ProbeStream extends SmartRenderStream {
  codec_type?: string | undefined,
  disposition?: Record<string, number | undefined> | undefined,
  tags?: Record<string, string | undefined> | undefined,
}

interface ProbeResult {
  streams: ProbeStream[],
  formatTags: Record<string, string | undefined>,
  bitrate: number | undefined,
}

const fmt = (n: number) => n.toFixed(6);

// --- naming ---

// Characters Windows doesn't allow in file names (and control characters)
// eslint-disable-next-line no-control-regex
const invalidFileNameChars = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeFileName(name: string) {
  // Windows also drops trailing dots and spaces
  return name.replaceAll(invalidFileNameChars, '_').replace(/[. ]+$/, '').trim();
}

function joinPath(dir: string, name: string) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

const normalizeExt = (ext: string) => (ext === '' || ext.startsWith('.') ? ext : `.${ext}`);

// The output path of a clip (separate files) or of the merged file. It doesn't check whether the file exists, see getUniqueOutputPath.
// Separate: "<baseName> - clip <n>[ - <name>]<ext>", n is 1-based and zero padded (at least 2 digits) when there are 10 or more clips.
// Merged: "<baseName> - cut<ext>".
export function getOutputPath({ outDir, baseName, ext, merge, clipIndex = 0, clipCount = 1, clipName }: {
  outDir: string,
  baseName: string,
  ext: string,
  merge: boolean,
  // 0-based
  clipIndex?: number | undefined,
  clipCount?: number | undefined,
  clipName?: string | undefined,
}) {
  const base = sanitizeFileName(baseName) || 'output';
  if (merge) return joinPath(outDir, `${base} - cut${normalizeExt(ext)}`);
  const digits = clipCount >= 10 ? Math.max(2, String(clipCount).length) : 1;
  const n = String(clipIndex + 1).padStart(digits, '0');
  const name = clipName != null ? sanitizeFileName(clipName) : '';
  return joinPath(outDir, `${base} - clip ${n}${name !== '' ? ` - ${name}` : ''}${normalizeExt(ext)}`);
}

// `path`, or "<name> (2)<ext>", "<name> (3)<ext>"... if it exists (or is in `reserved`, case insensitive like Windows)
export async function getUniqueOutputPath(exists: (path: string) => Promise<boolean>, path: string, reserved: Iterable<string> = []) {
  const taken = new Set([...reserved].map((p) => p.toLowerCase()));
  const m = /^(.*?)(\.[^./\\]*)?$/.exec(path);
  const stem = m?.[1] ?? path;
  const ext = m?.[2] ?? '';
  for (let i = 1; i < 10000; i += 1) {
    const candidate = i === 1 ? path : `${stem} (${i})${ext}`;
    // eslint-disable-next-line no-await-in-loop
    if (!taken.has(candidate.toLowerCase()) && !(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free file name for ${path}`);
}

// --- stream selection ---

const movSubtitles = new Set(['mov_text']);
// subtitle codecs each muxer can take with stream copy. Formats not listed: let ffmpeg decide
const subtitleCodecsByFormat: Record<string, Set<string>> = {
  mp4: movSubtitles,
  mov: movSubtitles,
  ipod: movSubtitles,
  matroska: new Set(['subrip', 'ass', 'ssa', 'webvtt', 'dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle']),
  webm: new Set(['webvtt']),
  mpegts: new Set(['dvb_subtitle', 'dvb_teletext']),
};

const isMainVideo = (s: ProbeStream) => s.codec_type === 'video' && !s.disposition?.['attached_pic'];

function describeStream(s: ProbeStream) {
  const lang = s.tags?.['language'];
  return `stream #${s.index} (${s.codec_type ?? '?'} ${s.codec_name ?? '?'}${lang != null && lang !== 'und' ? `, ${lang}` : ''})`;
}

// Split the requested streams into the video stream to smart render (the first selected one) and the rest,
// leaving out (with a warning) those that can't be stream copied into the container.
export function selectStreams(streams: ProbeStream[], streamIndexes: number[], format: string) {
  const warnings: string[] = [];
  const kept: ProbeStream[] = [];
  for (const index of [...new Set(streamIndexes)]) {
    const s = streams.find((st) => st.index === index);
    if (s == null) {
      warnings.push(`Stream #${index} doesn't exist in the file, skipped`);
      continue;
    }
    if (s.codec_type === 'subtitle') {
      const allowed = subtitleCodecsByFormat[format];
      if (allowed != null && !allowed.has(s.codec_name ?? '')) {
        warnings.push(`${describeStream(s)} can't be copied into ${format}, skipped`);
        continue;
      }
    } else if (s.codec_type === 'video' && !isMainVideo(s)) {
      warnings.push(`${describeStream(s)} is a cover picture, skipped`);
      continue;
    } else if (s.codec_type !== 'video' && s.codec_type !== 'audio') {
      warnings.push(`${describeStream(s)} is a ${s.codec_type ?? 'unknown'} stream, skipped`);
      continue;
    }
    kept.push(s);
  }
  const video = kept.find((s) => isMainVideo(s));
  const others = kept.filter((s) => s !== video);
  return { video, others, warnings };
}

async function probeInput(runner: ExportRunner, path: string): Promise<ProbeResult> {
  const stdout = await runner.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  const { streams = [], format = {} } = JSON.parse(stdout) as { streams?: ProbeStream[], format?: { bit_rate?: string, tags?: Record<string, string> } };
  const bitrate = parseInt(format.bit_rate ?? '', 10);
  return { streams, formatTags: format.tags ?? {}, bitrate: bitrate > 0 ? bitrate : undefined };
}

// global tags that describe the old file rather than its content
const technicalTags = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'duration', 'creation_time']);

// -metadata arguments that carry the input's global tags (title etc.) and the video stream's language/title and dispositions
// over to an output whose video comes from the concat demuxer (which has none of them)
function getMetadataArgs(probe: ProbeResult, video: ProbeStream | undefined) {
  const args: string[] = [];
  for (const [key, value] of Object.entries(probe.formatTags)) {
    if (value != null && !technicalTags.has(key.toLowerCase())) args.push('-metadata', `${key}=${value}`);
  }
  if (video != null) {
    for (const key of ['language', 'title']) {
      const value = video.tags?.[key];
      if (value != null && value !== '') args.push('-metadata:s:v:0', `${key}=${value}`);
    }
    const flags = Object.entries(video.disposition ?? {}).filter(([k, v]) => v === 1 && k !== 'attached_pic').map(([k]) => k);
    args.push('-disposition:v:0', flags.length > 0 ? flags.join('+') : '0');
  }
  return args;
}

// MPEG-TS/PS muxers start the timestamps at 1.4 s by default. Intermediate files must start where the timestamps say.
const noMuxDelay = ['-muxdelay', '0', '-muxpreload', '0'];

const movFormats = new Set(['mp4', 'mov', 'ipod', 'ismv', '3gp', '3g2', 'f4v', 'psp']);
// Muxer options for the output format. MP4/MOV store a stream's start offset (e.g. audio that starts a few ms after the
// video) as an edit list in the movie timescale, which is 1/1000 s by default: that alone shifts the audio by up to 1 ms.
function getMuxerArgs(format: string) {
  return movFormats.has(format) ? ['-movie_timescale', '90000'] : [];
}

// Stream copy [from, from + duration) of some streams with an accurate two-step seek: the input seek lands on a keyframe
// (or packet) before `from`, and the output seek drops the packets before `from`. Output timestamps start at `from`, so a
// packet that starts a bit after `from` keeps its offset (that is what keeps audio in sync with a video starting at `from`).
// The output seek compares decode timestamps, and stream copy starts the video with a keyframe: with video, the video
// starts with the first keyframe whose dts is at or after `from`. `dropVideoBefore` (seconds from `from`) drops the video
// packets shown before that (leading frames of an open GOP keyframe, which can't be decoded without the previous GOP).
// `from` null: from the start of the file, keeping everything (also packets with negative timestamps)
function getAccurateCopyArgs({ inputPath, streams, from, duration, format, outPath, dropVideoBefore }: {
  inputPath: string,
  streams: ProbeStream[],
  from: number | null,
  duration: number | undefined,
  format: string,
  outPath: string,
  dropVideoBefore?: number | undefined,
}) {
  const pre = Math.max(0, (from ?? 0) - 10);
  return [
    '-hide_banner', '-nostdin', '-y',
    ...(pre > 0 ? ['-ss', fmt(pre)] : []),
    '-i', inputPath,
    ...(from != null ? ['-ss', fmt(from - pre)] : []),
    ...(duration != null ? ['-t', fmt(duration)] : []),
    ...streams.flatMap((s) => ['-map', `0:${s.index}`]),
    '-c', 'copy',
    ...(dropVideoBefore != null && dropVideoBefore > 0 ? ['-bsf:v', `noise=drop=lt(pts*tb\\,${fmt(dropVideoBefore)})`] : []),
    // (B-frame video starts with a negative decode timestamp: then shift all streams alike. make_zero would also remove
    // the offset of audio that starts a bit after `from`)
    '-avoid_negative_ts', 'make_non_negative',
    '-map_chapters', '-1',
    ...noMuxDelay, ...getMuxerArgs(format),
    '-f', format, outPath,
  ];
}

// The last keyframe at or before `at` (file's own timestamps), undefined if there is none
async function findKeyframeAtOrBefore(runner: FfRunner, { path, streamIndex, at, frameDuration }: { path: string, streamIndex: number, at: number, frameDuration: number }) {
  const tol = frameDuration / 4;
  for (const window of [15, 60, 300, Infinity]) {
    const from = Math.max(0, at - window);
    // eslint-disable-next-line no-await-in-loop
    const stdout = await runner.ffprobe([
      '-v', 'error',
      '-read_intervals', `${fmt(from)}%${fmt(at + 1)}`,
      '-select_streams', String(streamIndex),
      '-show_entries', 'packet=pts_time,dts_time,duration_time,flags',
      '-of', 'json', path,
    ]);
    const keyframes = parsePackets(stdout).filter((p) => p.keyframe && p.pts <= at + tol);
    if (keyframes.length > 0) return keyframes.reduce((a, b) => (b.pts > a.pts ? b : a));
    if (from === 0) break;
  }
  return undefined;
}

function getConcatCopyArgs({ listPath, format, outPath }: { listPath: string, format: string, outPath: string }) {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-map', '0', '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-map_chapters', '-1',
    ...getMuxerArgs(format),
    '-f', format, outPath,
  ];
}

const abortError = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error('Export was cancelled'));

// A runner that refuses to start ffmpeg/ffprobe once the export is cancelled, so long multi-step operations
// (smart render, join) stop at the next step even if the caller's runner doesn't kill the running process.
function guardRunner(runner: ExportRunner, signal: AbortSignal | undefined): ExportRunner {
  const check = () => {
    if (signal?.aborted) throw abortError(signal);
  };
  return {
    ffprobe: async (args) => {
      check();
      return runner.ffprobe(args);
    },
    ffmpeg: async (args) => {
      check();
      return runner.ffmpeg(args);
    },
    writeFile: async (path, content) => {
      check();
      return runner.writeFile(path, content);
    },
    removeFile: async (path) => runner.removeFile(path),
    exists: async (path) => runner.exists(path),
  };
}

export async function exportClips({ runner: rawRunner, request, onProgress, signal }: {
  runner: ExportRunner,
  request: ExportRequest,
  onProgress?: ((progress: number, stage: string) => void) | undefined,
  signal?: AbortSignal | undefined,
}): Promise<ExportResult> {
  const runner = withReliableIntervals(guardRunner(rawRunner, signal));
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError(signal);
  };
  const { input, outDir, baseName, container, mode, merge } = request;
  const ext = normalizeExt(container.ext);
  const { format } = container;
  const clips = request.clips.map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(c.end, input.duration) }));
  if (clips.length === 0) throw new Error('No clips to export');
  const badClip = clips.findIndex((c) => !(c.end > c.start));
  if (badClip !== -1) throw new Error(`Clip ${badClip + 1} is empty`);

  const warnings: string[] = [];
  const outputPaths: string[] = [];
  const tempFiles: string[] = [];
  const tempPrefix = joinPath(outDir, `.videocut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const temp = (name: string) => {
    const path = `${tempPrefix}-${name}`;
    tempFiles.push(path);
    return path;
  };
  // the output being written, removed if the export fails
  let writing: string | undefined;

  // progress: clip durations as weights, `fraction` is the progress within the current clip
  const total = clips.reduce((sum, c) => sum + (c.end - c.start), 0) + (merge ? 0.05 * clips.reduce((sum, c) => sum + (c.end - c.start), 0) : 0);
  let done = 0;
  const report = (stage: string, weight = 0, fraction = 0) => onProgress?.(Math.min(1, (done + weight * fraction) / total), stage);

  const probe = await probeInput(runner, input.path);
  const selection = selectStreams(probe.streams, request.streamIndexes, format);
  warnings.push(...selection.warnings);
  const { video, others } = selection;
  if (video == null && others.length === 0) throw new Error('No streams to export');
  const frameDuration = video != null ? getFrameDuration(video) : undefined;
  if (mode === 'smart' && video != null && frameDuration == null) throw new Error('Frame accurate export needs a video stream with a known frame rate');
  const allStreams = video != null ? [video, ...others] : others;
  // a clip that ends within half a frame of the file's end goes to the end (no tail to re-encode, nothing cut off)
  const isToEnd = (clip: ExportClip) => clip.end >= input.duration - (frameDuration ?? 0.001) / 2;
  const bitrate = (() => {
    const b = parseInt(video?.bit_rate ?? '', 10);
    return b > 0 ? b : probe.bitrate;
  })();

  const reserved: string[] = [];
  const pickOutputPath = async (path: string) => {
    const unique = await getUniqueOutputPath(runner.exists, path, reserved);
    reserved.push(unique);
    return unique;
  };

  // Frame accurate export of one clip with video into `outPath`
  const smartClip = async (clip: ExportClip, k: number, outPath: string, weight: number) => {
    const v = video!;
    const fd = frameDuration!;
    const label = `Clip ${k + 1}`;
    const toEnd = isToEnd(clip);
    const rendered = await smartRenderVideo({
      runner,
      inputPath: input.path,
      stream: v,
      cutFrom: clip.start,
      cutTo: toEnd ? input.duration : clip.end,
      toEnd,
      outPathPrefix: `${tempPrefix}-${k}-video`,
      tempFiles,
      writeFile: runner.writeFile,
      bitrate,
      onPart: (i, count) => report(`${label}: smart render part ${i + 1}/${count}`, weight, (0.7 * i) / Math.max(count, 1)),
    });
    const { plan, concatListPath, videoFrom } = rendered;
    throwIfAborted();

    // The other streams, from where the video's first frame is (not the clip start), for as long as the video
    let othersPath: string | undefined;
    if (others.length > 0) {
      report(`${label}: copying ${others.length} other stream(s)`, weight, 0.75);
      othersPath = temp(`${k}-other${ext}`);
      const duration = plan.duration ?? (toEnd ? undefined : clip.end - videoFrom);
      await runner.ffmpeg(getAccurateCopyArgs({ inputPath: input.path, streams: others, from: videoFrom, duration, format, outPath: othersPath }));
    }

    throwIfAborted();
    report(`${label}: muxing`, weight, 0.85);
    writing = outPath;
    // -copyts: keep the other streams' offsets from the video (which starts at 0 in the concat output)
    await runner.ffmpeg([
      '-hide_banner', '-nostdin', '-y', '-copyts',
      '-f', 'concat', '-safe', '0', '-i', concatListPath,
      ...(othersPath != null ? ['-i', othersPath] : []),
      '-map', '0:v:0', ...(othersPath != null ? ['-map', '1'] : []),
      '-c', 'copy',
      '-map_chapters', '-1',
      ...getMetadataArgs(probe, v),
      ...getMuxerArgs(format),
      '-f', format, outPath,
    ]);
    writing = undefined;

    throwIfAborted();
    report(`${label}: verifying`, weight, 0.92);
    const problems = await verifySmartRender({ runner, outPath, videoStreamIndex: 0, plan, frameDuration: fd });
    warnings.push(...problems.map((p) => `${label}: ${p}`));
  };

  // Stream copy of one clip into `outPath`. With video: from the keyframe at or before the clip start. (ffmpeg's own -ss
  // seeking with stream copy can land on the keyframe *after* it, so the keyframe is looked up first, and the copy starts
  // at its decode timestamp.) Without video: from the clip start, with an accurate seek.
  const copyClip = async (clip: ExportClip, outPath: string) => {
    let from: number | null = clip.start;
    let dropVideoBefore: number | undefined;
    if (video != null) {
      const tol = (frameDuration ?? 0.04) / 4;
      const { startTime } = await probeStartTime(runner, input.path);
      const keyframe = await findKeyframeAtOrBefore(runner, { path: input.path, streamIndex: video.index, at: clip.start + startTime, frameDuration: frameDuration ?? 0.04 });
      const keyFrom = keyframe != null ? Math.min(keyframe.dts, keyframe.pts) - startTime - tol : 0;
      if (keyframe != null && keyFrom > 0) {
        from = keyFrom;
        dropVideoBefore = keyframe.pts - startTime - keyFrom - tol;
      } else {
        // the first keyframe of the file (its dts can be negative, which an output seek would drop)
        from = null;
      }
    }
    const duration = isToEnd(clip) ? undefined : clip.end - (from ?? 0);
    await runner.ffmpeg(getAccurateCopyArgs({ inputPath: input.path, streams: allStreams, from, duration, format, outPath, dropVideoBefore }));
  };

  try {
    if (!merge) {
      for (const [k, clip] of clips.entries()) {
        throwIfAborted();
        const weight = clip.end - clip.start;
        const outPath = await pickOutputPath(getOutputPath({ outDir, baseName, ext, merge: false, clipIndex: k, clipCount: clips.length, clipName: clip.name }));
        if (mode === 'smart' && video != null) {
          // eslint-disable-next-line no-await-in-loop
          await smartClip(clip, k, outPath, weight);
        } else {
          report(`Clip ${k + 1}: copying`, weight, 0);
          writing = outPath;
          // eslint-disable-next-line no-await-in-loop
          await copyClip(clip, outPath);
          writing = undefined;
        }
        outputPaths.push(outPath);
        done += weight;
        report(`Clip ${k + 1} done`);
      }
    } else if (mode === 'smart' && video != null) {
      // The joiner smart renders every clip and joins them with the first video and the first audio stream of the file
      const outPath = await pickOutputPath(getOutputPath({ outDir, baseName, ext, merge: true }));
      const firstAudio = probe.streams.find((s) => s.codec_type === 'audio');
      const keptAudio = others.find((s) => s.codec_type === 'audio');
      const wantAudio = keptAudio != null;
      const firstVideo = probe.streams.find((s) => isMainVideo(s));
      if (firstVideo != null && firstVideo.index !== video.index) warnings.push(`Merged frame accurate export uses the first video stream (#${firstVideo.index}) instead of #${video.index}`);
      if (keptAudio != null && firstAudio != null && keptAudio.index !== firstAudio.index) {
        warnings.push(`Merged frame accurate export uses the first audio stream (#${firstAudio.index}) instead of #${keptAudio.index}`);
      }
      for (const s of others.filter((o) => o !== keptAudio)) warnings.push(`${describeStream(s)} dropped: merged frame accurate export keeps only one video and one audio stream`);
      // the joiner always takes the file's audio; if no audio was selected, remove it afterwards
      const dropAudio = !wantAudio && firstAudio != null;
      const joinOut = dropAudio ? temp(`joined${ext}`) : outPath;

      report('Planning');
      const plan = await planJoin({
        runner,
        inputs: clips.map((c) => ({ path: input.path, cutFrom: c.start, cutTo: isToEnd(c) ? undefined : c.end })),
      });
      throwIfAborted();
      writing = joinOut;
      const result = await runJoin({
        runner,
        plan,
        outPath: joinOut,
        tempDir: outDir,
        onProgress: (p, stage) => onProgress?.(Math.min(1, p * (dropAudio ? 0.95 : 1)), stage),
        signal,
      });
      warnings.push(...result.warnings, ...result.problems);
      if (dropAudio) {
        throwIfAborted();
        report('Removing audio', total, 0.96);
        writing = outPath;
        await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-i', joinOut, '-map', '0:v:0', '-c', 'copy', '-map_chapters', '-1', '-f', format, outPath]);
      }
      writing = undefined;
      outputPaths.push(outPath);
      done = total;
    } else {
      // Every clip to a temporary file in the output container, then joined with the concat demuxer (stream copy)
      const outPath = await pickOutputPath(getOutputPath({ outDir, baseName, ext, merge: true }));
      const parts: { path: string, duration: undefined }[] = [];
      for (const [k, clip] of clips.entries()) {
        throwIfAborted();
        const weight = clip.end - clip.start;
        report(`Clip ${k + 1}: copying`, weight, 0);
        const partPath = temp(`${k}-part${ext}`);
        // eslint-disable-next-line no-await-in-loop
        await copyClip(clip, partPath);
        parts.push({ path: partPath, duration: undefined });
        done += weight;
      }
      throwIfAborted();
      report('Joining');
      const listPath = temp('list.txt');
      await runner.writeFile(listPath, getConcatList(parts));
      writing = outPath;
      await runner.ffmpeg(getConcatCopyArgs({ listPath, format, outPath }));
      writing = undefined;
      outputPaths.push(outPath);
      done = total;
    }
    onProgress?.(1, 'Done');
    return { outputPaths, warnings };
  } catch (err) {
    if (writing != null) await rawRunner.removeFile(writing).catch(() => undefined);
    throw err;
  } finally {
    for (const path of tempFiles) {
      // eslint-disable-next-line no-await-in-loop
      await rawRunner.removeFile(path).catch(() => undefined);
    }
  }
}
