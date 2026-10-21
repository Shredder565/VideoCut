// End-to-end test of the recording repair (src/engine/streamFix.ts) on generated broken TV recordings.
//
// The samples' frames carry their own frame number as a bit pattern, with a short beep starting exactly on every 25th frame
// (like test-manual/smartRender/inApp.ts). Each sample is broken in a way that real recordings are (timestamp jumps, splices,
// corrupt data, late audio, 33-bit wraparound), analyzed (the expected problems must be found), fixed, and the output is checked:
// - the fix's own verification (analysis of the output) finds no remaining problems
// - a full decode logs no errors
// - the timestamps are monotonic (video dts strictly increasing, audio packets not overlapping)
// - the duration is sane (container duration matches the decoded frames)
// - the frames are in order (decoded frame numbers strictly increasing), with at most the expected number missing
// - every beep still starts on its frame (A/V sync), within a few ms of the clean source
//
// Usage: node test-manual/streamFix/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { analyzeStream, fixStream, type FfRunner, type StreamFixOptions, type StreamFixReport, type TimestampProblemKind } from '../../src/engine/streamFix.ts';

const execFileAsync = promisify(execFile);

const [ffDirArg, workDirArg, filter] = process.argv.slice(2);
if (!ffDirArg || !workDirArg) throw new Error('Usage: run.ts <ffmpeg dir> <work dir> [filter]');
const ffDir = resolve(ffDirArg);
const workDir = resolve(workDirArg);
const exe = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = join(ffDir, `ffmpeg${exe}`);
const ffprobePath = join(ffDir, `ffprobe${exe}`);

const textOpts = { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' as const };
const bufOpts = { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' as const };
const runner: FfRunner = {
  ffprobe: async (args) => (await execFileAsync(ffprobePath, args, textOpts)).stdout,
  ffmpeg: async (args) => ({ stderr: (await execFileAsync(ffmpegPath, args, textOpts)).stderr }),
};
const ffmpegBuf = async (args: string[]) => (await execFileAsync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], bufOpts)).stdout;
const ffmpeg = async (args: string[]) => runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args]);
const ffprobeJson = async (args: string[]) => JSON.parse(await runner.ffprobe(['-v', 'error', '-of', 'json', ...args]));

const width = 640;
const height = 360;
const bitWidth = 40; // each bit of the frame number is a 40 px wide column, white = 1
const numBits = Math.floor(width / bitWidth);
const beepEvery = 25; // frames
const beepDuration = 0.04;
const sampleRate = 48000;

interface Encoding {
  fps: [number, number],
  args: string[],
}

