// End-to-end test of the exporter (src/engine/exporter.ts) on generated sample files.
//
// Every frame carries its own frame number as a bit pattern (40 px wide columns, white = bit set, lowest bit on the left),
// and the audio has a short 1 kHz beep starting exactly on every 25th frame. Exported files are decoded to check:
// - smart (frame accurate) exports have exactly the requested frames, and every beep is where it was relative to
//   the frames (within 1 ms), also in MPEG-TS outputs and in merged outputs
// - keyframe exports decode and start at or before the requested frame; merged keyframe exports add up
// - stream selection, subtitle handling, output naming (no overwriting) and cancelling
//
// Usage: node test-manual/exporter/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]

import { execFile } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { exportClips, getOutputPath, sanitizeFileName, type ExportClip, type ExportRequest, type ExportRunner } from '../../src/engine/exporter.ts';

const execFileAsync = promisify(execFile);

const [ffDirArg, workDirArg, filter] = process.argv.slice(2);
if (ffDirArg == null || workDirArg == null || workDirArg.trim() === '') throw new Error('Usage: run.ts <ffmpeg dir> <work dir> [filter]');
const ffDir = resolve(ffDirArg);
const workDir = resolve(workDirArg);
const repoDir = resolve(import.meta.dirname, '..', '..');
if (workDir === repoDir || workDir.startsWith(repoDir + sep)) throw new Error('The work dir must be outside the repository');
const exe = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = join(ffDir, `ffmpeg${exe}`);
const ffprobePath = join(ffDir, `ffprobe${exe}`);

const maxBuffer = 1024 * 1024 * 1024;
let ffmpegCalls = 0;
const runner: ExportRunner = {
  ffprobe: async (args) => (await execFileAsync(ffprobePath, args, { maxBuffer, encoding: 'utf8' })).stdout,
  ffmpeg: async (args) => {
    ffmpegCalls += 1;
    const { stderr } = await execFileAsync(ffmpegPath, args, { maxBuffer, encoding: 'utf8' });
    return { stderr };
  },
  writeFile: async (path, content) => writeFile(path, content),
  removeFile: async (path) => rm(path, { force: true }),
  exists: async (path) => access(path).then(() => true, () => false),
};
const ffmpegRaw = async (args: string[]) => (await execFileAsync(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { maxBuffer, encoding: 'buffer' })).stdout;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ffprobeJson = async (args: string[]): Promise<any> => JSON.parse((await execFileAsync(ffprobePath, ['-v', 'error', '-of', 'json', ...args], { maxBuffer, encoding: 'utf8' })).stdout);

const beepEvery = 25; // frames
const beepDuration = 0.04;
const columnWidth = 40;

interface Source {
  file: string,
  size: [number, number],
  fps: [number, number],
  duration: number,
  // encoding args; the generated inputs are 0: video, 1: beeps, 2: 440 Hz tone, 3: subtitles
  args: string[],
  audioOnly?: boolean,
}

