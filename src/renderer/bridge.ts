import type { VideoCutApi } from '../shared/api';
import type { FfRunner } from '../engine/smartRender';
import type { JoinRunner } from '../engine/smartJoin';
import { withReliableIntervals } from '../engine/smartJoin';

declare global {
  interface Window { videocut: VideoCutApi }
}

export const vc = window.videocut;

let jobCounter = 0;
export function newJobId(prefix: string) {
  jobCounter += 1;
  return `${prefix}-${jobCounter}`;
}

// An FfRunner for the engines, running ffmpeg/ffprobe in the main process.
// With `duration` and `onProgress`, each ffmpeg run reports its progress (from ffmpeg's "time=").
// ffprobe reads with -read_intervals are checked and retried, because they sometimes come back empty.
export function createRunner({ jobId = newJobId('job'), duration, onProgress }: { jobId?: string, duration?: number | undefined, onProgress?: ((p: number) => void) | undefined } = {}) {
  let unsubscribe: (() => void) | undefined;
  if (onProgress != null) {
    unsubscribe = vc.onProgress((id, p) => {
      if (id === jobId) onProgress(p);
    });
  }
  const runner: FfRunner = withReliableIntervals({
    ffprobe: (args) => vc.ffprobe(args),
    ffmpeg: (args) => vc.ffmpeg(args, { jobId, duration }),
  });
  const joinRunner: JoinRunner = {
    ...runner,
    writeFile: (path, content) => vc.writeText(path, content),
    removeFile: (path) => vc.remove(path),
  };
  return {
    jobId,
    runner: joinRunner,
    exists: (path: string) => vc.exists(path),
    cancel: () => vc.cancel(jobId),
    dispose: () => unsubscribe?.(),
  };
}

export function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // ipc errors come wrapped: "Error invoking remote method 'ffmpeg': Error: ..."
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export const isCancelled = (err: unknown) => /Cancelled|aborted/i.test(errorText(err));

// Runner for the task panels and the queue. All of them can be stopped at once with cancelTasks().
export function createTaskRunner(options: { duration?: number | undefined, onProgress?: ((p: number) => void) | undefined } = {}) {
  return createRunner({ jobId: newJobId('task'), ...options }).runner;
}

export function cancelTasks() {
  return vc.cancel('task-*');
}