const mpeg2Mp2: Encoding = { fps: [25, 1], args: ['-c:v', 'mpeg2video', '-b:v', '4M', '-g', '12', '-bf', '2', '-c:a', 'mp2', '-b:a', '192k'] };
const mpeg2Ac3: Encoding = { fps: [25, 1], args: ['-c:v', 'mpeg2video', '-b:v', '4M', '-g', '15', '-bf', '2', '-flags', '+ildct+ilme', '-top', '1', '-c:a', 'ac3', '-b:a', '192k'] };
const h264Aac: Encoding = { fps: [30000, 1001], args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-x264-params', 'keyint=48:open-gop=1:bframes=3', '-c:a', 'aac', '-b:a', '160k'] };

// Encode frames [first, first + count) of the test pattern (frame numbers and beeps continue from `first`) to an MPEG-TS (or -PS) file.
// `extraAudio` adds a second audio track (MP2) with the same beeps.
async function encode(path: string, enc: Encoding, { first = 0, count, tsOffset, audioDelay = 0, format = 'mpegts', extraAudio = false }: {
  first?: number,
  count: number,
  tsOffset?: number,
  audioDelay?: number,
  format?: 'mpegts' | 'mpeg',
  extraAudio?: boolean,
}) {
  const fpsNum = enc.fps[0] / enc.fps[1];
  const t0 = first / fpsNum;
  const duration = count / fpsNum;
  // frame number N as bits: column b is white if bit b of N is set
  const geq = `geq=lum='16+219*mod(floor((N+${first})/pow(2\\,floor(X/${bitWidth})))\\,2)':cb=128:cr=128`;
  // beep for 40 ms starting on every 25th frame
  const tt = `(t+${t0.toFixed(6)})`;
  const beep = `aevalsrc='if(lt(${tt}-floor(${tt}*${fpsNum}/${beepEvery})*${beepEvery}/${fpsNum}\\,${beepDuration})\\,0.5*sin(2*PI*1000*t)\\,0)':s=${sampleRate}:d=${duration.toFixed(6)}`;
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=black:size=${width}x${height}:rate=${enc.fps[0]}/${enc.fps[1]}:d=${duration.toFixed(6)},format=yuv420p,${geq}`,
    '-f', 'lavfi', '-i', beep,
    // audio that starts late: drop its start but keep its timestamps
    ...(audioDelay > 0 ? ['-af', `atrim=start=${audioDelay}`] : []),
    '-map', '0:v', '-map', '1:a', ...(extraAudio ? ['-map', '1:a'] : []),
    ...enc.args,
    ...(extraAudio ? ['-c:a:1', 'mp2', '-b:a:1', '128k'] : []),
    ...(tsOffset != null ? ['-output_ts_offset', String(tsOffset)] : []),
    '-f', format, path,
  ]);
}

// byte ranges of files joined together, like a broken recording or two recordings joined with `cat`. Cuts are aligned to TS packets
// unless `raw` is set.
async function splice(outPath: string, parts: { path: string, from?: number, to?: number }[], raw = false) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const data = await readFile(part.path);
    const align = (f: number) => (raw ? Math.floor(f * data.length) : Math.floor((f * data.length) / 188) * 188);
    chunks.push(data.subarray(align(part.from ?? 0), align(part.to ?? 1)));
  }
  await writeFile(outPath, Buffer.concat(chunks));
}

// zero some byte ranges and remove others (positions as fractions of the file size)
async function damage(inPath: string, outPath: string, { zero, remove }: { zero: [number, number][], remove: [number, number][] }) {
  const data = Buffer.from(await readFile(inPath));
  for (const [at, len] of zero) data.fill(0, Math.floor(at * data.length), Math.floor(at * data.length) + len);
  const removeRanges = remove.map(([at, len]) => [Math.floor(at * data.length), Math.floor(at * data.length) + len] as const).sort((a, b) => a[0] - b[0]);
  const chunks: Buffer[] = [];
  let pos = 0;
  for (const [a, b] of removeRanges) {
    chunks.push(data.subarray(pos, a));
    pos = b;
  }
  chunks.push(data.subarray(pos));
  await writeFile(outPath, Buffer.concat(chunks));
}

interface DecodedVideo { numbers: number[], times: number[] }

async function decodeVideo(path: string): Promise<DecodedVideo> {
  const raw = await ffmpegBuf(['-i', path, '-map', '0:v:0', '-vf', `scale=${width}:${height},format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const frameSize = width * height;
  const numbers: number[] = [];
  for (let off = 0; off + frameSize <= raw.length; off += frameSize) {
    let n = 0;
    for (let b = 0; b < numBits; b += 1) {
      // average a small block in the middle of the column
      let sum = 0;
      let count = 0;
      for (let y = height / 2 - 8; y < height / 2 + 8; y += 1) {
        for (let x = b * bitWidth + 12; x < (b + 1) * bitWidth - 12; x += 1) {
          sum += raw[off + y * width + x]!;
          count += 1;
        }
      }
      if (sum / count > 128) n += 2 ** b;
    }
    numbers.push(n);
  }
  const { frames } = await ffprobeJson(['-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', path]);
  const times = (frames as { best_effort_timestamp_time: string }[]).map((f) => Number(f.best_effort_timestamp_time));
  return { numbers, times };
}

// Times (in the file's own timeline) where each beep starts. The decoded audio is laid out by its timestamps (gaps filled with
// silence by aresample), so a gap in the audio doesn't shift the beeps after it.
async function findBeeps(path: string, audioTrack = 0) {
  const raw = await ffmpegBuf(['-copyts', '-i', path, '-map', `0:a:${audioTrack}`, '-af', 'aresample=async=1:min_hard_comp=0.001:first_pts=0', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-']);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const beeps: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]!) > 3000) {
      if (i - lastLoud > sampleRate * 0.3) {
        // refine: walk back to where the beep's envelope starts
        let j = i;
        while (j > 0 && i - j < 48 && Math.abs(samples[j - 1]!) > 300) j -= 1;
        beeps.push(j / sampleRate);
      }
      lastLoud = i;
    }
  }
  return beeps;
}

// for each beep, offset from the start of the frame it belongs to (seconds)
function beepOffsets(video: DecodedVideo, beeps: number[]) {
  const offsets: { frame: number, offset: number }[] = [];
  video.numbers.forEach((n, i) => {
    if (n % beepEvery !== 0) return;
    const t = video.times[i]!;
    const nearest = beeps.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), Infinity);
    if (Math.abs(nearest - t) < 0.2) offsets.push({ frame: n, offset: nearest - t });
  });
  return offsets;
}

