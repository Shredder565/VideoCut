// A UI-agnostic batch job queue: jobs are run one at a time (or `concurrency` at a time) by a `runJob` function that
// the app provides. Supports adding, removing, reordering, retrying and cancelling jobs, pausing/resuming the queue,
// change events, and saving/restoring the queue (toJSON / fromJSON).
//
// No runtime imports, so it can be unit tested and driven from anywhere.

export type BatchJobKind = 'export' | 'join' | 'streamFix' | 'adDetect';
export type BatchJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export const batchJobKinds: readonly BatchJobKind[] = ['export', 'join', 'streamFix', 'adDetect'];
export const batchJobStatuses: readonly BatchJobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled'];

export interface BatchJob {
  id: string,
  kind: BatchJobKind,
  inputPaths: string[],
  outputDir?: string | undefined,
  // job specific settings, opaque to the queue
  options: Record<string, unknown>,
  status: BatchJobStatus,
  // 0..1
  progress: number,
  error?: string | undefined,
  outputPaths?: string[] | undefined,
  // ms since the epoch
  createdAt: number,
  startedAt?: number | undefined,
  finishedAt?: number | undefined,
}

export interface NewBatchJob {
  kind: BatchJobKind,
  inputPaths: string[],
  outputDir?: string | undefined,
  options?: Record<string, unknown> | undefined,
  // generated if not given
  id?: string | undefined,
}

export type BatchJobUpdate = Partial<Pick<BatchJob, 'kind' | 'inputPaths' | 'outputDir' | 'options'>>;

export interface RunJobContext {
  // report progress 0..1
  onProgress: (progress: number) => void,
  // aborted when the job is cancelled or removed
  signal: AbortSignal,
}

export type RunJob = (job: BatchJob, context: RunJobContext) => Promise<{ outputPaths: string[] }>;

export type BatchQueueEvent =
  | { type: 'added', jobId: string }
  | { type: 'removed', jobId: string }
  // status, options, error, outputs etc. changed
  | { type: 'updated', jobId: string }
  | { type: 'progress', jobId: string, progress: number }
  | { type: 'reordered' }
  | { type: 'paused' }
  | { type: 'resumed' }
  // run() finished: no queued jobs left and nothing running
  | { type: 'drained' };

// eslint-disable-next-line no-use-before-define
export type BatchQueueListener = (event: BatchQueueEvent, queue: BatchQueue) => void;

export interface SerializedBatchQueue {
  version: 1,
  paused: boolean,
  jobs: BatchJob[],
}

export interface BatchQueueOptions {
  jobs?: BatchJob[] | undefined,
  paused?: boolean | undefined,
  // for tests
  now?: (() => number) | undefined,
  createId?: (() => string) | undefined,
}

const finishedStatuses = new Set<BatchJobStatus>(['done', 'failed', 'cancelled']);

