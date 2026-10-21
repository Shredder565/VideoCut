// End-to-end test of the smart joiner (src/engine/smartJoin.ts) on generated sample files.
//
// Every frame carries its own number and a per-file id as a bit pattern (16 columns: low 12 bits = frame number,
// high 4 bits = file id), and the audio has a short beep starting exactly on every 25th frame. After joining, the output
// is decoded to check:
// - the frames are exactly the expected frames of each input, in order (for re-encoded parts with a frame rate
//   conversion: the right count, file id and order, each frame within one source frame of where it should be)
// - timestamps are monotonic with a constant frame step
// - every beep is still on its frame (A/V offset compared with the source), including right after each join
// - the joiner's own verification found no problems, and each input was copied/smart rendered/re-encoded as expected
//
// Usage: node test-manual/smartJoin/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { planJoin, runJoin, describeJoinResult, type JoinRunner, type JoinVideoAction, type JoinAudioAction } from '../../src/engine/smartJoin.ts';

const execFileAsync = promisify(execFile);

const [ffDirArg, workDirArg, filter] = process.argv.slice(2);
if (ffDirArg == null || workDirArg == null) throw new Error('Usage: run.ts <ffmpeg dir> <work dir> [filter]');
const ffDir = resolve(ffDirArg);
const workDir = resolve(workDirArg);
const exe = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = join(ffDir, `ffmpeg${exe}`);
const ffprobePath = join(ffDir, `ffprobe${exe}`);

const maxBuffer = 1024 * 1024 * 1024;
const runner: JoinRunner = {
  ffprobe: async (args) => (await execFileAsync(ffprobePath, args, { maxBuffer, encoding: 'utf8' })).stdout,
  ffmpeg: async (args) => {
    const { stderr } = await execFileAsync(ffmpegPath, args, { maxBuffer, encoding: 'utf8' });
    return { stderr };
  },
  writeFile: async (path, content) => writeFile(path, content),
  removeFile: async (path) => rm(path, { force: true }),
};
const ffmpegRaw = async (args: string[]) => (await execFileAsync(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { maxBuffer, encoding: 'buffer' })).stdout;
const ffprobeJson = async (args: string[]) => JSON.parse((await execFileAsync(ffprobePath, ['-v', 'error', '-of', 'json', ...args], { maxBuffer, encoding: 'utf8' })).stdout);

const beepEvery = 25; // frames
const beepDuration = 0.04;
const decodeWidth = 640;
const decodeHeight = 360;
const numBits = 16;
const frameBits = 12;

interface Source {
  id: number,
  file: string,
  size: [number, number],
  fps: [number, number],
  duration: number,
  sampleRate: number,
  // video and audio encoding args (and container options)
  args: string[],
  // extra video filters after the pattern (e.g. setsar)
  vf?: string,
  // simulate a recording that starts mid-stream: drop this fraction of the file's bytes from the start (TS only)
  truncateStart?: number,
  // make the file by keyframe cutting (-ss with stream copy) another generated file at this time
  keyframeCutAt?: number,
}

interface CaseInput {
  source: Source,
  // [first frame, end frame (exclusive)] in the source's frame numbers
  cut?: [number, number],
  expect: JoinVideoAction,
  expectAudio: JoinAudioAction,
}

interface Case {
  name: string,
  out: string,
  inputs: CaseInput[],
}

const h264Mp4 = (id: number, duration = 8): Source => ({
  id,
  file: `h264-${id}.mp4`,
  size: [640, 360],
  fps: [25, 1],
  duration,
  sampleRate: 48000,
  args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50', '-bf', '3', '-c:a', 'aac', '-b:a', '192k'],
});

const h264Open = (id: number): Source => ({
  id,
  file: `h264-open-${id}.ts`,
  size: [640, 360],
  fps: [30000, 1001],
  duration: 20,
  sampleRate: 48000,
  args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-x264-params', 'keyint=48:open-gop=1:bframes=3', '-c:a', 'aac', '-b:a', '192k'],
});

const mpeg2Rec = (id: number, truncateStart: number | undefined): Source => ({
  id,
  file: `rec-${id}.ts`,
  size: [720, 576],
  fps: [25, 1],
  duration: 10,
  sampleRate: 48000,
  vf: 'setsar=64/45',
  args: ['-c:v', 'mpeg2video', '-b:v', '6M', '-g', '12', '-bf', '2', '-flags', '+ildct+ilme', '-top', '1', '-c:a', 'ac3', '-b:a', '384k'],
  ...(truncateStart != null ? { truncateStart } : {}),
});