const ms = (s: number) => `${(s * 1000).toFixed(1)} ms`;

interface Case {
  name: string,
  // extension of the broken file (default ts)
  ext?: string,
  enc: Encoding,
  // builds the broken file at `path` (and a clean reference for the A/V offset at `refPath`), using `tmp(name)` for temporary files
  make: (path: string, refPath: string, tmp: (name: string) => string) => Promise<void>,
  // problems that the analysis must find
  expectKinds: TimestampProblemKind[],
  expect?: (r: StreamFixReport) => string | undefined,
  // the output's frame numbers must be strictly increasing, start at or before `maxFirst`, end at or after `minLast`, and at least `minFrames` of them
  minFrames: number,
  maxFirst: number,
  minLast: number,
  // expected content duration (s) of the output, roughly
  duration: number,
  outputs?: { ext: string, options?: StreamFixOptions }[],
  // the analysis of the source must not ask for a fix
  clean?: boolean,
}

const cases: Case[] = [
  {
    name: 'clean recording (no false alarms)',
    enc: mpeg2Mp2,
    make: async (path, refPath) => {
      await encode(path, mpeg2Mp2, { count: 500 });
      await encode(refPath, mpeg2Mp2, { count: 100 });
    },
    expectKinds: [],
    clean: true,
    minFrames: 500,
    maxFirst: 0,
    minLast: 499,
    duration: 20,
  },
  {
    name: 'two recordings joined byte-wise, timestamps jump forward by 5000 s',
    enc: mpeg2Mp2,
    make: async (path, refPath, tmp) => {
      await encode(tmp('a.ts'), mpeg2Mp2, { count: 500 });
      await encode(tmp('b.ts'), mpeg2Mp2, { first: 500, count: 500, tsOffset: 5000 });
      await splice(path, [{ path: tmp('a.ts') }, { path: tmp('b.ts') }]);
      await encode(refPath, mpeg2Mp2, { count: 100 });
    },
    expectKinds: ['jump'],
    minFrames: 1000,
    maxFirst: 0,
    minLast: 999,
    duration: 40,
    outputs: [{ ext: 'ts' }, { ext: 'm2ts' }, { ext: 'mkv', options: { format: 'matroska' } }, { ext: 'mp4', options: { format: 'mp4' } }],
  },
  {
    name: 'two recordings joined, timestamps jump backward into the first one\'s range (interlaced, ac3 + mp2 tracks)',
    enc: mpeg2Ac3,
    make: async (path, refPath, tmp) => {
      await encode(tmp('a.ts'), mpeg2Ac3, { count: 500, tsOffset: 10, extraAudio: true });
      await encode(tmp('b.ts'), mpeg2Ac3, { first: 500, count: 500, extraAudio: true });
      await splice(path, [{ path: tmp('a.ts') }, { path: tmp('b.ts') }]);
      await encode(refPath, mpeg2Ac3, { count: 100, extraAudio: true });
    },
    expectKinds: ['jump'],
    minFrames: 1000,
    maxFirst: 0,
    minLast: 999,
    duration: 40,
    outputs: [{ ext: 'ts' }, { ext: 'mkv', options: { format: 'matroska', tracks: 'main' } }],
  },
  {
    name: 'MPEG-PS (.mpg) recordings joined byte-wise, timestamps jump forward by 600 s',
    ext: 'mpg',
    enc: mpeg2Mp2,
    make: async (path, refPath, tmp) => {
      await encode(tmp('a.mpg'), mpeg2Mp2, { count: 500, format: 'mpeg' });
      await encode(tmp('b.mpg'), mpeg2Mp2, { first: 500, count: 500, tsOffset: 600, format: 'mpeg' });
      await splice(path, [{ path: tmp('a.mpg') }, { path: tmp('b.mpg') }], true);
      await encode(refPath, mpeg2Mp2, { count: 100, format: 'mpeg' });
    },
    expectKinds: ['jump'],
    minFrames: 1000,
    maxFirst: 0,
    minLast: 999,
    duration: 40,
    outputs: [{ ext: 'mpg' }, { ext: 'ts', options: { format: 'mpegts' } }],
  },
  {
    name: 'h264 open GOP + aac, recording starts mid-GOP, spliced mid-GOP onto another one (+3000 s)',
    enc: h264Aac,
    make: async (path, refPath, tmp) => {
      await encode(tmp('a.ts'), h264Aac, { count: 600 });
      await encode(tmp('b.ts'), h264Aac, { first: 1000, count: 600, tsOffset: 3000 });
      await splice(path, [{ path: tmp('a.ts'), from: 0.103, to: 0.557 }, { path: tmp('b.ts'), from: 0.411 }]);
      await encode(refPath, h264Aac, { count: 100 });
    },
    expectKinds: ['jump'],
    expect: (r) => (r.undecodableStartFrames > 0 ? undefined : 'no undecodable start frames found'),
    // ~45 % of a (from ~60) and ~59 % of b (from ~1250), minus the frames until the first keyframes (up to 48 each)
    minFrames: 500,
    maxFirst: 120,
    minLast: 1599,
    duration: 20,
    outputs: [{ ext: 'ts' }, { ext: 'mkv', options: { format: 'matroska' } }],
  },
  {
    name: 'reception errors: zeroed and missing bytes',
    enc: mpeg2Mp2,
    make: async (path, refPath, tmp) => {
      await encode(tmp('a.ts'), mpeg2Mp2, { count: 1000 });
      await damage(tmp('a.ts'), path, { zero: [[0.25, 30001], [0.5, 5000], [0.62, 777]], remove: [[0.75, 70001]] });
      await encode(refPath, mpeg2Mp2, { count: 100 });
    },
    expectKinds: ['gap'],
    expect: (r) => (r.corruptPackets > 0 && r.damagedFrames > 0 ? undefined : `corrupt packets ${r.corruptPackets}, damaged frames ${r.damagedFrames}`),
    // each damaged spot can cost up to two GOPs (12 frames each)
    minFrames: 1000 - 4 * 30,
    maxFirst: 0,
    minLast: 999,
    duration: 40,
  },
  {
    name: 'audio starts 300 ms after the video',
    enc: mpeg2Ac3,
    make: async (path, refPath) => {
      await encode(path, mpeg2Ac3, { count: 500, audioDelay: 0.3 });
      await encode(refPath, mpeg2Ac3, { count: 100 });
    },
    expectKinds: [],
    expect: (r) => (r.avOffset != null && Math.abs(r.avOffset - 0.3) < 0.05 ? undefined : `A/V offset ${r.avOffset}`),
    // video now starts on the first keyframe after 0.3 s (frame 15)
    minFrames: 470,
    maxFirst: 15,
    minLast: 499,
    duration: 19.4,
    outputs: [{ ext: 'ts' }, { ext: 'ts', options: { fixAvOffset: false } }],
  },
  {
    name: '33-bit timestamp wraparound',
    enc: mpeg2Mp2,
    make: async (path, refPath, tmp) => {
      await encode(tmp('a.ts'), mpeg2Mp2, { count: 750 });
      // 2^33 / 90000 = 95443.72 s: wraps after about 7 s
      await ffmpeg(['-i', tmp('a.ts'), '-map', '0', '-c', 'copy', '-output_ts_offset', '95436', '-f', 'mpegts', path]);
      await encode(refPath, mpeg2Mp2, { count: 100 });
    },
    expectKinds: ['wrap'],
    minFrames: 750,
    maxFirst: 0,
    minLast: 749,
    duration: 30,
    outputs: [{ ext: 'ts' }, { ext: 'mp4', options: { format: 'mp4' } }],
  },
];

