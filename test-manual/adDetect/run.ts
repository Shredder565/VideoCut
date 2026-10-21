/* eslint-disable no-continue */ // the signal scanning loops read more clearly with early continues
// End-to-end test of the automatic ad break detection on generated "TV recordings".
// Each recording is a sequence of programme sections and ad breaks made of commercial spots separated by
// short black + silent separators, plus traps that must not be detected as breaks:
// black + silent fades inside the programme (one of them exactly a spot length after a break),
// and a dark scene with quiet audio.
//
// Usage: node test-manual/adDetect/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { detectAdBreaks, type AdDetectRunner } from '../../src/engine/adDetect.ts';

const execFileAsync = promisify(execFile);

const [ffDir, workDirArg, filter] = process.argv.slice(2);
if (ffDir == null || workDirArg == null) throw new Error('Usage: run.ts <ffmpeg dir> <work dir> [filter]');
const workDir = resolve(workDirArg);
const exe = process.platform === 'win32' ? '.exe' : '';
const ffmpegPath = join(resolve(ffDir), `ffmpeg${exe}`);
const ffprobePath = join(resolve(ffDir), `ffprobe${exe}`);

const opts = { cwd: workDir, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' as const };
const runner: AdDetectRunner = {
  ffprobe: async (args) => (await execFileAsync(ffprobePath, args, opts)).stdout,
  ffmpeg: async (args) => {
    const { stderr } = await execFileAsync(ffmpegPath, args, opts);
    return { stderr };
  },
  // streams stderr so that the detector can report progress
  ffmpegStreaming: async (args, { onStderr, signal }) => new Promise((res, rej) => {
    const p = spawn(ffmpegPath, args, { cwd: workDir, signal });
    let stderr = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => { stderr += d; onStderr(d); });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res({ stderr }) : rej(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-2000)}`))));
  }),
};

// ---------------------------------------------------------------------------------------------
// Synthetic recordings

const W = 384;
const H = 216;
const FPS = 25;

type PieceKind = 'program' | 'ad' | 'black' | 'dark';
interface Piece { kind: PieceKind, dur: number, seed: number }

// Patterned video whose content changes abruptly every `period` seconds (a "scene cut")
function patternVideo(period: number, seed: number, dark = false) {
  const k = `floor(T/${period})`;
  const lum = dark
    ? `18+8*sin(((X*(1+mod(${k}*7+${seed},5))+Y*(1+mod(${k}*3+${seed},4)))/12)+T*3)`
    : `128+90*sin(((X*(1+mod(${k}*7+${seed},5))+Y*(1+mod(${k}*3+${seed},4)))/12)+T*3)`;
  const cb = dark ? '128' : `128+60*sin(${k}*1.7+${seed})`;
  const cr = dark ? '128' : `128+60*cos(${k}*2.3+${seed})`;
  return `nullsrc=s=${W}x${H}:r=${FPS},format=yuv420p,geq=lum='${lum}':cb='${cb}':cr='${cr}'`;
}

function pieceSources(p: Piece): [string, string] {
  switch (p.kind) {
    case 'program': {
      // calm-ish programme: a cut every 6-8 s, speech-like modulated tone at about -26 dB RMS
      return [patternVideo(6 + (p.seed % 3), p.seed), `aevalsrc='0.1*sin(2*PI*${200 + 10 * p.seed}*t)*(0.6+0.4*sin(2*PI*0.7*t))':s=48000`];
    }
    case 'ad': {
      // commercial: a cut every ~1.2 s, louder audio (about -14 dB RMS)
      return [patternVideo(1 + (p.seed % 5) * 0.1, p.seed + 11), `aevalsrc='0.3*sin(2*PI*${500 + 37 * p.seed}*t)+0.1*sin(2*PI*${90 + 7 * p.seed}*t)':s=48000`];
    }
    case 'black': {
      return [`color=c=black:s=${W}x${H}:r=${FPS}`, 'aevalsrc=0:s=48000'];
    }
    case 'dark': {
      // dark scene with quiet (but not silent) audio
      return [patternVideo(8, p.seed, true), 'aevalsrc=\'0.008*sin(2*PI*150*t)\':s=48000'];
    }
    default: { throw new Error('unknown piece');
    }
  }
}

class Timeline {
  pieces: Piece[] = [];

  breaks: [number, number][] = [];

  t = 0;

  private seed = 1;

  add(kind: PieceKind, dur: number) {
    this.pieces.push({ kind, dur, seed: this.seed });
    this.seed += 1;
    this.t += dur;
    return this;
  }

  program(dur: number) { return this.add('program', dur); }

  // black + silent fade inside the programme (a trap)
  fade(dur = 0.6) { return this.add('black', dur); }

  dark(dur: number) { return this.add('dark', dur); }

  // An ad break: separators (black + silence) around and between the spots.
  // `lead`: the recording starts with the last `lead` seconds of a spot (pre-roll); `tail`: it ends inside a spot.
  adBreak(spots: number[], seps: number[], { lead, tail }: { lead?: number, tail?: number } = {}) {
    let start: number;
    let sepIndex = 0;
    const sep = () => this.add('black', (() => { const s = seps[sepIndex % seps.length]!; sepIndex += 1; return s; })());
    if (lead != null) {
      start = 0;
      this.add('ad', lead);
    } else {
      start = this.t + seps[0]! / 2;
    }
    sep();
    for (const s of spots) {
      this.add('ad', s);
      sep();
    }
    let end = this.t - seps[(sepIndex - 1) % seps.length]! / 2;
    if (tail != null) {
      this.add('ad', tail);
      end = this.t;
    }
    this.breaks.push([start, end]);
    return this;
  }
}

interface Case {
  name: string,
  file: string,
  timeline: Timeline,
  encode: string[],
}

const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-bf', '2', '-c:a', 'ac3', '-b:a', '128k'];
const mpeg2 = ['-vf', 'scale=720:576', '-c:v', 'mpeg2video', '-b:v', '4M', '-g', '12', '-bf', '2', '-c:a', 'mp2', '-b:a', '192k'];

const cases: Case[] = [
  {
    // three breaks inside the programme, with traps around them. SD MPEG-2 like DVB broadcasts.
    name: 'three breaks + traps (mpeg2 720x576)',
    file: 'three-breaks.ts',
    timeline: new Timeline()
      .program(40).fade(0.6).program(54)
      .adBreak([30, 15, 15, 30], [0.52, 0.4, 0.6, 0.32])
      .program(50).dark(8).program(62)
      .adBreak([15, 15, 15, 20], [0.4, 1, 0.52])
      // trap: a black + silent fade exactly 30 s (a spot length) after the break
      .program(30).fade(0.6).program(70)
      .adBreak([30, 45], [0.8, 0.4])
      .program(60),
    encode: mpeg2,
  },
  {
    // the recording starts and ends inside ad breaks
    name: 'pre-roll and post-roll (h264)',
    file: 'pre-post-roll.ts',
    timeline: new Timeline()
      .adBreak([15, 30], [0.52, 0.4], { lead: 11 })
      .program(70).fade(0.6).program(80)
      .adBreak([30, 15], [0.4, 0.6], { tail: 7 }),
    encode: h264,
  },
  {
    // no ads at all: fades 30 s apart, three fades 15 s apart, and a dark scene must not become breaks
    name: 'no ads (h264)',
    file: 'no-ads.ts',
    timeline: new Timeline()
      .program(50).fade(0.6).program(30).fade(0.6).program(60)
      .dark(10).program(40)
      .fade(0.4).program(15).fade(0.4).program(15).fade(0.4).program(60),
    encode: h264,
  },
  {
    // full HD, mainly to measure the speed of the analysis on a realistic resolution
    name: 'speed (h264 1920x1080)',
    file: 'hd.ts',
    timeline: new Timeline()
      .program(60)
      .adBreak([15, 30, 15], [0.4, 0.52])
      .program(60),
    encode: ['-vf', 'scale=1920:1080', ...h264],
  },
];

const pool = async <T>(items: T[], n: number, fn: (item: T) => Promise<void>) => {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let item = queue.shift(); item != null; item = queue.shift()) await fn(item);
  }));
};

async function generate(c: Case) {
  const outPath = join(workDir, c.file);
  const stampPath = `${outPath}.json`;
  const stamp = JSON.stringify({ pieces: c.timeline.pieces, encode: c.encode, v: 2 });
  try {
    if (await readFile(stampPath, 'utf8') === stamp) return outPath;
  } catch { /* generate */ }

  const pieceDir = join(workDir, `${c.file}-pieces`);
  await mkdir(pieceDir, { recursive: true });
  const files = c.timeline.pieces.map((_p, i) => join(pieceDir, `${String(i).padStart(3, '0')}.nut`));
  await pool(c.timeline.pieces.map((p, i) => ({ p, i })), 4, async ({ p, i }) => {
    const [v, a] = pieceSources(p);
    await runner.ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', v, '-f', 'lavfi', '-i', a,
      '-t', String(p.dur), '-ac', '2', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', files[i]!]);
  });
  const listPath = join(pieceDir, 'list.txt');
  await writeFile(listPath, files.map((f) => `file '${f.replaceAll('\\', '/')}'`).join('\n'));
  await runner.ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, ...c.encode, '-f', 'mpegts', outPath]);
  await writeFile(stampPath, stamp);
  return outPath;
}

// ---------------------------------------------------------------------------------------------

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) failures += 1;
};
const fmt = (n: number) => n.toFixed(2);

await mkdir(workDir, { recursive: true });
let totalAnalysis = 0;
let totalMinutes = 0;

for (const c of cases) {
  if (filter != null && !c.name.includes(filter)) continue;
  console.log(`\n=== ${c.name} (${fmt(c.timeline.t)} s)`);
  const t0 = Date.now();
  const path = await generate(c);
  console.log(`generated in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${path}`);

  let lastProgress = 0;
  const result = await detectAdBreaks({ runner, path, onProgress: (p) => { lastProgress = p; } });
  const { breaks, markers, stats } = result;
  totalAnalysis += stats.analysisSeconds;
  totalMinutes += stats.duration / 60;
  console.log(`analysis: ${stats.analysisSeconds} s for ${fmt(stats.duration)} s = ${stats.secondsPerMinute} s per minute of video`);
  console.log(`markers: ${markers.length} (${stats.silentMarkers} silent), cuts: ${stats.sceneCuts}, programme: ${stats.programLoudnessDb} dB, ${stats.programCutsPerMinute} cuts/min`);
  for (const b of breaks) console.log(`  break ${fmt(b.start)} - ${fmt(b.end)} conf ${b.confidence}: ${b.reasons.join('; ')}`);

  check(lastProgress === 1, 'progress reaches 1');
  check(Math.abs(stats.duration - c.timeline.t) < 1, `duration ${fmt(stats.duration)} ≈ ${fmt(c.timeline.t)}`);
  const matched = new Set<number>();
  for (const [ps, pe] of c.timeline.breaks) {
    const i = breaks.findIndex((b) => Math.abs(b.start - ps) <= 1 && Math.abs(b.end - pe) <= 1);
    if (i !== -1) matched.add(i);
    const b = breaks[i];
    check(b != null, `planted break ${fmt(ps)} - ${fmt(pe)} detected${b ? ` as ${fmt(b.start)} - ${fmt(b.end)} (Δ ${fmt(b.start - ps)} / ${fmt(b.end - pe)})` : ''}`);
  }
  breaks.forEach((b, i) => {
    if (!matched.has(i)) check(false, `false break ${fmt(b.start)} - ${fmt(b.end)}`);
  });
  if (c.timeline.breaks.length === 0) check(breaks.length === 0, 'no breaks detected');
}

console.log(`\nspeed: ${fmt(totalAnalysis)} s for ${fmt(totalMinutes)} min = ${fmt(totalAnalysis / Math.max(totalMinutes, 1e-9))} s per minute of video`);
console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
