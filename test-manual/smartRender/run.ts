// End-to-end test of the frame accurate smart render on generated sample files.
// For each cut, the output is compared frame by frame (PSNR) with the exact frames of the source,
// so a missing, duplicated or shifted frame shows up as a frame count mismatch or a low PSNR.
//
// Usage: node test-manual/smartRender/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { smartRenderVideo, verifySmartRender, getFrameDuration, getDecodeErrors, type FfRunner, type SmartRenderStream } from '../../src/engine/smartRender.ts';

const execFileAsync = promisify(execFile);

const [ffDir, workDir, filter] = process.argv.slice(2);
if (ffDir == null || workDir == null) throw new Error('Usage: run.ts <ffmpeg dir> <work dir> [filter]');
const exe = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = join(resolve(ffDir), `ffmpeg${exe}`);
const ffprobePath = join(resolve(ffDir), `ffprobe${exe}`);

const opts = { cwd: workDir, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' as const };
const runner: FfRunner = {
  ffprobe: async (args) => (await execFileAsync(ffprobePath, args, opts)).stdout,
  ffmpeg: async (args) => {
    const { stderr } = await execFileAsync(ffmpegPath, args, opts);
    return { stderr };
  },
};

const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];

interface Case {
  name: string,
  file: string,
  args: string[],
  // cuts as [first frame index, end frame index (exclusive)], or null for the end of the file
  cuts: [number, number | null][],
}

const cases: Case[] = [
  {
    name: 'h264 mp4, closed GOP, B-pyramid',
    file: 'h264-closed.mp4',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', ...sine, '-t', '30', '-c:v', 'libx264', '-preset', 'fast', '-g', '50', '-c:a', 'aac', '-shortest'],
    cuts: [[37, 412], [50, 400], [3, 30], [60, 61], [113, 290], [205, null]],
  },
  {
    name: 'h264 ts, open GOP, 29.97 fps',
    file: 'h264-open.ts',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30000/1001', ...sine, '-t', '30', '-c:v', 'libx264', '-preset', 'fast', '-x264-params', 'keyint=48:open-gop=1:bframes=3', '-c:a', 'mp2', '-shortest'],
    cuts: [[37, 412], [48, 480], [100, 120], [301, null], [49, 400], [60, 300], [90, 300]],
  },
  {
    name: 'h264 mp4, no B-frames',
    file: 'h264-baseline.mp4',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '20', '-c:v', 'libx264', '-profile:v', 'baseline', '-g', '60'],
    cuts: [[17, 333], [60, 180]],
  },
  {
    name: 'h264 ts, interlaced 1080i',
    file: 'h264-interlaced.ts',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001', ...sine, '-t', '15', '-vf', 'tinterlace=interleave_top,fieldorder=tff', '-r', '30000/1001', '-c:v', 'libx264', '-preset', 'veryfast', '-flags', '+ildct+ilme', '-x264-params', 'interlaced=1:tff=1:keyint=30', '-c:a', 'ac3', '-shortest'],
    cuts: [[20, 200], [31, 350]],
  },
  {
    name: 'mpeg2 ts, interlaced, open GOP',
    file: 'mpeg2.ts',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=30000/1001', ...sine, '-t', '30', '-c:v', 'mpeg2video', '-b:v', '6M', '-g', '15', '-bf', '2', '-flags', '+ildct+ilme', '-top', '1', '-c:a', 'ac3', '-shortest'],
    cuts: [[37, 412], [45, 300], [7, 12], [500, null]],
  },
  {
    name: 'hevc mkv, open GOP, B-pyramid',
    file: 'hevc.mkv',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', ...sine, '-t', '30', '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'keyint=48:log-level=error', '-c:a', 'aac', '-shortest'],
    cuts: [[37, 412], [96, 300], [13, 40]],
  },
  {
    name: 'hevc mp4, 10 bit',
    file: 'hevc10.mp4',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '20', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'keyint=50:log-level=error', '-tag:v', 'hvc1'],
    cuts: [[37, 412]],
  },
];

async function getVideoStream(path: string): Promise<SmartRenderStream> {
  const stdout = await runner.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', path]);
  return JSON.parse(stdout).streams[0];
}

// pts of all frames in presentation order, relative to the file start (like ffmpeg -ss)
async function getFrameTimes(path: string) {
  const stdout = await runner.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time:format=start_time', '-of', 'json', path]);
  const { packets, format } = JSON.parse(stdout);
  const start = parseFloat(format.start_time);
  return (packets as { pts_time: string }[]).map((p) => parseFloat(p.pts_time) - start).sort((a, b) => a - b);
}