async function checkOutput(c: Case, outPath: string, refOffsets: number[], fps: number) {
  const problems: string[] = [];
  const info: string[] = [];

  // full decode
  const { stderr } = await runner.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-i', outPath, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
  const errors = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (errors.length > 0) problems.push(`${errors.length} decode error(s): ${errors[0]}`);

  // monotonic timestamps
  const report = await analyzeStream({ runner, path: outPath });
  for (const s of report.streams) {
    const packets = report.packets.get(s.index) ?? [];
    if (s.codecType === 'video') {
      // Matroska stores no dts: the demuxer leaves the first ones unset
      const withDts = packets.filter((p) => p.dts != null);
      const bad = withDts.findIndex((p, i) => i > 0 && p.dts! <= withDts[i - 1]!.dts!);
      if (bad !== -1) problems.push(`video dts not increasing at packet ${withDts[bad]!.n}`);
    }
    if (s.codecType === 'audio') {
      const bad = packets.findIndex((p, i) => {
        if (i === 0) return false;
        const prev = packets[i - 1]!;
        return (p.pts! - prev.pts! - prev.duration) * s.timeBase < -0.002;
      });
      if (bad !== -1) problems.push(`audio packets overlap at packet ${bad}`);
    }
  }
  if ((report.startTime ?? 0) < 0) problems.push(`negative start time ${report.startTime}`);

  // frames in order
  const video = await decodeVideo(outPath);
  const nums = video.numbers;
  const notIncreasing = nums.findIndex((n, i) => i > 0 && n <= nums[i - 1]!);
  if (notIncreasing !== -1) problems.push(`frame ${notIncreasing} is #${nums[notIncreasing]} after #${nums[notIncreasing - 1]}`);
  if (nums.length < c.minFrames) problems.push(`${nums.length} frames, expected at least ${c.minFrames}`);
  if ((nums[0] ?? Infinity) > c.maxFirst) problems.push(`first frame #${nums[0]}, expected <= #${c.maxFirst}`);
  if ((nums.at(-1) ?? -1) < c.minLast) problems.push(`last frame #${nums.at(-1)}, expected >= #${c.minLast}`);
  const missing = nums.length > 0 ? nums.at(-1)! - nums[0]! + 1 - nums.length : 0;
  info.push(`${nums.length} frames #${nums[0]}..#${nums.at(-1)}${missing > 0 ? ` (${missing} skipped)` : ''}`);

  // sane duration: the container's duration covers the frames (plus the gaps of dropped frames)
  const span = video.times.length > 0 ? video.times.at(-1)! - video.times[0]! + 1 / fps : 0;
  if (report.duration == null || Math.abs(report.duration - span) > 0.5) problems.push(`duration ${report.duration?.toFixed(3)} s, frames span ${span.toFixed(3)} s`);
  if (report.duration != null && Math.abs(report.duration - c.duration) > 2) problems.push(`duration ${report.duration.toFixed(3)} s, expected about ${c.duration} s`);
  info.push(`duration ${report.duration?.toFixed(3)} s`);

  // A/V sync, for each audio track: each beep's offset from its frame, compared with the clean reference
  const audioTracks = report.streams.filter((s) => s.codecType === 'audio').length;
  if (audioTracks !== refOffsets.length) problems.push(`${audioTracks} audio tracks, expected ${refOffsets.length}`);
  for (const [track, refOffset] of refOffsets.entries()) {
    if (track >= audioTracks) break;
    const offsets = beepOffsets(video, await findBeeps(outPath, track));
    const drifts = offsets.map((o) => o.offset - refOffset);
    const worst = drifts.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
    const expectedBeeps = nums.filter((n) => n % beepEvery === 0).length;
    // allow a beep right at a cut/splice to be unmeasurable (audio codecs need a frame to warm up)
    if (offsets.length < expectedBeeps - 2) problems.push(`audio ${track}: found ${offsets.length}/${expectedBeeps} beeps`);
    if (Math.abs(worst) > 0.003) problems.push(`audio ${track}: A/V sync off by ${ms(worst)} at frame #${offsets[drifts.indexOf(worst)]!.frame}`);
    info.push(`audio ${track}: ${offsets.length} beeps, sync ${drifts.length > 0 ? `${ms(Math.min(...drifts))}..${ms(Math.max(...drifts))}` : 'n/a'}`);
  }

  // video and audio start together
  const vStart = report.streams.find((s) => s.codecType === 'video')?.firstTime;
  const aStart = report.streams.find((s) => s.codecType === 'audio')?.firstTime;
  if (vStart != null && aStart != null) info.push(`A/V start offset ${ms(aStart - vStart)}`);

  return { problems, info, avStart: vStart != null && aStart != null ? aStart - vStart : undefined };
}