const sources: Record<string, Source> = {
  h264: {
    file: 'h264.mp4',
    size: [640, 360],
    fps: [25, 1],
    duration: 20,
    args: ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50', '-bf', '3', '-c:a', 'aac', '-b:a', '192k'],
  },
  mpeg2: {
    file: 'mpeg2.ts',
    size: [720, 480],
    fps: [30000, 1001],
    duration: 20,
    args: ['-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg2video', '-b:v', '6M', '-g', '15', '-bf', '2', '-flags', '+ildct+ilme', '-top', '1', '-c:a:0', 'ac3', '-b:a:0', '384k', '-c:a:1', 'mp2', '-b:a:1', '192k', '-metadata:s:a:1', 'language=deu'],
  },
  hevc: {
    file: 'hevc.mkv',
    size: [640, 360],
    fps: [24, 1],
    duration: 20,
    args: ['-map', '0:v', '-map', '1:a', '-map', '3:s', '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'keyint=48:open-gop=1:log-level=error', '-c:a', 'aac', '-b:a', '192k', '-c:s', 'srt'],
  },
  m4a: {
    file: 'audio.m4a',
    size: [640, 360],
    fps: [25, 1],
    duration: 20,
    args: ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k'],
    audioOnly: true,
  },
};

async function generate(s: Source, path: string) {
  const [w, h] = s.size;
  const fps = `${s.fps[0]}/${s.fps[1]}`;
  const fpsNum = s.fps[0] / s.fps[1];
  const bits = w / columnWidth;
  // draw the pattern at one pixel per bit and scale it up (much faster than geq at full size)
  const video = `color=black:size=${bits}x2:rate=${fps}:d=${s.duration},format=gray,geq=lum='16+219*mod(floor(N/pow(2\\,X))\\,2)',scale=${w}:${h}:flags=neighbor,format=yuv420p`;
  const beep = `aevalsrc='if(lt(t-floor(t*${fpsNum}/${beepEvery})*${beepEvery}/${fpsNum}\\,${beepDuration})\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:c=stereo:d=${s.duration}`;
  const tone = `sine=frequency=440:sample_rate=48000:duration=${s.duration}`;
  const srtPath = join(workDir, 'subs.srt');
  const ts = (t: number) => `00:00:${String(Math.floor(t)).padStart(2, '0')},${String(Math.round((t % 1) * 1000)).padStart(3, '0')}`;
  await writeFile(srtPath, Array.from({ length: Math.floor(s.duration / 2) }, (_v, i) => `${i + 1}\n${ts(i * 2 + 0.5)} --> ${ts(i * 2 + 1.5)}\nLine ${i + 1}\n`).join('\n'));
  await ffmpegRaw([
    '-y', '-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', beep, '-f', 'lavfi', '-i', tone, '-i', srtPath,
    ...s.args, '-t', String(s.duration), path,
  ]);
}

interface Decoded { numbers: number[], times: number[] }

async function decodeVideo(path: string, [w, h]: [number, number]): Promise<Decoded> {
  const raw = await ffmpegRaw(['-i', path, '-map', '0:v:0', '-vf', 'format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const frameSize = w * h;
  const bits = w / columnWidth;
  const numbers: number[] = [];
  for (let off = 0; off + frameSize <= raw.length; off += frameSize) {
    let n = 0;
    for (let b = 0; b < bits; b += 1) {
      let sum = 0;
      let count = 0;
      for (let y = h / 2 - 8; y < h / 2 + 8; y += 1) {
        for (let x = b * columnWidth + 12; x < (b + 1) * columnWidth - 12; x += 1) {
          sum += raw[off + y * w + x]!;
          count += 1;
        }
      }
      if (sum / count > 128) n += 2 ** b;
    }
    numbers.push(n);
  }
  const { frames } = await ffprobeJson(['-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', path]);
  const times = (frames as { best_effort_timestamp_time: string }[]).map((f) => Number(f.best_effort_timestamp_time));
  if (times.length !== numbers.length) throw new Error(`${basename(path)}: ffmpeg decoded ${numbers.length} frames, ffprobe ${times.length}`);
  return { numbers, times };
}

// times (in the file's own timeline) where each beep of the first audio stream starts. Each decoded sample's time comes
// from its audio frame's timestamp, so gaps between audio packets (e.g. at joins) don't shift the beeps after them.
async function findBeeps(path: string) {
  const { streams: [stream] } = await ffprobeJson(['-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', path]);
  const sampleRate = Number(stream.sample_rate);
  const { frames } = await ffprobeJson(['-select_streams', 'a:0', '-show_entries', 'frame=best_effort_timestamp_time,nb_samples', path]);
  const frameStarts: { index: number, time: number }[] = [];
  let index = 0;
  for (const f of frames as { best_effort_timestamp_time: string, nb_samples: number }[]) {
    frameStarts.push({ index, time: Number(f.best_effort_timestamp_time) });
    index += Number(f.nb_samples);
  }
  const timeOf = (i: number) => {
    let lo = 0;
    let hi = frameStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (frameStarts[mid]!.index <= i) lo = mid;
      else hi = mid - 1;
    }
    const f = frameStarts[lo]!;
    return f.time + (i - f.index) / sampleRate;
  };
  const raw = await ffmpegRaw(['-i', path, '-map', '0:a:0', '-ac', '1', '-f', 's16le', '-']);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  if (samples.length !== index) throw new Error(`${basename(path)}: decoded ${samples.length} samples, ffprobe reported ${index}`);
  const beeps: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]!) > 3000) {
      if (i - lastLoud > sampleRate * 0.3) {
        let j = i;
        while (j > 0 && i - j < sampleRate / 1000 && Math.abs(samples[j - 1]!) > 300) j -= 1;
        beeps.push(timeOf(j));
      }
      lastLoud = i;
    }
  }
  return beeps;
}