function copyJob(job: BatchJob): BatchJob {
  return {
    ...job,
    inputPaths: [...job.inputPaths],
    options: { ...job.options },
    ...(job.outputPaths != null ? { outputPaths: [...job.outputPaths] } : {}),
  };
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

let idCounter = 0;
function defaultCreateId() {
  const { crypto } = globalThis as { crypto?: { randomUUID?: () => string } };
  if (crypto?.randomUUID != null) return crypto.randomUUID();
  idCounter += 1;
  return `job-${Date.now().toString(36)}-${idCounter}`;
}

function isValidJob(value: unknown): value is BatchJob {
  if (value == null || typeof value !== 'object') return false;
  const job = value as Partial<BatchJob>;
  return typeof job.id === 'string' && job.id !== ''
    && typeof job.kind === 'string' && batchJobKinds.includes(job.kind)
    && typeof job.status === 'string' && batchJobStatuses.includes(job.status)
    && Array.isArray(job.inputPaths) && job.inputPaths.every((p) => typeof p === 'string')
    && (job.outputDir == null || typeof job.outputDir === 'string')
    && (job.options == null || typeof job.options === 'object')
    && typeof job.createdAt === 'number';
}

interface RunningEntry {
  controller: AbortController,
}

export class BatchQueue {
  #jobs: BatchJob[];

  #paused: boolean;

  #listeners = new Set<BatchQueueListener>();

  // jobs whose runJob promise hasn't settled yet (also after they were cancelled or removed)
  #running = new Map<string, RunningEntry>();

  #runJob: RunJob | undefined;

  #concurrency = 1;

  #drained: { promise: Promise<void>, resolve: () => void } | undefined;

  #now: () => number;

  #createId: () => string;

  constructor({ jobs = [], paused = false, now = Date.now, createId = defaultCreateId }: BatchQueueOptions = {}) {
    this.#jobs = jobs.map((j) => copyJob(j));
    this.#paused = paused;
    this.#now = now;
    this.#createId = createId;
  }

  // --- reading ---

  // snapshots, in queue order
  get jobs(): BatchJob[] {
    return this.#jobs.map((j) => copyJob(j));
  }

  getJob(id: string): BatchJob | undefined {
    const job = this.#find(id);
    return job != null ? copyJob(job) : undefined;
  }

  get paused() {
    return this.#paused;
  }

  // true between run() and the queue being drained
  get isProcessing() {
    return this.#drained != null;
  }

  get runningJobIds() {
    return this.#jobs.filter((j) => j.status === 'running').map((j) => j.id);
  }

  // overall progress of the jobs that are not cancelled (0..1)
  get progress() {
    const relevant = this.#jobs.filter((j) => j.status !== 'cancelled');
    if (relevant.length === 0) return 0;
    return relevant.reduce((sum, j) => sum + (j.status === 'done' || j.status === 'failed' ? 1 : j.progress), 0) / relevant.length;
  }

  // --- events ---

  subscribe(listener: BatchQueueListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: BatchQueueEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event, this);
      } catch (err) {
        console.error('BatchQueue listener failed', err);
      }
    }
  }

  // --- editing ---

  add(newJob: NewBatchJob): BatchJob {
    if (!batchJobKinds.includes(newJob.kind)) throw new Error(`Unknown job kind: ${String(newJob.kind)}`);
    if (!Array.isArray(newJob.inputPaths)) throw new Error('inputPaths must be an array');
    const id = newJob.id ?? this.#createId();
    if (this.#find(id) != null) throw new Error(`Duplicate job id: ${id}`);
    const job: BatchJob = {
      id,
      kind: newJob.kind,
      inputPaths: [...newJob.inputPaths],
      ...(newJob.outputDir != null ? { outputDir: newJob.outputDir } : {}),
      options: { ...newJob.options },
      status: 'queued',
      progress: 0,
      createdAt: this.#now(),
    };
    this.#jobs.push(job);
    this.#emit({ type: 'added', jobId: id });
    this.#pump();
    return copyJob(job);
  }

  addMany(newJobs: NewBatchJob[]) {
    return newJobs.map((j) => this.add(j));
  }

  // change a job's settings. Not allowed while it runs
  update(id: string, changes: BatchJobUpdate) {
    const job = this.#find(id);
    if (job == null || job.status === 'running') return false;
    if (changes.kind != null) {
      if (!batchJobKinds.includes(changes.kind)) throw new Error(`Unknown job kind: ${String(changes.kind)}`);
      job.kind = changes.kind;
    }
    if (changes.inputPaths != null) job.inputPaths = [...changes.inputPaths];
    if ('outputDir' in changes) job.outputDir = changes.outputDir;
    if (changes.options != null) job.options = { ...changes.options };
    this.#emit({ type: 'updated', jobId: id });
    return true;
  }

  // remove a job. A running job is cancelled (its signal is aborted) and removed right away
  remove(id: string) {
    const index = this.#jobs.findIndex((j) => j.id === id);
    if (index === -1) return false;
    this.#running.get(id)?.controller.abort(new Error('Job was removed'));
    this.#jobs.splice(index, 1);
    this.#emit({ type: 'removed', jobId: id });
    this.#pump();
    return true;
  }

  // remove all done, failed and cancelled jobs
  clearFinished() {
    const finished = this.#jobs.filter((j) => finishedStatuses.has(j.status));
    for (const job of finished) this.remove(job.id);
    return finished.length;
  }

  // move a job to a new position in the queue
  move(id: string, toIndex: number) {
    const from = this.#jobs.findIndex((j) => j.id === id);
    if (from === -1) return false;
    const [job] = this.#jobs.splice(from, 1);
    const to = Math.max(0, Math.min(Math.trunc(toIndex), this.#jobs.length));
    this.#jobs.splice(to, 0, job!);
    if (to !== from) this.#emit({ type: 'reordered' });
    return true;
  }

  // set the queue order. Jobs not listed keep their relative order, after the listed ones
  reorder(ids: string[]) {
    const byId = new Map(this.#jobs.map((j) => [j.id, j]));
    const listed = [...new Set(ids)].flatMap((id) => {
      const job = byId.get(id);
      return job != null ? [job] : [];
    });
    const listedSet = new Set(listed);
    const next = [...listed, ...this.#jobs.filter((j) => !listedSet.has(j))];
    const changed = next.some((j, i) => j !== this.#jobs[i]);
    this.#jobs = next;
    if (changed) this.#emit({ type: 'reordered' });
    return changed;
  }

  // queue a finished (done, failed or cancelled) job again
  retry(id: string) {
    const job = this.#find(id);
    if (job == null || !finishedStatuses.has(job.status)) return false;
    job.status = 'queued';
    job.progress = 0;
    delete job.error;
    delete job.outputPaths;
    delete job.startedAt;
    delete job.finishedAt;
    this.#emit({ type: 'updated', jobId: id });
    this.#pump();
    return true;
  }

  retryFailed() {
    return this.#jobs.filter((j) => j.status === 'failed').map((j) => this.retry(j.id)).filter(Boolean).length;
  }

  // cancel a queued job, or abort a running one (via its AbortSignal)
  cancel(id: string) {
    const job = this.#find(id);
    if (job == null || (job.status !== 'queued' && job.status !== 'running')) return false;
    const wasRunning = job.status === 'running';
    job.status = 'cancelled';
    job.finishedAt = this.#now();
    if (wasRunning) this.#running.get(id)?.controller.abort(new Error('Job was cancelled'));
    this.#emit({ type: 'updated', jobId: id });
    this.#pump();
    return true;
  }

  // cancel everything that is queued or running
  cancelAll() {
    return this.#jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => this.cancel(j.id)).filter(Boolean).length;
  }

  // --- running ---

  // Don't start new jobs (running jobs continue; cancel them to stop them)
  pause() {
    if (this.#paused) return;
    this.#paused = true;
    this.#emit({ type: 'paused' });
  }

  resume() {
    if (!this.#paused) return;
    this.#paused = false;
    this.#emit({ type: 'resumed' });
    this.#pump();
  }

  // Process the queued jobs in order, `concurrency` at a time, until none are left. A failed job doesn't stop the queue.
  // Jobs added while processing are run too. Resolves when the queue is drained (stays pending while paused).
  run({ runJob, concurrency = 1 }: { runJob: RunJob, concurrency?: number }): Promise<void> {
    this.#runJob = runJob;
    this.#concurrency = Math.max(1, Math.floor(concurrency));
    if (this.#drained == null) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      this.#drained = { promise, resolve };
    }
    const { promise } = this.#drained;
    this.#pump();
    return promise;
  }

  #find(id: string) {
    return this.#jobs.find((j) => j.id === id);
  }

  #pump() {
    const runJob = this.#runJob;
    if (runJob == null || this.#drained == null) return;
    while (!this.#paused && this.#running.size < this.#concurrency) {
      // a job that was cancelled and re-queued can't start until its previous run has settled
      const next = this.#jobs.find((j) => j.status === 'queued' && !this.#running.has(j.id));
      if (next == null) break;
      this.#start(next.id, runJob);
    }
    if (this.#running.size === 0 && !this.#paused && !this.#jobs.some((j) => j.status === 'queued')) {
      const drained = this.#drained;
      this.#drained = undefined;
      drained.resolve();
      this.#emit({ type: 'drained' });
    }
  }

  #start(id: string, runJob: RunJob) {
    const job = this.#find(id)!;
    const controller = new AbortController();
    const entry: RunningEntry = { controller };
    this.#running.set(job.id, entry);
    job.status = 'running';
    job.progress = 0;
    job.startedAt = this.#now();
    delete job.finishedAt;
    delete job.error;
    delete job.outputPaths;
    this.#emit({ type: 'updated', jobId: job.id });

    // still the same run of this job, and not cancelled or removed
    const isCurrent = () => this.#running.get(job.id) === entry && job.status === 'running' && this.#jobs.includes(job);

    const onProgress = (progress: number) => {
      if (!isCurrent() || !Number.isFinite(progress)) return;
      const clamped = Math.max(0, Math.min(1, progress));
      if (clamped === job.progress) return;
      job.progress = clamped;
      this.#emit({ type: 'progress', jobId: job.id, progress: clamped });
    };

    const settle = (update: () => void) => {
      if (isCurrent()) {
        update();
        job.finishedAt = this.#now();
        this.#emit({ type: 'updated', jobId: job.id });
      }
      if (this.#running.get(job.id) === entry) this.#running.delete(job.id);
      this.#pump();
    };

    let promise: Promise<{ outputPaths: string[] }>;
    try {
      promise = Promise.resolve(runJob(copyJob(job), { onProgress, signal: controller.signal }));
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (result) => settle(() => {
        job.status = 'done';
        job.progress = 1;
        job.outputPaths = [...(result?.outputPaths ?? [])];
      }),
      (err: unknown) => settle(() => {
        if (controller.signal.aborted) {
          job.status = 'cancelled';
        } else {
          job.status = 'failed';
          job.error = errorMessage(err);
        }
      }),
    );
  }

  // --- persistence ---

  toJSON(): SerializedBatchQueue {
    return { version: 1, paused: this.#paused, jobs: this.jobs };
  }

  // Restore a saved queue. Jobs that were running when it was saved are queued again; invalid entries are dropped.
  static fromJSON(data: unknown, options: Omit<BatchQueueOptions, 'jobs' | 'paused'> = {}) {
    const parsed = typeof data === 'string' ? JSON.parse(data) as unknown : data;
    if (parsed == null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) throw new Error('Unsupported batch queue data');
    const { jobs = [], paused = false } = parsed as Partial<SerializedBatchQueue>;
    const seen = new Set<string>();
    const restored = (Array.isArray(jobs) ? jobs : []).filter((j): j is BatchJob => isValidJob(j)).filter((j) => {
      if (seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    }).map((j): BatchJob => {
      const job = copyJob({ ...j, options: j.options ?? {}, progress: typeof j.progress === 'number' ? j.progress : 0 });
      if (job.status === 'running') {
        job.status = 'queued';
        job.progress = 0;
        delete job.startedAt;
        delete job.finishedAt;
      }
      return job;
    });
    return new BatchQueue({ ...options, jobs: restored, paused: paused === true });
  }
}
