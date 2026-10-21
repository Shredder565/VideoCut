import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { app } from 'electron';

// ffmpeg and ffprobe ship next to the app: resources/ffmpeg when packaged, ffmpeg/win-x64 in the project when developing
function ffmpegDir() {
  return app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : join(app.getAppPath(), 'ffmpeg', 'win-x64');
}

export function toolPath(tool: 'ffmpeg' | 'ffprobe') {
  return join(ffmpegDir(), process.platform === 'win32' ? `${tool}.exe` : tool);
}

const running = new Map<string, Set<ChildProcess>>();

function track(jobId: string, child: ChildProcess) {
  let set = running.get(jobId);
  if (set == null) {
    set = new Set();
    running.set(jobId, set);
  }
  set.add(child);
  child.once('close', () => {
    set.delete(child);
    if (set.size === 0) running.delete(jobId);
  });
}

// jobId: one job, "prefix-*": every job whose id starts with "prefix-", undefined: everything
export function cancel(jobId?: string) {
  const jobs = jobId == null
    ? [...running.values()]
    : (jobId.endsWith('*') ? [...running.entries()].filter(([id]) => id.startsWith(jobId.slice(0, -1))).map(([, set]) => set) : [running.get(jobId)]);
  jobs.forEach((set) => set?.forEach((child) => child.kill()));
}

export class ToolError extends Error {
  constructor(message: string, readonly stderr: string, readonly cancelled: boolean) {
    super(message);
    this.name = 'ToolError';
  }
}

// "time=00:01:02.50" -> 62.5
function parseProgressTime(text: string) {
  const matches = [...text.matchAll(/time=\s*(-?)(\d+):(\d+):([\d.]+)/g)];
  const last = matches.at(-1);
  if (last == null) return undefined;
  const seconds = Number(last[2]) * 3600 + Number(last[3]) * 60 + Number(last[4]);
  return last[1] === '-' ? -seconds : seconds;
}

// Runs ffmpeg or ffprobe. Resolves with everything written to stdout and stderr, or rejects with the end of stderr.
export function run(tool: 'ffmpeg' | 'ffprobe', args: string[], { jobId = 'default', duration, onProgress }: {
  jobId?: string | undefined,
  duration?: number | undefined,
  onProgress?: ((progress: number) => void) | undefined,
} = {}) {
  return new Promise<{ stdout: Buffer, stderr: string }>((resolve, reject) => {
    const child = spawn(toolPath(tool), args, { windowsHide: true });
    track(jobId, child);
    const out: Buffer[] = [];
    const err: string[] = [];
    let cancelled = false;
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err.push(chunk);
      if (onProgress != null && duration != null && duration > 0) {
        const t = parseProgressTime(chunk);
        if (t != null) onProgress(Math.max(0, Math.min(1, t / duration)));
      }
    });
    child.once('error', reject);
    child.once('exit', (_code, signal) => {
      if (signal != null) cancelled = true;
    });
    child.once('close', (code) => {
      const stderr = err.join('');
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out), stderr });
        return;
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
      reject(new ToolError(cancelled ? 'Cancelled' : `${tool} failed (exit code ${code}): ${tail}`, stderr, cancelled));
    });
  });
}

// Starts ffmpeg and hands back the process, for streaming its output (preview playback)
export function start(args: string[], jobId: string) {
  const child = spawn(toolPath('ffmpeg'), args, { windowsHide: true });
  track(jobId, child);
  return child;
}