async function getStreams(path: string) {
  const { streams } = await ffprobeJson(['-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language', path]);
  return streams as { index: number, codec_type: string, codec_name: string, tags?: { language?: string } }[];
}

async function getFormat(path: string) {
  const { format } = await ffprobeJson(['-show_entries', 'format=start_time,duration', path]);
  return { start: Number(format.start_time), duration: Number(format.duration) };
}

const nearest = (list: number[], t: number) => list.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), Infinity);
const ms = (s: number) => `${(s * 1000).toFixed(2)} ms`;

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
};

interface Prepared {
  s: Source,
  path: string,
  start: number,
  duration: number,
  decoded: Decoded,
  beeps: number[],
  streams: Awaited<ReturnType<typeof getStreams>>,
}

async function prepare(s: Source): Promise<Prepared> {
  const path = join(workDir, s.file);
  await generate(s, path);
  const { start, duration } = await getFormat(path);
  const decoded = s.audioOnly ? { numbers: [], times: [] } : await decodeVideo(path, s.size);
  if (!s.audioOnly) {
    const bad = decoded.numbers.findIndex((n, i) => n !== i);
    if (bad !== -1) throw new Error(`${s.file}: source frame ${bad} reads as #${decoded.numbers[bad]}`);
  }
  return { s, path, start, duration, decoded, beeps: await findBeeps(path), streams: await getStreams(path) };
}

// a clip from frame `first` to frame `end` (exclusive, null = end of file), cut slightly before the frames like a cut placed on a frame in the player
function clipOf(src: Prepared, first: number, end: number | null, name?: string): ExportClip {
  const fd = src.s.fps[1] / src.s.fps[0];
  const rel = (n: number) => src.decoded.times[n]! - src.start - fd * 0.1;
  return { start: rel(first), end: end == null ? src.duration : rel(end), ...(name != null ? { name } : {}) };
}

const expectedFrames = (src: Prepared, first: number, end: number | null) => Array.from({ length: (end ?? src.decoded.numbers.length) - first }, (_v, k) => first + k);

async function runExport(src: Prepared, outDir: string, opts: Pick<ExportRequest, 'clips' | 'container' | 'mode' | 'merge'> & { streamIndexes?: number[] }) {
  const stages = new Set<string>();
  let lastProgress = -1;
  let progressOk = true;
  const result = await exportClips({
    runner,
    request: {
      input: { path: src.path, duration: src.duration },
      streamIndexes: opts.streamIndexes ?? src.streams.map((st) => st.index),
      outDir,
      baseName: src.s.file.replace(/\.[^.]+$/, ''),
      ...opts,
    },
    onProgress: (p, stage) => {
      if (p < lastProgress - 1e-9 || p < 0 || p > 1) progressOk = false;
      lastProgress = p;
      stages.add(stage);
    },
  });
  if (!progressOk || lastProgress !== 1) check(false, `progress went backwards or didn't reach 1 (last ${lastProgress})`);
  for (const w of result.warnings) console.log(`     warning: ${w}`);
  return result;
}