const cases: Case[] = [
  {
    name: 'identical h264 mp4 (copy)',
    out: 'out-identical.mp4',
    inputs: [1, 2, 3].map((id) => ({ source: h264Mp4(id), expect: 'copy' as const, expectAudio: 'copy' as const })),
  },
  {
    name: 'h264 open GOP with cut ranges (smart)',
    out: 'out-opengop.mkv',
    inputs: [
      { source: h264Open(1), cut: [37, 412], expect: 'smart', expectAudio: 'copy' },
      { source: h264Open(2), cut: [100, 290], expect: 'smart', expectAudio: 'copy' },
      // a keyframe cut: ffmpeg drops the leading B-frames of the open GOP, but the file starts with a non-IDR keyframe
      // (recovery point), which doesn't reset the decoder when joined after another file, so its first GOP is re-encoded
      { source: { ...h264Open(3), file: 'h264-open-3-kfcut.ts', keyframeCutAt: 5.1 }, expect: 'smart', expectAudio: 'copy' },
      // a recording that starts mid-GOP
      { source: { ...h264Open(5), truncateStart: 0.23 }, expect: 'smart', expectAudio: 'copy' },
      { source: h264Open(4), cut: [0, 200], expect: 'smart', expectAudio: 'copy' },
    ],
  },
  {
    name: 'mixed formats (encode the odd ones)',
    out: 'out-mixed.mp4',
    inputs: [
      { source: { ...h264Mp4(1), file: 'mix-720p25.mp4', size: [1280, 720] }, expect: 'copy', expectAudio: 'copy' },
      { source: { ...h264Mp4(2, 6), file: 'mix-360p30.mp4', fps: [30, 1], sampleRate: 44100 }, expect: 'encode', expectAudio: 'encode' },
      {
        source: { id: 3, file: 'mix-mpeg2.ts', size: [720, 576], fps: [25, 1], duration: 6, sampleRate: 48000, vf: 'setsar=64/45', args: ['-c:v', 'mpeg2video', '-b:v', '6M', '-g', '12', '-bf', '2', '-flags', '+ildct+ilme', '-top', '1', '-c:a', 'mp2', '-b:a', '256k'] },
        expect: 'encode',
        expectAudio: 'encode',
      },
      // no audio: silence is inserted
      { source: { ...h264Mp4(5, 4), file: 'mix-720p25-silent.mp4', size: [1280, 720], args: [...h264Mp4(5).args.slice(0, -4), '-an'] }, expect: 'copy', expectAudio: 'silence' },
      { source: { ...h264Mp4(4), file: 'mix-720p25-b.mp4', size: [1280, 720] }, cut: [13, 160], expect: 'smart', expectAudio: 'copy' },
    ],
  },
  {
    name: 'mpeg2 ts recordings',
    out: 'out-recordings.ts',
    inputs: [
      { source: mpeg2Rec(1, undefined), expect: 'copy', expectAudio: 'copy' },
      { source: mpeg2Rec(2, 0.137), expect: 'smart', expectAudio: 'copy' },
      { source: mpeg2Rec(3, 0.311), expect: 'smart', expectAudio: 'copy' },
    ],
  },
];

async function generate(s: Source, path: string) {
  const [w, h] = s.size;
  const fps = `${s.fps[0]}/${s.fps[1]}`;
  const fpsNum = s.fps[0] / s.fps[1];
  const value = `(N+${s.id * 2 ** frameBits})`;
  const geq = `geq=lum='16+219*mod(floor(${value}/pow(2\\,floor(X*${numBits}/W)))\\,2)':cb=128:cr=128`;
  const beep = `aevalsrc='if(lt(t-floor(t*${fpsNum}/${beepEvery})*${beepEvery}/${fpsNum}\\,${beepDuration})\\,0.5*sin(2*PI*1000*t)\\,0)':s=${s.sampleRate}:c=stereo:d=${s.duration}`;
  await ffmpegRaw([
    '-y', '-f', 'lavfi', '-i', `color=black:size=${w}x${h}:rate=${fps}:d=${s.duration},format=yuv420p,${geq}${s.vf != null ? `,${s.vf}` : ''}`,
    '-f', 'lavfi', '-i', beep,
    ...s.args, '-shortest', path,
  ]);
}

