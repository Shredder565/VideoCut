import { describe, it, expect } from 'vitest';

import { BatchQueue, type BatchJob, type BatchQueueEvent, type RunJob, type RunJobContext } from './batchQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async () => new Promise<void>((r) => setTimeout(r, 0));

function makeQueue() {
  let time = 1000;
  let id = 0;
  const queue = new BatchQueue({
    now: () => {
      time += 1;
      return time;
    },
    createId: () => {
      id += 1;
      return `j${id}`;
    },
  });
  const events: BatchQueueEvent[] = [];
  queue.subscribe((e) => events.push(e));
  return { queue, events };
}

// a runJob whose jobs finish only when the test says so
function controlledRunner() {
  const calls: { job: BatchJob, context: RunJobContext, result: ReturnType<typeof deferred<{ outputPaths: string[] }>> }[] = [];
  const runJob: RunJob = async (job, context) => {
    const result = deferred<{ outputPaths: string[] }>();
    calls.push({ job, context, result });
    return result.promise;
  };
  return { runJob, calls };
}

const statuses = (queue: BatchQueue) => queue.jobs.map((j) => `${j.id}:${j.status}`);

describe('editing', () => {
  it('adds jobs with defaults', () => {
    const { queue, events } = makeQueue();
    const job = queue.add({ kind: 'export', inputPaths: ['/a.mp4'], outputDir: '/out', options: { format: 'mp4' } });
    expect(job).toEqual({ id: 'j1', kind: 'export', inputPaths: ['/a.mp4'], outputDir: '/out', options: { format: 'mp4' }, status: 'queued', progress: 0, createdAt: 1001 });
    queue.add({ kind: 'join', inputPaths: ['/a.mp4', '/b.mp4'] });
    expect(queue.jobs.map((j) => j.id)).toEqual(['j1', 'j2']);
    expect(queue.getJob('j2')!.options).toEqual({});
    expect(events).toEqual([{ type: 'added', jobId: 'j1' }, { type: 'added', jobId: 'j2' }]);
  });

  it('rejects unknown kinds and duplicate ids', () => {
    const { queue } = makeQueue();
    // @ts-expect-error testing invalid input
    expect(() => queue.add({ kind: 'nope', inputPaths: [] })).toThrow(/kind/);
    queue.add({ kind: 'export', inputPaths: [], id: 'x' });
    expect(() => queue.add({ kind: 'export', inputPaths: [], id: 'x' })).toThrow(/Duplicate/);
  });

  it('returns snapshots that do not change the queue', () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: ['/a'], options: { a: 1 } });
    const snapshot = queue.jobs[0]!;
    snapshot.inputPaths.push('/b');
    snapshot.options['a'] = 2;
    snapshot.status = 'done';
    expect(queue.getJob('j1')).toMatchObject({ inputPaths: ['/a'], options: { a: 1 }, status: 'queued' });
  });

  it('removes, moves and reorders jobs', () => {
    const { queue, events } = makeQueue();
    queue.addMany([1, 2, 3, 4].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`] })));
    expect(queue.move('j4', 0)).toBe(true);
    expect(queue.jobs.map((j) => j.id)).toEqual(['j4', 'j1', 'j2', 'j3']);
    expect(queue.move('j4', 99)).toBe(true);
    expect(queue.jobs.map((j) => j.id)).toEqual(['j1', 'j2', 'j3', 'j4']);
    expect(queue.reorder(['j3', 'j1', 'unknown'])).toBe(true);
    expect(queue.jobs.map((j) => j.id)).toEqual(['j3', 'j1', 'j2', 'j4']);
    expect(queue.reorder(['j3', 'j1'])).toBe(false);
    expect(queue.remove('j1')).toBe(true);
    expect(queue.remove('j1')).toBe(false);
    expect(queue.jobs.map((j) => j.id)).toEqual(['j3', 'j2', 'j4']);
    expect(events.filter((e) => e.type === 'reordered')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'removed', jobId: 'j1' });
  });

  it('updates jobs that are not running', () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: ['/a'], outputDir: '/out' });
    expect(queue.update('j1', { options: { x: 1 }, outputDir: undefined, inputPaths: ['/b'] })).toBe(true);
    expect(queue.getJob('j1')).toMatchObject({ options: { x: 1 }, outputDir: undefined, inputPaths: ['/b'] });
    expect(queue.update('missing', { options: {} })).toBe(false);
  });

  it('cancels queued jobs and retries finished ones', () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: [] });
    expect(queue.retry('j1')).toBe(false);
    expect(queue.cancel('j1')).toBe(true);
    expect(queue.getJob('j1')).toMatchObject({ status: 'cancelled', finishedAt: 1002 });
    expect(queue.cancel('j1')).toBe(false);
    expect(queue.retry('j1')).toBe(true);
    const job = queue.getJob('j1')!;
    expect(job.status).toBe('queued');
    expect(job.finishedAt).toBeUndefined();
    expect(queue.clearFinished()).toBe(0);
    queue.cancel('j1');
    expect(queue.clearFinished()).toBe(1);
    expect(queue.jobs).toEqual([]);
  });
});

describe('running', () => {
  it('runs jobs one at a time in queue order and records results', async () => {
    const { queue, events } = makeQueue();
    queue.addMany([1, 2, 3].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`] })));
    queue.move('j3', 0);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const done = queue.run({
      runJob: async (job, { onProgress }) => {
        order.push(job.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        expect(queue.getJob(job.id)!.status).toBe('running');
        onProgress(0.5);
        await tick();
        active -= 1;
        return { outputPaths: [`${job.inputPaths[0]}.out`] };
      },
    });
    expect(queue.isProcessing).toBe(true);
    await done;
    expect(queue.isProcessing).toBe(false);
    expect(order).toEqual(['j3', 'j1', 'j2']);
    expect(maxActive).toBe(1);
    for (const job of queue.jobs) {
      expect(job.status).toBe('done');
      expect(job.progress).toBe(1);
      expect(job.outputPaths).toEqual([`${job.inputPaths[0]}.out`]);
      expect(job.startedAt).toBeGreaterThan(job.createdAt);
      expect(job.finishedAt).toBeGreaterThan(job.startedAt!);
    }
    expect(events.filter((e) => e.type === 'progress')).toEqual([
      { type: 'progress', jobId: 'j3', progress: 0.5 },
      { type: 'progress', jobId: 'j1', progress: 0.5 },
      { type: 'progress', jobId: 'j2', progress: 0.5 },
    ]);
    expect(events.at(-1)).toEqual({ type: 'drained' });
    expect(queue.progress).toBe(1);
  });

  it('continues after a failure', async () => {
    const { queue } = makeQueue();
    queue.addMany([1, 2, 3].map((n) => ({ kind: 'streamFix' as const, inputPaths: [`/${n}`] })));
    await queue.run({
      runJob: async (job) => {
        if (job.id === 'j2') throw new Error('ffmpeg exited with code 1');
        // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
        if (job.id === 'j3') throw 'plain string';
        return { outputPaths: [] };
      },
    });
    expect(statuses(queue)).toEqual(['j1:done', 'j2:failed', 'j3:failed']);
    expect(queue.getJob('j2')!.error).toBe('ffmpeg exited with code 1');
    expect(queue.getJob('j3')!.error).toBe('plain string');

    // retry the failed ones
    expect(queue.retryFailed()).toBe(2);
    await queue.run({ runJob: async () => ({ outputPaths: ['/ok'] }) });
    expect(statuses(queue)).toEqual(['j1:done', 'j2:done', 'j3:done']);
    expect(queue.getJob('j2')!.error).toBeUndefined();
  });

  it('handles a runJob that throws synchronously', async () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: [] });
    await queue.run({ runJob: () => { throw new Error('sync'); } });
    expect(queue.getJob('j1')).toMatchObject({ status: 'failed', error: 'sync' });
  });

  it('cancels the running job via its AbortSignal and moves on', async () => {
    const { queue } = makeQueue();
    queue.addMany([1, 2].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`] })));
    const { runJob, calls } = controlledRunner();
    const done = queue.run({ runJob });
    await tick();
    expect(calls.map((c) => c.job.id)).toEqual(['j1']);
    const { context, result } = calls[0]!;
    context.signal.addEventListener('abort', () => result.reject(new Error('aborted')));

    expect(queue.cancel('j1')).toBe(true);
    expect(context.signal.aborted).toBe(true);
    expect(queue.getJob('j1')!.status).toBe('cancelled');
    // progress after cancelling is ignored
    context.onProgress(0.7);
    expect(queue.getJob('j1')!.progress).toBe(0);
    await tick();
    expect(calls.map((c) => c.job.id)).toEqual(['j1', 'j2']);
    calls[1]!.result.resolve({ outputPaths: ['/2.out'] });
    await done;
    expect(statuses(queue)).toEqual(['j1:cancelled', 'j2:done']);
  });

  it('marks a job cancelled when it fails because its signal was aborted', async () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: [] });
    const { runJob, calls } = controlledRunner();
    const done = queue.run({ runJob });
    await tick();
    // e.g. the app aborts the job's ffmpeg through the signal, and runJob rejects
    calls[0]!.context.signal.addEventListener('abort', () => calls[0]!.result.reject(new Error('killed')));
    queue.cancel('j1');
    await done;
    expect(queue.getJob('j1')).toMatchObject({ status: 'cancelled' });
    expect(queue.getJob('j1')!.error).toBeUndefined();
  });

  it('waits for a cancelled job to settle before starting the next one', async () => {
    const { queue } = makeQueue();
    queue.addMany([1, 2].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`] })));
    const { runJob, calls } = controlledRunner();
    const done = queue.run({ runJob });
    await tick();
    queue.cancel('j1'); // runJob ignores the signal for now
    await tick();
    expect(calls).toHaveLength(1);
    // a job that finishes after being cancelled stays cancelled
    calls[0]!.result.resolve({ outputPaths: ['/late'] });
    await tick();
    expect(queue.getJob('j1')).toMatchObject({ status: 'cancelled' });
    expect(queue.getJob('j1')!.outputPaths).toBeUndefined();
    expect(calls).toHaveLength(2);
    calls[1]!.result.resolve({ outputPaths: [] });
    await done;
  });

  it('pauses and resumes', async () => {
    const { queue, events } = makeQueue();
    queue.addMany([1, 2, 3].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`] })));
    const { runJob, calls } = controlledRunner();
    let drained = false;
    const done = queue.run({ runJob }).then(() => { drained = true; });
    await tick();
    queue.pause();
    expect(queue.paused).toBe(true);
    // the running job continues
    calls[0]!.result.resolve({ outputPaths: [] });
    await tick();
    await tick();
    expect(calls).toHaveLength(1);
    expect(statuses(queue)).toEqual(['j1:done', 'j2:queued', 'j3:queued']);
    expect(drained).toBe(false);

    queue.resume();
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]!.result.resolve({ outputPaths: [] });
    await tick();
    calls[2]!.result.resolve({ outputPaths: [] });
    await done;
    expect(drained).toBe(true);
    expect(events.filter((e) => e.type === 'paused' || e.type === 'resumed').map((e) => e.type)).toEqual(['paused', 'resumed']);
  });

  it('does not start jobs when created paused', async () => {
    const queue = new BatchQueue({ paused: true });
    queue.add({ kind: 'export', inputPaths: [] });
    let started = 0;
    // eslint-disable-next-line no-void
    void queue.run({ runJob: async () => { started += 1; return { outputPaths: [] }; } });
    await tick();
    expect(started).toBe(0);
    queue.resume();
    await tick();
    expect(started).toBe(1);
  });

  it('runs jobs added while processing', async () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: ['/1'] });
    const ran: string[] = [];
    await queue.run({
      runJob: async (job) => {
        ran.push(job.id);
        if (job.id === 'j1') queue.add({ kind: 'join', inputPaths: ['/2'] });
        return { outputPaths: [] };
      },
    });
    expect(ran).toEqual(['j1', 'j2']);
  });

  it('removes a running job and aborts it', async () => {
    const { queue } = makeQueue();
    queue.addMany([1, 2].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`] })));
    const { runJob, calls } = controlledRunner();
    const done = queue.run({ runJob });
    await tick();
    expect(queue.remove('j1')).toBe(true);
    expect(calls[0]!.context.signal.aborted).toBe(true);
    calls[0]!.result.reject(new Error('aborted'));
    await tick();
    expect(calls.map((c) => c.job.id)).toEqual(['j1', 'j2']);
    calls[1]!.result.resolve({ outputPaths: [] });
    await done;
    expect(statuses(queue)).toEqual(['j2:done']);
  });

  it('respects concurrency', async () => {
    const { queue } = makeQueue();
    queue.addMany([1, 2, 3, 4, 5].map((n) => ({ kind: 'adDetect' as const, inputPaths: [`/${n}`] })));
    const { runJob, calls } = controlledRunner();
    const done = queue.run({ runJob, concurrency: 2 });
    await tick();
    expect(calls.map((c) => c.job.id)).toEqual(['j1', 'j2']);
    expect(queue.runningJobIds).toEqual(['j1', 'j2']);
    calls[1]!.result.resolve({ outputPaths: [] });
    await tick();
    expect(calls.map((c) => c.job.id)).toEqual(['j1', 'j2', 'j3']);
    for (const c of calls) c.result.resolve({ outputPaths: [] });
    await tick();
    for (const c of calls) c.result.resolve({ outputPaths: [] });
    await tick();
    for (const c of calls) c.result.resolve({ outputPaths: [] });
    await done;
    expect(queue.jobs.every((j) => j.status === 'done')).toBe(true);
  });

  it('clamps progress and ignores invalid values', async () => {
    const { queue } = makeQueue();
    queue.add({ kind: 'export', inputPaths: [] });
    const seen: number[] = [];
    queue.subscribe((e) => { if (e.type === 'progress') seen.push(e.progress); });
    await queue.run({
      runJob: async (_job, { onProgress }) => {
        onProgress(-1);
        onProgress(0.25);
        onProgress(Number.NaN);
        onProgress(2);
        return { outputPaths: [] };
      },
    });
    expect(seen).toEqual([0.25, 1]);
  });

  it('keeps working when a listener throws', async () => {
    const { queue } = makeQueue();
    const original = console.error;
    console.error = () => undefined;
    try {
      queue.subscribe(() => { throw new Error('listener bug'); });
      queue.add({ kind: 'export', inputPaths: [] });
      await queue.run({ runJob: async () => ({ outputPaths: [] }) });
    } finally {
      console.error = original;
    }
    expect(queue.getJob('j1')!.status).toBe('done');
  });

  it('unsubscribes listeners', () => {
    const { queue } = makeQueue();
    const seen: BatchQueueEvent[] = [];
    const unsubscribe = queue.subscribe((e) => seen.push(e));
    queue.add({ kind: 'export', inputPaths: [] });
    unsubscribe();
    queue.add({ kind: 'export', inputPaths: [] });
    expect(seen).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('round-trips through JSON, re-queueing running jobs', async () => {
    const { queue } = makeQueue();
    queue.addMany([1, 2, 3, 4].map((n) => ({ kind: 'export' as const, inputPaths: [`/${n}`], options: { n } })));
    const { runJob, calls } = controlledRunner();
    // eslint-disable-next-line no-void
    void queue.run({ runJob });
    await tick();
    calls[0]!.result.resolve({ outputPaths: ['/1.out'] });
    await tick();
    calls[1]!.context.onProgress(0.4);
    queue.cancel('j4');
    queue.pause();

    const json = JSON.stringify(queue);
    expect(statuses(queue)).toEqual(['j1:done', 'j2:running', 'j3:queued', 'j4:cancelled']);

    const restored = BatchQueue.fromJSON(json);
    expect(restored.paused).toBe(true);
    expect(statuses(restored)).toEqual(['j1:done', 'j2:queued', 'j3:queued', 'j4:cancelled']);
    const j2 = restored.getJob('j2')!;
    expect(j2.progress).toBe(0);
    expect(j2.startedAt).toBeUndefined();
    expect(restored.getJob('j1')).toMatchObject({ outputPaths: ['/1.out'], options: { n: 1 }, progress: 1 });
    expect(restored.getJob('j4')!.finishedAt).toBeDefined();

    restored.resume();
    await restored.run({ runJob: async () => ({ outputPaths: [] }) });
    expect(statuses(restored)).toEqual(['j1:done', 'j2:done', 'j3:done', 'j4:cancelled']);
  });

  it('accepts an object and drops invalid or duplicate jobs', () => {
    const valid: BatchJob = { id: 'a', kind: 'join', inputPaths: ['/x'], options: {}, status: 'failed', progress: 0.3, error: 'boom', createdAt: 5 };
    const restored = BatchQueue.fromJSON({
      version: 1,
      paused: false,
      jobs: [valid, { ...valid }, { ...valid, id: 'b', kind: 'bogus' }, { ...valid, id: 'c', inputPaths: 'nope' }, null, { ...valid, id: 'd', status: 'running' }],
    });
    expect(statuses(restored)).toEqual(['a:failed', 'd:queued']);
    expect(restored.getJob('a')).toEqual(valid);
  });

  it('rejects unknown versions', () => {
    expect(() => BatchQueue.fromJSON({ version: 2, jobs: [] })).toThrow(/Unsupported/);
    expect(() => BatchQueue.fromJSON(null)).toThrow(/Unsupported/);
  });
});