// Check a frame accurate output: the frames of each part are exactly the expected ones, and every beep is where it was
// relative to the frames. `parts` are the expected frame numbers of each clip in output order.
async function checkSmart(src: Prepared, outPath: string, parts: number[][], label: string) {
  const out = await decodeVideo(outPath, src.s.size);
  const problems: string[] = [];
  const expected = parts.flat();
  if (out.numbers.length !== expected.length) problems.push(`${out.numbers.length} frames, expected ${expected.length}`);
  const mismatch = expected.findIndex((n, k) => out.numbers[k] !== n);
  if (mismatch !== -1) problems.push(`output frame ${mismatch} is #${out.numbers[mismatch]}, expected #${expected[mismatch]}`);
  const fd = src.s.fps[1] / src.s.fps[0];
  const badStep = out.times.findIndex((t, i) => i > 0 && Math.abs(t - out.times[i - 1]! - fd) > fd * 0.1);
  if (badStep !== -1) problems.push(`timestamp step at frame ${badStep}: ${out.times[badStep - 1]} -> ${out.times[badStep]}`);

  let beepInfo = 'no audio';
  const hasAudio = (await getStreams(outPath)).some((st) => st.codec_type === 'audio');
  if (hasAudio) {
    const outBeeps = await findBeeps(outPath);
    const drifts: number[] = [];
    let missing = 0;
    let pos = 0;
    for (const part of parts) {
      const outStart = out.times[pos]!;
      const srcStart = src.decoded.times[part[0]!]!;
      const partDuration = part.length * fd;
      // every source beep in this part (except right at its start or end) must be in the output, at the same place relative to the frames
      for (const b of src.beeps.filter((sb) => sb >= srcStart + 0.05 && sb < srcStart + partDuration - 0.05)) {
        const expectedAt = b - srcStart + outStart;
        const found = nearest(outBeeps, expectedAt);
        if (Math.abs(found - expectedAt) > 0.02) missing += 1;
        else drifts.push(found - expectedAt);
      }
      pos += part.length;
    }
    const worst = drifts.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
    if (missing > 0) problems.push(`${missing} beep(s) missing`);
    if (drifts.length === 0) problems.push('no beeps to check');
    // Matroska stores timestamps in whole milliseconds, so video and audio can each be rounded by up to 0.5 ms
    const tolerance = /\.mkv$/i.test(outPath) ? 0.0015 : 0.001;
    if (Math.abs(worst) > tolerance) problems.push(`worst A/V offset change ${ms(worst)}`);
    beepInfo = `${drifts.length} beeps, worst A/V change ${ms(worst)}`;
  }
  check(problems.length === 0, `${label}: ${out.numbers.length} frames #${out.numbers[0]}..#${out.numbers.at(-1)}, ${beepInfo}${problems.length > 0 ? `; ${problems.join('; ')}` : ''}`);
}

// A keyframe export: decodes, starts at or before the requested frame and contains all requested frames
async function checkKeyframe(src: Prepared, outPath: string, first: number, end: number | null, label: string) {
  const out = await decodeVideo(outPath, src.s.size);
  const problems: string[] = [];
  const at = out.numbers.indexOf(first);
  if (at === -1) problems.push(`frame #${first} missing`);
  else {
    const want = expectedFrames(src, first, end);
    const got = out.numbers.slice(at, at + want.length);
    // the very last frame may be cut (the duration is measured from the requested start)
    const mismatch = want.slice(0, -1).findIndex((n, k) => got[k] !== n);
    if (mismatch !== -1) problems.push(`frame #${want[mismatch]} missing or out of order`);
    if (out.numbers[0]! > first) problems.push(`starts at #${out.numbers[0]}`);
  }
  check(problems.length === 0, `${label}: ${out.numbers.length} frames #${out.numbers[0]}..#${out.numbers.at(-1)} (requested #${first}..#${end ?? 'end'})${problems.length > 0 ? `; ${problems.join('; ')}` : ''}`);
  return { frames: out.numbers.length, duration: (await getFormat(outPath)).duration };
}

// An audio-only output: every source beep of the clip (except at its start/end) at its offset from the clip start, within 1 ms
async function checkAudio(src: Prepared, outPath: string, clips: ExportClip[], label: string, partStarts?: number[]) {
  const outBeeps = await findBeeps(outPath);
  const problems: string[] = [];
  const drifts: number[] = [];
  for (const [k, clip] of clips.entries()) {
    const outStart = partStarts?.[k] ?? 0;
    const srcFrom = src.start + clip.start;
    for (const b of src.beeps.filter((sb) => sb >= srcFrom + 0.05 && sb < src.start + clip.end - 0.05)) {
      const expectedAt = b - srcFrom + outStart;
      const found = nearest(outBeeps, expectedAt);
      if (Math.abs(found - expectedAt) > 0.03) problems.push(`beep at ${expectedAt.toFixed(3)}s missing`);
      else drifts.push(found - expectedAt);
    }
  }
  const worst = drifts.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
  const tolerance = partStarts != null ? 0.03 : 0.001;
  if (Math.abs(worst) > tolerance) problems.push(`worst offset ${ms(worst)}`);
  check(problems.length === 0, `${label}: ${drifts.length} beeps, worst offset ${ms(worst)}${problems.length > 0 ? `; ${problems.slice(0, 3).join('; ')}` : ''}`);
}

