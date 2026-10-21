import { useCallback, useEffect, useMemo, useState } from 'react';

import { BatchQueue } from '../engine/batchQueue';
import type { BatchJob, NewBatchJob, RunJob } from '../engine/batchQueue';

const storageKey = 'videocut-queue';

function loadSaved() {
  try {
    const json = localStorage.getItem(storageKey);
    if (json != null) return BatchQueue.fromJSON(JSON.parse(json));
  } catch (err) {
    console.warn('Could not restore the queue', err);
  }
  return new BatchQueue({ paused: true });
}

// The app's job queue: survives restarts (running jobs come back as queued), and runs jobs one at a time
export default function useQueue(runJob: RunJob) {
  const queue = useMemo(() => loadSaved(), []);
  const [jobs, setJobs] = useState<BatchJob[]>(() => queue.jobs);
  const [paused, setPaused] = useState(() => queue.paused);
  const [processing, setProcessing] = useState(false);

  useEffect(() => queue.subscribe(() => {
    setJobs(queue.jobs);
    setPaused(queue.paused);
    setProcessing(queue.isProcessing);
    try {
      localStorage.setItem(storageKey, JSON.stringify(queue.toJSON()));
    } catch (err) {
      console.warn('Could not save the queue', err);
    }
  }), [queue]);

  const start = useCallback(() => {
    queue.resume();
    queue.run({ runJob }).catch((err: unknown) => console.error('Queue failed', err));
    setProcessing(queue.isProcessing);
  }, [queue, runJob]);

  const add = useCallback((job: NewBatchJob) => queue.add(job), [queue]);

  return { queue, jobs, paused, processing, start, add };
}
