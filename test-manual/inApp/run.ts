// In-app end-to-end test of smart cut exports: frame accuracy and audio sync ("beep test").
//
// Generates sample files whose frames carry their own frame number as a bit pattern, with a short beep
// starting exactly on every 25th frame. Starts the built app with its test API (and a separate settings folder),
// opens each sample, sets the clips, exports, then decodes every output to check:
// - the exported frames are exactly the requested ones (no missing, duplicated or shifted frames)
// - each beep still starts on its frame (A/V offset compared with the source)
//
// Usage (after `npm run build`): node test-manual/inApp/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]
// To test a packaged app instead, set VIDEOCUT_EXE to its executable.

import { execFile, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const [ffDirArg, workDirArg, filter] = process.argv.slice(2);
if (ffDirArg == null || workDirArg == null) throw new Error('Usage: run.ts <ffmpeg dir> <work dir> [filter]');
const ffDir = resolve(ffDirArg);
const workDir = resolve(workDirArg);
const exe = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = join(ffDir, `ffmpeg${exe}`);
const ffprobePath = join(ffDir, `ffprobe${exe}`);
const repoDir = resolve(import.meta.dirname, '../..');
const packagedAppPath = process.env['VIDEOCUT_EXE'];
const electronPath = packagedAppPath ?? join(repoDir, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = 18080 + Math.floor(Math.random() * 1000);
const apiUrl = `http://127.0.0.1:${port}`;

const execOpts = { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' as const };
const ffmpeg = async (args: string[]) => (await execFileAsync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], execOpts)).stdout;
const ffprobeJson = async (args: string[]) => JSON.parse((await execFileAsync(ffprobePath, ['-v', 'error', '-of', 'json', ...args], execOpts)).stdout.toString('utf8'));

const width = 640;
const height = 360;
const bitWidth = 40; // each bit of the frame number is a 40 px wide column, white = 1
const numBits = Math.floor(width / bitWidth);
const beepEvery = 25; // frames
const beepDuration = 0.04;
const sampleRate = 48000;

interface Case {
  name: string,
  file: string,
  fps: [number, number],
  duration: number,
  encodeArgs: string[],
  // segments as [first frame, end frame (exclusive)]
  segments: [number, number][],
}

const cases: Case[] = [
  {
    name: 'h264 mp4, B-pyramid, aac',
    file: 'beep-h264.mp4',
    fps: [25, 1],
    duration: 30,
    encodeArgs: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-g', '50', '-bf', '3', '-c:a', 'aac', '-b:a', '192k'],
    segments: [[37, 412], [463, 640]],
  },
  {
    name: 'mpeg2 ts, interlaced, open GOP, ac3',
    file: 'beep-mpeg2.ts',
    fps: [30000, 1001],
    duration: 30,
    encodeArgs: ['-c:v', 'mpeg2video', '-b:v', '6M', '-g', '15', '-bf', '2', '-flags', '+ildct+ilme', '-top', '1', '-c:a', 'ac3', '-b:a', '192k'],
    segments: [[37, 412], [463, 640]],
  },
  {
    name: 'hevc mkv, open GOP, aac',
    file: 'beep-hevc.mkv',
    fps: [24, 1],
    duration: 30,
    encodeArgs: ['-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'keyint=48:log-level=error', '-c:a', 'aac', '-b:a', '192k'],
    segments: [[37, 412], [500, 700]],
  },
];

async function generate(c: Case, path: string) {
  const fps = `${c.fps[0]}/${c.fps[1]}`;
  const fpsNum = c.fps[0] / c.fps[1];
  // frame number N as bits: column b is white if bit b of N is set
  const geq = `geq=lum='16+219*mod(floor(N/pow(2\\,floor(X/${bitWidth})))\\,2)':cb=128:cr=128`;
  // beep for 40 ms starting on every 25th frame
  const beep = `aevalsrc='if(lt(t-floor(t*${fpsNum}/${beepEvery})*${beepEvery}/${fpsNum}\\,${beepDuration})\\,0.5*sin(2*PI*1000*t)\\,0)':s=${sampleRate}:d=${c.duration}`;
  await ffmpeg([
    '-y', '-f', 'lavfi', '-i', `color=black:size=${width}x${height}:rate=${fps}:d=${c.duration},format=yuv420p,${geq}`,
    '-f', 'lavfi', '-i', beep,
    ...c.encodeArgs, '-shortest', path,
  ]);
}

interface DecodedVideo { numbers: number[], times: number[] }

async function decodeVideo(path: string): Promise<DecodedVideo> {
  const raw = await ffmpeg(['-i', path, '-map', '0:v:0', '-vf', `scale=${width}:${height},format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
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

// times (in the file's own timeline) where each beep starts
async function findBeeps(path: string) {
  const { streams } = await ffprobeJson(['-select_streams', 'a:0', '-show_entries', 'stream=start_time', path]);
  const start = Number(streams[0].start_time);
  const raw = await ffmpeg(['-i', path, '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-']);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const beeps: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]!) > 3000) {
      if (i - lastLoud > sampleRate * 0.3) {
        // refine: walk back to where the beep's envelope starts
        let j = i;
        while (j > 0 && i - j < 48 && Math.abs(samples[j - 1]!) > 300) j -= 1;
        beeps.push(start + j / sampleRate);
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

async function api<T = unknown>(action: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const json = await res.json() as { ok: boolean, value?: T, error?: string };
  if (!json.ok) throw new Error(`${action}: ${json.error}`);
  return json.value as T;
}

async function waitForApi() {
  for (let i = 0; i < 120; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await api('state');
      return;
    } catch {
      // not up yet
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('HTTP API did not start');
}

const ms = (s: number) => `${(s * 1000).toFixed(1)} ms`;

async function main() {
  await mkdir(workDir, { recursive: true });
  const configDir = join(workDir, 'userdata');
  await rm(configDir, { recursive: true, force: true });
  await mkdir(configDir, { recursive: true });

  const selected = cases.filter((c) => filter == null || c.name.includes(filter) || c.file.includes(filter));
  const outDir = join(workDir, 'out');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const prepared: { c: Case, path: string, sourceOffset: number }[] = [];

  for (const c of selected) {
    const path = join(workDir, c.file);
    console.log(`Generating ${c.file}`);
    // eslint-disable-next-line no-await-in-loop
    await generate(c, path);
    // eslint-disable-next-line no-await-in-loop
    const source = await decodeVideo(path);
    // eslint-disable-next-line no-await-in-loop
    const sourceOffsets = beepOffsets(source, await findBeeps(path));
    const sourceOffset = sourceOffsets.reduce((a, o) => a + o.offset, 0) / sourceOffsets.length;
    console.log(`  ${source.numbers.length} frames, first frame time ${source.times[0]}, source beep offset ${ms(sourceOffset)} (${sourceOffsets.length} beeps)`);

    prepared.push({ c, path, sourceOffset });
  }

  console.log(`Starting VideoCut, test API on port ${port}`);
  const app = spawn(electronPath, [...(packagedAppPath != null ? [] : ['.']), '--test-api', String(port), '--user-data', configDir], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const appLog: string[] = [];
  app.stdout.on('data', (d) => appLog.push(String(d)));
  app.stderr.on('data', (d) => appLog.push(String(d)));

  let failures = 0;
  try {
    await waitForApi();
    // let the renderer finish loading
    await new Promise((r) => setTimeout(r, 3000));

    for (const { c, path, sourceOffset } of prepared) {
      console.log(`\n## ${c.name}`);
      const fpsNum = c.fps[0] / c.fps[1];
      // eslint-disable-next-line no-await-in-loop
      await api('settings', { smartCut: true, exportMode: 'separate', outputDir: outDir, container: null });
      // eslint-disable-next-line no-await-in-loop
      await api('open', { path });
      // clip times are relative to the file's start, like the timeline in the app
      // eslint-disable-next-line no-await-in-loop
      await api('clips', { clips: c.segments.map(([first, end]) => ({ start: first / fpsNum, end: end / fpsNum, name: `${first}-${end}` })), mode: 'keep' });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
      // eslint-disable-next-line no-await-in-loop
      const result = await api<{ outputPaths: string[], warnings: string[] }>('export');
      if (result.warnings.length > 0) console.log(`Warnings: ${result.warnings.join('; ')}`);
      const exported = result.outputPaths;
      console.log(`Exported: ${exported.join(', ') || '(no paths reported)'}`);
      if (exported.length !== c.segments.length) {
        console.log(`FAIL expected ${c.segments.length} output files, got ${exported.length}`);
        failures += 1;
      }

      for (const [i, outPath] of exported.slice(0, c.segments.length).entries()) {
        const [first, end] = c.segments[i]!;
        // eslint-disable-next-line no-await-in-loop
        const out = await decodeVideo(outPath);
        const expected = Array.from({ length: end - first }, (_v, k) => first + k);
        const mismatch = expected.findIndex((n, k) => out.numbers[k] !== n);
        const frameProblems: string[] = [];
        if (out.numbers.length !== expected.length) frameProblems.push(`${out.numbers.length} frames, expected ${expected.length}`);
        if (mismatch !== -1) frameProblems.push(`frame ${mismatch} is #${out.numbers[mismatch]}, expected #${expected[mismatch]}`);

        // eslint-disable-next-line no-await-in-loop
        // A beep right at the cut start is skipped: losslessly cut audio starts on a packet boundary, and the first decoded
        // packet has no preceding data to overlap with (AAC, AC-3), so its onset isn't measurable. This is not a sync error.
        const offsets = beepOffsets(out, await findBeeps(outPath)).filter((o) => o.frame - first >= 2);
        const drifts = offsets.map((o) => o.offset - sourceOffset);
        const worst = drifts.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
        const expectedBeeps = expected.filter((n) => n % beepEvery === 0 && n - first >= 2).length;
        const syncProblems: string[] = [];
        if (offsets.length < expectedBeeps) syncProblems.push(`found ${offsets.length}/${expectedBeeps} beeps`);
        // within 1 ms of the source, allowing for audio codec frame/priming rounding
        if (Math.abs(worst) > 0.001) syncProblems.push(`worst beep offset change ${ms(worst)} at frame #${offsets[drifts.indexOf(worst)]!.frame}`);

        const problems = [...frameProblems, ...syncProblems];
        if (problems.length > 0) failures += 1;
        console.log(`${problems.length > 0 ? 'FAIL' : 'OK  '} frames ${first}-${end}: ${out.numbers.length} frames #${out.numbers[0]}..#${out.numbers.at(-1)}, ${offsets.length} beeps, offset change ${drifts.length > 0 ? `${ms(Math.min(...drifts))} to ${ms(Math.max(...drifts))}` : 'n/a'}${problems.length > 0 ? ` (${problems.join('; ')})` : ''}`);
      }
    }
  } catch (err) {
    failures += 1;
    console.error(err);
    console.error(appLog.join('').split('\n').slice(-40).join('\n'));
  } finally {
    app.kill();
  }

  console.log(`\n${failures} failure(s)`);
  process.exitCode = failures > 0 ? 1 : 0;
}

await main();