async function freshDir(name: string) {
  const dir = join(workDir, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

async function checkNoTempFiles(dir: string, label: string) {
  const leftovers = (await readdir(dir)).filter((f) => f.startsWith('.videocut-') || f.startsWith('smartjoin-'));
  check(leftovers.length === 0, `${label}: no temporary files left${leftovers.length > 0 ? ` (${leftovers.join(', ')})` : ''}`);
}

const mp4 = { format: 'mp4', ext: '.mp4' };
const mkv = { format: 'matroska', ext: '.mkv' };
const mpegts = { format: 'mpegts', ext: '.ts' };
const m4a = { format: 'mp4', ext: '.m4a' };

type Cut = [number, number | null];

// separate smart + keyframe exports, then merged smart + keyframe exports of the same cuts
async function standardChecks(src: Prepared, name: string, cuts: Cut[], container: { format: string, ext: string }) {
  const clips = cuts.map(([a, b]) => clipOf(src, a, b));
  const parts = cuts.map(([a, b]) => expectedFrames(src, a, b));

  const dir = await freshDir(`${name}-smart`);
  const smart = await runExport(src, dir, { clips, container, mode: 'smart', merge: false });
  check(smart.outputPaths.length === cuts.length, `${name} smart: ${smart.outputPaths.length} outputs`);
  for (const [k, outPath] of smart.outputPaths.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await checkSmart(src, outPath, [parts[k]!], `${name} smart clip ${k + 1} (${basename(outPath)})`);
  }
  check(smart.warnings.length === 0, `${name} smart: no warnings`);
  await checkNoTempFiles(dir, `${name} smart`);

  const kdir = await freshDir(`${name}-keyframe`);
  const key = await runExport(src, kdir, { clips, container, mode: 'keyframe', merge: false });
  const keyStats: { frames: number, duration: number }[] = [];
  for (const [k, outPath] of key.outputPaths.entries()) {
    // eslint-disable-next-line no-await-in-loop
    keyStats.push(await checkKeyframe(src, outPath, cuts[k]![0], cuts[k]![1], `${name} keyframe clip ${k + 1}`));
  }

  const mdir = await freshDir(`${name}-merge`);
  const merged = await runExport(src, mdir, { clips, container, mode: 'smart', merge: true });
  check(merged.outputPaths.length === 1 && basename(merged.outputPaths[0]!) === `${src.s.file.replace(/\.[^.]+$/, '')} - cut${container.ext}`, `${name} merged smart: output name ${basename(merged.outputPaths[0] ?? '')}`);
  await checkSmart(src, merged.outputPaths[0]!, parts, `${name} merged smart`);
  await checkNoTempFiles(mdir, `${name} merged smart`);

  const mkdir2 = await freshDir(`${name}-merge-keyframe`);
  const mergedKey = await runExport(src, mkdir2, { clips, container, mode: 'keyframe', merge: true });
  const out = await decodeVideo(mergedKey.outputPaths[0]!, src.s.size);
  const { duration } = await getFormat(mergedKey.outputPaths[0]!);
  const sumFrames = keyStats.reduce((a, st) => a + st.frames, 0);
  const sumDuration = keyStats.reduce((a, st) => a + st.duration, 0);
  const { stderr: decodeErr } = await execFileAsync(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', mergedKey.outputPaths[0]!, '-f', 'null', '-'], { maxBuffer, encoding: 'utf8' });
  const fatal = decodeErr.split(/\r?\n/).filter((l) => /invalid|corrupt|error while decoding/i.test(l) && !/mmco/.test(l));
  check(Math.abs(out.numbers.length - sumFrames) <= cuts.length && Math.abs(duration - sumDuration) < 0.25 && out.numbers.length > 0,
    `${name} merged keyframe: ${out.numbers.length} frames (clips: ${sumFrames}), ${duration.toFixed(3)}s (clips: ${sumDuration.toFixed(3)}s)${fatal.length > 0 ? `, ${fatal.length} decoder message(s): ${fatal[0]}` : ''}`);
  return { clips, parts };
}

await mkdir(workDir, { recursive: true });
const want = (name: string) => filter == null || name.includes(filter);

// --- naming (no files needed) ---
if (want('naming')) {
  console.log('\n## naming');
  check(getOutputPath({ outDir: 'C:\\out', baseName: 'movie', ext: '.mp4', merge: false, clipIndex: 0, clipCount: 3 }) === 'C:\\out\\movie - clip 1.mp4', 'separate name');
  check(getOutputPath({ outDir: 'C:\\out', baseName: 'movie', ext: '.mp4', merge: false, clipIndex: 4, clipCount: 12, clipName: 'Intro' }) === 'C:\\out\\movie - clip 05 - Intro.mp4', 'padded name with clip name');
  check(getOutputPath({ outDir: 'C:\\out\\', baseName: 'movie', ext: 'mkv', merge: true }) === 'C:\\out\\movie - cut.mkv', 'merged name');
  check(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j. ') === 'a_b_c_d_e_f_g_h_i_j', 'sanitized name');
}

if (want('h264')) {
  console.log('\n## H.264 MP4 (AAC)');
  const src = await prepare(sources['h264']!);
  try {
    const cuts: Cut[] = [[37, 212], [260, 413], [455, null]];
    await standardChecks(src, 'h264', cuts, mp4);

    // MPEG-TS output: no 1.4 s offset between the copied audio and the smart rendered video
    const tsDir = await freshDir('h264-ts');
    const ts = await runExport(src, tsDir, { clips: [clipOf(src, 37, 212)], container: mpegts, mode: 'smart', merge: false });
    await checkSmart(src, ts.outputPaths[0]!, [expectedFrames(src, 37, 212)], 'h264 -> MPEG-TS smart');

    // naming and no overwriting: the same export twice into one folder, with a clip name that needs sanitizing
    const nameDir = await freshDir('h264-names');
    const clips = [clipOf(src, 50, 120), clipOf(src, 130, 200, 'part: one?')];
    const first = await runExport(src, nameDir, { clips, container: mp4, mode: 'keyframe', merge: false });
    const second = await runExport(src, nameDir, { clips, container: mp4, mode: 'keyframe', merge: false });
    const names = [...first.outputPaths, ...second.outputPaths].map((p) => basename(p));
    const expectedNames = ['h264 - clip 1.mp4', 'h264 - clip 2 - part_ one_.mp4', 'h264 - clip 1 (2).mp4', 'h264 - clip 2 - part_ one_ (2).mp4'];
    check(JSON.stringify(names) === JSON.stringify(expectedNames), `names: ${names.join(' | ')}`);
    const m1 = await runExport(src, nameDir, { clips, container: mp4, mode: 'keyframe', merge: true });
    const m2 = await runExport(src, nameDir, { clips, container: mp4, mode: 'keyframe', merge: true });
    check(basename(m1.outputPaths[0]!) === 'h264 - cut.mp4' && basename(m2.outputPaths[0]!) === 'h264 - cut (2).mp4', `merged names: ${basename(m1.outputPaths[0]!)} | ${basename(m2.outputPaths[0]!)}`);

    // video only (audio not selected), also merged (the joiner's audio is removed)
    const vDir = await freshDir('h264-videoonly');
    const vSep = await runExport(src, vDir, { clips: [clipOf(src, 37, 212)], container: mp4, mode: 'smart', merge: false, streamIndexes: [0] });
    const vMerged = await runExport(src, vDir, { clips: [clipOf(src, 37, 212), clipOf(src, 260, 300)], container: mp4, mode: 'smart', merge: true, streamIndexes: [0] });
    for (const p of [...vSep.outputPaths, ...vMerged.outputPaths]) {
      // eslint-disable-next-line no-await-in-loop
      const st = await getStreams(p);
      check(st.length === 1 && st[0]!.codec_type === 'video', `video only: ${basename(p)} has ${st.map((x) => x.codec_type).join(', ')}`);
    }
    await checkSmart(src, vMerged.outputPaths[0]!, [expectedFrames(src, 37, 212), expectedFrames(src, 260, 300)], 'h264 video only merged');
    await checkNoTempFiles(vDir, 'h264 video only');

    // cancelling: stops, removes the temporary files and the unfinished output
    const cDir = await freshDir('h264-cancel');
    const controller = new AbortController();
    const startCalls = ffmpegCalls;
    const cancelRunner: ExportRunner = {
      ...runner,
      ffmpeg: async (args) => {
        const r = await runner.ffmpeg(args);
        if (ffmpegCalls - startCalls >= 2) controller.abort();
        return r;
      },
    };
    let cancelled = false;
    try {
      await exportClips({
        runner: cancelRunner,
        request: { input: { path: src.path, duration: src.duration }, clips: [clipOf(src, 37, 212), clipOf(src, 260, 413)], streamIndexes: [0, 1], outDir: cDir, baseName: 'h264', container: mp4, mode: 'smart', merge: false },
        signal: controller.signal,
      });
    } catch {
      cancelled = true;
    }
    const left = await readdir(cDir);
    check(cancelled && left.length === 0, `cancel: ${cancelled ? 'rejected' : 'did not reject'}, files left: ${left.join(', ') || 'none'}`);
  } catch (err) {
    check(false, `h264: ${err instanceof Error ? err.message.slice(0, 3000) : String(err)}`);
  }
}

if (want('mpeg2')) {
  console.log('\n## MPEG-2 TS, interlaced, open GOP (AC-3 + second audio track)');
  const src = await prepare(sources['mpeg2']!);
  try {
    const [v, a1, a2] = src.streams.map((st) => st.index);
    const cuts: Cut[] = [[37, 212], [301, 480]];
    // drop the second audio track
    await standardChecks(src, 'mpeg2', cuts, mpegts);
    const dir = await freshDir('mpeg2-streams');
    const one = await runExport(src, dir, { clips: [clipOf(src, 37, 212)], container: mpegts, mode: 'smart', merge: false, streamIndexes: [v!, a1!] });
    const oneStreams = await getStreams(one.outputPaths[0]!);
    check(oneStreams.filter((st) => st.codec_type === 'audio').length === 1, `second audio track dropped: ${oneStreams.map((st) => st.codec_name).join(', ')}`);
    const both = await runExport(src, dir, { clips: [clipOf(src, 37, 212)], container: mkv, mode: 'smart', merge: false, streamIndexes: [v!, a1!, a2!] });
    const bothStreams = await getStreams(both.outputPaths[0]!);
    check(bothStreams.map((st) => st.codec_name).join(',') === 'mpeg2video,ac3,mp2' && bothStreams[2]?.tags?.language === 'deu', `both audio tracks kept (mkv): ${bothStreams.map((st) => `${st.codec_name}${st.tags?.language != null ? `/${st.tags.language}` : ''}`).join(', ')}`);
    await checkSmart(src, both.outputPaths[0]!, [expectedFrames(src, 37, 212)], 'mpeg2 -> mkv, both audio tracks');
    const merged = await runExport(src, dir, { clips: [clipOf(src, 37, 212), clipOf(src, 301, 480)], container: mpegts, mode: 'smart', merge: true, streamIndexes: [v!, a1!, a2!] });
    check(merged.warnings.some((w) => w.includes(`#${a2}`)), 'merged smart warns about the dropped second audio track');
  } catch (err) {
    check(false, `mpeg2: ${err instanceof Error ? err.message.slice(0, 3000) : String(err)}`);
  }
}

if (want('hevc')) {
  console.log('\n## HEVC MKV, open GOP (AAC + SRT subtitles)');
  const src = await prepare(sources['hevc']!);
  try {
    const cuts: Cut[] = [[13, 200], [250, 431]];
    await standardChecks(src, 'hevc', cuts, mkv);
    const dir = await freshDir('hevc-subs');
    const inMkv = await runExport(src, dir, { clips: [clipOf(src, 13, 200)], container: mkv, mode: 'smart', merge: false });
    const mkvStreams = await getStreams(inMkv.outputPaths[0]!);
    check(mkvStreams.map((st) => st.codec_type).join(',') === 'video,audio,subtitle', `mkv keeps the subtitles: ${mkvStreams.map((st) => st.codec_name).join(', ')}`);
    const { packets } = await ffprobeJson(['-select_streams', 's:0', '-show_entries', 'packet=pts_time', inMkv.outputPaths[0]!]);
    // cues at 0.5, 2.5, 4.5, 6.5 s ... of the source; the clip starts at frame 13 (0.54 s), so the first cue in it is 2.5 s
    const firstCue = Number(packets[0]?.pts_time) + clipOf(src, 13, 200).start;
    check(Math.abs(firstCue - 2.5) < 0.05, `subtitle timing: first cue at ${firstCue.toFixed(3)}s in source time (expected 2.5)`);
    const inMp4 = await runExport(src, dir, { clips: [clipOf(src, 13, 200)], container: mp4, mode: 'smart', merge: false });
    const mp4Streams = await getStreams(inMp4.outputPaths[0]!);
    check(mp4Streams.map((st) => st.codec_type).join(',') === 'video,audio' && inMp4.warnings.some((w) => w.includes('subrip')), `mp4 skips the SRT track with a warning: ${mp4Streams.map((st) => st.codec_name).join(', ')}`);
    await checkSmart(src, inMp4.outputPaths[0]!, [expectedFrames(src, 13, 200)], 'hevc -> mp4');
  } catch (err) {
    check(false, `hevc: ${err instanceof Error ? err.message.slice(0, 3000) : String(err)}`);
  }
}

if (want('m4a')) {
  console.log('\n## audio only M4A');
  const src = await prepare(sources['m4a']!);
  try {
    const clips: ExportClip[] = [{ start: 1.5, end: 6.3 }, { start: 10.25, end: 14 }, { start: 17.1, end: src.duration }];
    const dir = await freshDir('m4a-smart');
    const smart = await runExport(src, dir, { clips, container: m4a, mode: 'smart', merge: false });
    for (const [k, p] of smart.outputPaths.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await checkAudio(src, p, [clips[k]!], `m4a smart clip ${k + 1}`);
      // eslint-disable-next-line no-await-in-loop
      const { duration } = await getFormat(p);
      const want2 = clips[k]!.end - clips[k]!.start;
      check(Math.abs(duration - want2) < 0.05, `m4a smart clip ${k + 1}: ${duration.toFixed(3)}s (requested ${want2.toFixed(3)}s)`);
    }
    const kdir = await freshDir('m4a-keyframe');
    const key = await runExport(src, kdir, { clips, container: m4a, mode: 'keyframe', merge: false });
    const keyDurations: number[] = [];
    for (const p of key.outputPaths) {
      // eslint-disable-next-line no-await-in-loop
      keyDurations.push((await getFormat(p)).duration);
    }
    check(key.outputPaths.length === 3 && keyDurations.every((d, k) => Math.abs(d - (clips[k]!.end - clips[k]!.start)) < 0.1), `m4a keyframe: durations ${keyDurations.map((d) => d.toFixed(3)).join(', ')}`);
    const mdir = await freshDir('m4a-merge');
    const merged = await runExport(src, mdir, { clips, container: m4a, mode: 'smart', merge: true });
    const { duration } = await getFormat(merged.outputPaths[0]!);
    const sum = clips.reduce((a, c) => a + c.end - c.start, 0);
    check(Math.abs(duration - sum) < 0.1, `m4a merged: ${duration.toFixed(3)}s (clips ${sum.toFixed(3)}s)`);
    // beeps of each part, allowing for the audio packet granularity at each join
    const starts = clips.map((_c, k) => clips.slice(0, k).reduce((a, c) => a + c.end - c.start, 0));
    await checkAudio(src, merged.outputPaths[0]!, clips, 'm4a merged beeps (30 ms tolerance at joins)', starts);
    await checkNoTempFiles(mdir, 'm4a merged');
  } catch (err) {
    check(false, `m4a: ${err instanceof Error ? err.message.slice(0, 3000) : String(err)}`);
  }
}

console.log(`\n${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