interface Decoded { ids: number[], numbers: number[], times: number[] }

async function decodeVideo(path: string): Promise<Decoded> {
  const raw = await ffmpegRaw(['-i', path, '-map', '0:v:0', '-vf', `scale=${decodeWidth}:${decodeHeight},format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const frameSize = decodeWidth * decodeHeight;
  const bitWidth = decodeWidth / numBits;
  const ids: number[] = [];
  const numbers: number[] = [];
  for (let off = 0; off + frameSize <= raw.length; off += frameSize) {
    let n = 0;
    for (let b = 0; b < numBits; b += 1) {
      let sum = 0;
      let count = 0;
      for (let y = decodeHeight / 2 - 8; y < decodeHeight / 2 + 8; y += 1) {
        for (let x = Math.round(b * bitWidth + 12); x < Math.round((b + 1) * bitWidth - 12); x += 1) {
          sum += raw[off + y * decodeWidth + x]!;
          count += 1;
        }
      }
      if (sum / count > 128) n += 2 ** b;
    }
    numbers.push(n % (2 ** frameBits));
    ids.push(Math.floor(n / 2 ** frameBits));
  }
  const { frames } = await ffprobeJson(['-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', path]);
  const times = (frames as { best_effort_timestamp_time: string }[]).map((f) => Number(f.best_effort_timestamp_time));
  return { ids, numbers, times };
}

// times (in the file's own timeline) where each beep starts. Each decoded sample's time comes from its audio frame's
// timestamp, so gaps between audio packets (e.g. at joins) don't shift the beeps after them.
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
  if (samples.length !== index) throw new Error(`${path}: decoded ${samples.length} samples, ffprobe reported ${index}`);
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

const nearest = (list: number[], t: number) => list.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), Infinity);
const ms = (s: number) => `${(s * 1000).toFixed(1)} ms`;

async function prepareSource(s: Source) {
  const path = join(workDir, s.file);
  if (s.keyframeCutAt != null) {
    const basePath = join(workDir, `base-${s.file}`);
    await generate(s, basePath);
    await ffmpegRaw(['-y', '-ss', String(s.keyframeCutAt), '-i', basePath, '-map', '0', '-c', 'copy', path]);
  } else if (s.truncateStart != null) {
    const fullPath = join(workDir, `full-${s.file}`);
    await generate(s, fullPath);
    const data = await readFile(fullPath);
    const cut = Math.floor((data.length * s.truncateStart) / 188) * 188;
    await writeFile(path, data.subarray(cut));
  } else {
    await generate(s, path);
  }
  const decoded = await decodeVideo(path);
  const { streams } = await ffprobeJson(['-select_streams', 'a', '-show_entries', 'stream=index', path]);
  const beeps = streams.length > 0 ? await findBeeps(path) : [];
  return { path, decoded, beeps };
}

async function main() {
  await mkdir(workDir, { recursive: true });
  const tempDir = join(workDir, 'temp');
  await mkdir(tempDir, { recursive: true });
  let failures = 0;
  const fail = (msg: string) => {
    failures += 1;
    console.log(`FAIL ${msg}`);
  };

  for (const c of cases.filter((cc) => filter == null || cc.name.includes(filter))) {
    console.log(`\n## ${c.name}`);
    try {
      const sources: Awaited<ReturnType<typeof prepareSource>>[] = [];
      for (const input of c.inputs) {
        // eslint-disable-next-line no-await-in-loop
        sources.push(await prepareSource(input.source));
      }

      // cut times relative to the file start, slightly before the frame (like a cut placed on a frame in the player)
      const specs = await Promise.all(c.inputs.map(async (input, i) => {
        const src = sources[i]!;
        if (input.cut == null) return { path: src.path };
        const { format } = await ffprobeJson(['-show_entries', 'format=start_time', src.path]);
        const start = Number(format.start_time);
        const fd = input.source.fps[1] / input.source.fps[0];
        const timeOf = (n: number) => src.decoded.times[src.decoded.numbers.indexOf(n)]!;
        return { path: src.path, cutFrom: timeOf(input.cut[0]) - start - fd * 0.1, cutTo: timeOf(input.cut[1]) - start - fd * 0.1 };
      }));

      const plan = await planJoin({ runner, inputs: specs });
      for (const line of plan.summary) console.log(`  ${line}`);
      for (const [i, input] of c.inputs.entries()) {
        const p = plan.inputs[i]!;
        if (p.action !== input.expect || p.audioAction !== input.expectAudio) fail(`#${i + 1} planned video ${p.action}/audio ${p.audioAction}, expected ${input.expect}/${input.expectAudio}`);
      }

      const outPath = join(workDir, c.out);
      const started = Date.now();
      const result = await runJoin({ runner, plan, outPath, tempDir, onProgress: () => undefined, keepTempFiles: process.env['KEEP_TEMP'] === '1' });
      console.log(`  joined in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.frames} frames, ${result.duration.toFixed(3)}s`);
      for (const line of describeJoinResult(result)) console.log(`  ${line}`);
      for (const w of result.warnings) console.log(`  warning: ${w}`);
      if (result.problems.length > 0) fail(`joiner verification: ${result.problems.join(' | ')}`);

      const out = await decodeVideo(outPath);
      const outBeeps = await findBeeps(outPath);
      const targetFps = plan.target.video.fps;
      const fd = 1 / targetFps;

      // timestamps: monotonic, constant step
      const badSteps = out.times.flatMap((t, i) => (i > 0 && Math.abs(t - out.times[i - 1]! - fd) > fd * 0.1 ? [i] : []));
      if (badSteps.length > 0) fail(`timestamps not monotonic/constant at output frame(s) ${badSteps.slice(0, 5).join(', ')} (${out.times[badSteps[0]! - 1]} -> ${out.times[badSteps[0]!]})`);
      else console.log(`OK   ${out.times.length} frames, timestamps monotonic`);
      const totalFrames = result.parts.reduce((sum, p) => sum + p.frames, 0);
      if (out.numbers.length !== totalFrames) fail(`decoded ${out.numbers.length} frames, parts sum to ${totalFrames}`);

      let pos = 0;
      for (const [i, input] of c.inputs.entries()) {
        const part = result.parts[i]!;
        const src = sources[i]!;
        const s = input.source;
        const srcFps = s.fps[0] / s.fps[1];
        const frames = out.numbers.slice(pos, pos + part.frames);
        const ids = out.ids.slice(pos, pos + part.frames);
        const label = `#${i + 1} ${s.file} (${part.action}, audio ${part.audioAction})`;

        // the source frames that should be in the output, in order
        let expected: number[];
        if (input.cut != null) {
          expected = Array.from({ length: input.cut[1] - input.cut[0] }, (_v, k) => input.cut![0] + k);
        } else {
          // from the first keyframe (in decode order) to the end
          const { packets } = await ffprobeJson(['-select_streams', 'v:0', '-read_intervals', '%+#300', '-show_entries', 'packet=pts_time,flags', src.path]);
          const key = (packets as { pts_time: string, flags: string }[]).find((p) => p.flags.startsWith('K'))!;
          const keyIndex = src.decoded.times.findIndex((t) => Math.abs(t - Number(key.pts_time)) < 0.001);
          const first = src.decoded.numbers[keyIndex]!;
          const last = Math.max(...src.decoded.numbers.filter((_n, k) => src.decoded.ids[k] === s.id));
          expected = Array.from({ length: last - first + 1 }, (_v, k) => first + k);
        }

        const problems: string[] = [];
        if (ids.some((id) => id !== s.id)) problems.push(`frames from another file (ids ${[...new Set(ids)].join(',')})`);
        const converted = Math.abs(srcFps - targetFps) > 0.01;
        if (!converted) {
          if (frames.length !== expected.length) problems.push(`${frames.length} frames, expected ${expected.length}`);
          const mismatch = expected.findIndex((n, k) => frames[k] !== n);
          if (mismatch !== -1) problems.push(`frame ${mismatch} is #${frames[mismatch]}, expected #${expected[mismatch]}`);
        } else {
          const expectedCount = Math.round((expected.length * targetFps) / srcFps);
          if (Math.abs(frames.length - expectedCount) > 1) problems.push(`${frames.length} frames, expected about ${expectedCount}`);
          if (frames[0] !== expected[0]) problems.push(`first frame #${frames[0]}, expected #${expected[0]}`);
          const off = frames.findIndex((n, k) => Math.abs(n - (expected[0]! + (k * srcFps) / targetFps)) > 1);
          if (off !== -1) problems.push(`frame ${off} is #${frames[off]}, expected about #${(expected[0]! + (off * srcFps) / targetFps).toFixed(1)}`);
          if (frames.some((n, k) => k > 0 && n < frames[k - 1]!)) problems.push('frames out of order');
        }

        // A/V: map each output beep in this part back to the source and compare with the source's beep
        const outStart = out.times[pos]!;
        const outEnd = outStart + part.duration;
        const srcStart = src.decoded.times[src.decoded.numbers.findIndex((n, k) => n === frames[0] && src.decoded.ids[k] === s.id)]!;
        const partBeeps = outBeeps.filter((b) => b >= outStart + 0.06 && b < outEnd - 0.06);
        const drifts = partBeeps.map((b) => {
          const srcTime = b - outStart + srcStart;
          return srcTime - nearest(src.beeps, srcTime);
        });
        const srcBeepsInRange = src.beeps.filter((b) => b >= srcStart + 0.06 && b < srcStart + part.duration - 0.06).length;
        const worst = drifts.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
        const firstDrift = drifts[0];
        if (src.beeps.length === 0 && partBeeps.length > 0) problems.push(`${partBeeps.length} beep(s) in a part that should be silent`);
        if (partBeeps.length < srcBeepsInRange) problems.push(`found ${partBeeps.length}/${srcBeepsInRange} beeps (output ${partBeeps.map((b) => (b - outStart).toFixed(3)).join(',')}; source ${src.beeps.map((b) => (b - srcStart).toFixed(3)).join(',')})`);
        // copied audio keeps the source's samples; re-encoded (resampled) audio may shift the beep onset slightly
        const avTolerance = part.audioAction === 'copy' ? 0.002 : 0.003;
        if (Math.abs(worst) > avTolerance) problems.push(`worst A/V offset change ${ms(worst)}`);

        if (problems.length > 0) fail(`${label}: ${problems.join('; ')}`);
        else {
          console.log(`OK   ${label}: ${frames.length} frames #${frames[0]}..#${frames.at(-1)}, ${part.encodedFrames} re-encoded, ${partBeeps.length} beeps, A/V change ${drifts.length > 0 ? `${ms(Math.min(...drifts))}..${ms(Math.max(...drifts))}` : 'n/a'}${firstDrift != null ? ` (first beep after join ${ms(firstDrift)})` : ''}`);
        }
        pos += part.frames;
      }
    } catch (err) {
      fail(`${c.name}: ${err instanceof Error ? err.message.slice(0, 3000) : String(err)}`);
    }
  }

  if (filter == null || 'cancel'.includes(filter)) {
    // cancelling a join stops it and removes its temporary files (uses the files of the 'mixed formats' case)
    console.log('\n## cancel');
    try {
      const paths = ['mix-720p25.mp4', 'mix-360p30.mp4'].map((f) => join(workDir, f));
      const plan = await planJoin({ runner, inputs: paths.map((path) => ({ path })) });
      const controller = new AbortController();
      const cancelDir = join(workDir, 'temp-cancel');
      await rm(cancelDir, { recursive: true, force: true });
      await mkdir(cancelDir, { recursive: true });
      const error = await runJoin({
        runner,
        plan,
        outPath: join(workDir, 'out-cancel.mp4'),
        tempDir: cancelDir,
        signal: controller.signal,
        onProgress: (_p, stage) => { if (stage.startsWith('#2')) controller.abort(new Error('cancelled by test')); },
      }).then(() => undefined, (err: unknown) => err);
      const left = await readdir(cancelDir);
      if (!(error instanceof Error) || error.message !== 'cancelled by test') fail(`cancel: expected the join to fail with the abort reason, got ${String(error)}`);
      else if (left.length > 0) fail(`cancel: temp files left: ${left.join(', ')}`);
      else console.log('OK   join cancelled, temp files removed');
    } catch (err) {
      fail(`cancel: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${failures} failure(s)`);
  process.exitCode = failures > 0 ? 1 : 0;
}

await main();