async function compare({ outPath, srcPath, from, to, expectedFrames, n }: { outPath: string, srcPath: string, from: number, to: number | undefined, expectedFrames: number, n: string }) {
  const countOut = await runner.ffprobe(['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', outPath]);
  const statsFile = `psnr-${n}.log`;
  const trim = `trim=start=${from}${to != null ? `:end=${to}` : ''}`;
  await runner.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-i', outPath, '-i', srcPath, '-lavfi', `[1:v]${trim},settb=1/25,setpts=N[ref];[0:v]settb=1/25,setpts=N[o];[o][ref]psnr=stats_file=${statsFile}:shortest=1`, '-f', 'null', '-']);
  const psnrs = (await readFile(join(workDir!, statsFile), 'utf8')).trim().split('\n').map((line) => {
    const m = /psnr_avg:(\S+)/.exec(line);
    return m?.[1] === 'inf' ? Infinity : parseFloat(m?.[1] ?? 'NaN');
  });
  const minPsnr = Math.min(...psnrs);
  const worst = psnrs.indexOf(minPsnr);
  return { outFrames: parseInt(countOut.trim(), 10), expectedFrames, minPsnr, worst };
}

await mkdir(workDir, { recursive: true });

let failures = 0;
for (const c of cases.filter((cc) => filter == null || cc.name.includes(filter) || cc.file.includes(filter))) {
  const srcPath = join(workDir, c.file);
  await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-v', 'error', ...c.args, srcPath]);
  const stream = await getVideoStream(srcPath);
  const frameDuration = getFrameDuration(stream)!;
  const times = await getFrameTimes(srcPath);
  console.log(`\n## ${c.name} (${c.file}): ${times.length} frames, has_b_frames=${stream.has_b_frames}, field_order=${stream.field_order}`);

  for (const [i, [startFrame, endFrame]] of c.cuts.entries()) {
    // cut slightly before the frame times, like a cut placed on a frame in the player
    const from = times[startFrame]! - frameDuration * 0.1;
    const toEnd = endFrame == null;
    const to = toEnd ? times.at(-1)! + frameDuration : times[endFrame]! - frameDuration * 0.1;
    const expectedFrames = (toEnd ? times.length : endFrame) - startFrame;
    const n = `${c.file}-${i}`;
    const outPathPrefix = join(workDir, `tmp-${n}`);

    try {
      const { plan, concatListPath } = await smartRenderVideo({
        runner,
        inputPath: srcPath,
        stream,
        cutFrom: from,
        cutTo: to,
        toEnd,
        outPathPrefix,
        tempFiles: [],
        writeFile: (path, content) => writeFile(path, content),
      });
      const outPath = join(workDir, `out-${n}.mkv`);
      await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-map', '0:v', '-c', 'copy', outPath]);
      const outMp4 = join(workDir, `out-${n}.mp4`);
      await runner.ffmpeg(['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-map', '0:v', '-c', 'copy', outMp4]);

      const problems = await verifySmartRender({ runner, outPath, videoStreamIndex: 0, plan, frameDuration });
      const r = await compare({ outPath, srcPath, from, to: toEnd ? undefined : to, expectedFrames, n });
      const r4 = await compare({ outPath: outMp4, srcPath, from, to: toEnd ? undefined : to, expectedFrames, n: `${n}-mp4` });
      // a full decode from the start must not log any errors
      for (const path of [outPath, outMp4]) {
        const { stderr } = await runner.ffmpeg(['-hide_banner', '-nostdin', '-v', 'error', '-i', path, '-f', 'null', '-']);
        const errors = getDecodeErrors(stderr);
        if (errors.length > 0) problems.push(`decode errors in ${path.slice(-4)}: ${errors[0]}`);
      }
      const parts = plan.parts.map((p) => (p.type === 'encode' ? `enc(${p.frames ?? '?'})` : 'copy')).join('+');
      const ok = problems.length === 0 && r.outFrames === expectedFrames && r.minPsnr > 30 && r4.outFrames === expectedFrames && r4.minPsnr > 30;
      if (!ok) failures += 1;
      console.log(`${ok ? 'OK  ' : 'FAIL'} frames ${startFrame}-${endFrame ?? 'end'}: ${parts}; mkv ${r.outFrames}/${expectedFrames} frames, min PSNR ${r.minPsnr.toFixed(1)} (frame ${r.worst}); mp4 ${r4.outFrames} frames, min PSNR ${r4.minPsnr.toFixed(1)}${problems.length > 0 ? `; verify: ${problems.join(' | ')}` : ''}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL frames ${startFrame}-${endFrame ?? 'end'}: ${err instanceof Error ? err.message.slice(0, 2000) : err}`);
    }
  }
}

console.log(`\n${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