await mkdir(workDir, { recursive: true });

let failures = 0;
const result = (ok: boolean, text: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
};

for (const [ci, c] of cases.entries().filter(([, cc]) => filter == null || cc.name.includes(filter))) {
  console.log(`\n## ${c.name}`);
  const dir = join(workDir, `case${ci}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `broken.${c.ext ?? 'ts'}`);
  const refPath = join(dir, `ref.${c.ext ?? 'ts'}`);
  const fps = c.enc.fps[0] / c.enc.fps[1];
  try {
    await c.make(path, refPath, (name) => join(dir, name));

    // reference A/V offset of a clean encode with the same settings
    const refVideo = await decodeVideo(refPath);
    const refTracks = (await analyzeStream({ runner, path: refPath })).streams.filter((s) => s.codecType === 'audio').length;
    const refOffsets: number[] = [];
    for (let track = 0; track < refTracks; track += 1) {
      const offsets = beepOffsets(refVideo, await findBeeps(refPath, track));
      refOffsets.push(offsets.reduce((a, o) => a + o.offset, 0) / offsets.length);
    }

    const started = Date.now();
    const report = await analyzeStream({ runner, path, options: { decodeCheck: true } });
    const kinds = new Set(report.timestampProblems.map((p) => p.kind));
    const missingKinds = c.expectKinds.filter((k) => !kinds.has(k));
    const expectProblem = c.expect?.(report);
    const analysisOk = c.clean ? !report.needsFix : report.needsFix && missingKinds.length === 0 && expectProblem == null;
    result(analysisOk, `analysis (${Date.now() - started} ms): needsFix=${report.needsFix}; ${report.problems.join('; ') || 'no problems'}${report.notes.length > 0 ? ` [${report.notes.join('; ')}]` : ''}${missingKinds.length > 0 ? `; MISSING ${missingKinds.join(', ')}` : ''}${expectProblem != null ? `; ${expectProblem}` : ''}`);

    for (const [oi, output] of (c.outputs ?? [{ ext: 'ts' }]).entries()) {
      const outPath = join(dir, `fixed-${oi}.${output.ext}`);
      const label = `fix -> .${output.ext}${output.options != null ? ` ${JSON.stringify(output.options)}` : ''}`;
      try {
        const fixed = await fixStream({ runner, path, outPath, report, options: output.options ?? {} });
        const check = await checkOutput(c, outPath, refOffsets, fps);
        const problems = [...fixed.remainingProblems.map((p) => `verification: ${p}`), ...check.problems];
        if ((output.options?.fixAvOffset ?? true) && check.avStart != null && Math.abs(check.avStart) > 0.03) problems.push(`A/V start offset ${ms(check.avStart)}`);
        result(problems.length === 0, `${label}: ${check.info.join(', ')}${problems.length > 0 ? `\n       PROBLEMS: ${problems.join(' | ')}` : ''}\n       actions: ${fixed.actions.join('; ')}`);
      } catch (err) {
        result(false, `${label}: ${err instanceof Error ? err.message.slice(0, 2000) : String(err)}`);
      }
    }
  } catch (err) {
    result(false, `${c.name}: ${err instanceof Error ? err.message.slice(0, 2000) : String(err)}`);
  }
}

console.log(`\n${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
