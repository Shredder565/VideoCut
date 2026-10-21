import type { IconType } from 'react-icons';
import { memo, useCallback } from 'react';
import { FiFilm, FiFolder, FiLink, FiPause, FiPlay, FiRotateCcw, FiTool, FiTrash2, FiTv, FiX, FiPlus, FiArrowUp } from 'react-icons/fi';

import type { BatchJob, BatchJobKind, BatchJobStatus, BatchQueue } from '../../engine/batchQueue';
import { PanelHeader, t, basename } from './common';
import { vc } from '../bridge';


const kindInfo: Record<BatchJobKind, { Icon: IconType, label: string }> = {
  export: { Icon: FiFilm, label: 'Export clips' },
  streamFix: { Icon: FiTool, label: 'Repair' },
  adDetect: { Icon: FiTv, label: 'Find ads' },
  join: { Icon: FiLink, label: 'Join' },
};

const statusColor: Record<BatchJobStatus, string> = {
  queued: 'var(--text-muted)',
  running: 'var(--accent-text)',
  done: 'var(--green)',
  failed: 'var(--red)',
  cancelled: 'var(--text-muted)',
};

function QueuePanel({ queue, jobs, paused, processing, onStart, canAddCurrent, onAddCurrent, onClose }: {
  queue: BatchQueue,
  jobs: BatchJob[],
  paused: boolean,
  processing: boolean,
  onStart: () => void,
  canAddCurrent: boolean,
  onAddCurrent: () => void,
  onClose: () => void,
}) {

  const statusText: Record<BatchJobStatus, string> = { queued: t('Waiting'), running: t('Running'), done: t('Done'), failed: t('Failed'), cancelled: t('Cancelled') };

  const addFiles = useCallback(async (kind: 'streamFix' | 'adDetect') => {
    const filePaths = await vc.openFiles({ title: kind === 'streamFix' ? t('Choose recordings to repair') : t('Choose recordings to scan for ads'), multiple: true });
    const canceled = filePaths.length === 0;
    if (canceled) return;
    queue.addMany(filePaths.map((path) => ({ kind, inputPaths: [path] })));
  }, [queue]);

  const running = processing && !paused;
  const numWaiting = jobs.filter((j) => j.status === 'queued').length;
  const numFinished = jobs.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled').length;

  return (
    <>
      <PanelHeader title={t('Queue')} subtitle={t('Jobs run one after another, so you can leave them running unattended.')} onClose={onClose} />

      <div className="row" style={{ padding: '.7em 1em', gap: '.4em', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
        {running ? (
          <button type="button" className="btn" onClick={() => queue.pause()}><FiPause /> {t('Pause')}</button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={numWaiting === 0} onClick={onStart}><FiPlay /> {t('Start')}</button>
        )}
        {numFinished > 0 && <button type="button" className="btn btn-ghost" onClick={() => queue.clearFinished()}>{t('Clear finished')}</button>}
      </div>

      <div className="row" style={{ padding: '.7em 1em', gap: '.4em', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
        <span className="label" style={{ width: '100%' }}>{t('Add jobs')}</span>
        <button type="button" className="btn" disabled={!canAddCurrent} onClick={onAddCurrent} title={t('Export the open video with its current clips')}><FiPlus /> {t('This video\'s clips')}</button>
        <button type="button" className="btn" onClick={() => addFiles('streamFix')}><FiTool /> {t('Repair files…')}</button>
        <button type="button" className="btn" onClick={() => addFiles('adDetect')}><FiTv /> {t('Find ads in files…')}</button>
      </div>

      <div style={{ flexGrow: 1, overflowY: 'auto', padding: '.7em', display: 'flex', flexDirection: 'column', gap: '.5em' }}>
        {jobs.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '.88em', padding: '.3em' }}>{t('Nothing queued yet. Add jobs here, or use "Add to queue" in Repair and Join.')}</div>}

        {jobs.map((job, index) => {
          const { Icon, label } = kindInfo[job.kind];
          const inputNames = job.inputPaths.map((p) => basename(p));
          const firstOutput = job.outputPaths?.[0];
          return (
            <div key={job.id} className="item">
              <div className="row" style={{ gap: '.5em' }}>
                <Icon style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                <span style={{ fontWeight: 600, flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.inputPaths.join('\n')}>
                  {t(label)}: {inputNames.length > 1 ? t('{{n}} files', { n: inputNames.length }) : inputNames[0]}
                </span>
                <span style={{ fontSize: '.72em', fontWeight: 700, color: statusColor[job.status] }}>{statusText[job.status]}</span>
              </div>

              {job.status === 'running' && <div className="progress"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
              {job.error != null && <div style={{ fontSize: '.78em', color: 'var(--red)' }}>{job.error}</div>}

              <div className="row" style={{ gap: 2, marginLeft: -6 }}>
                {job.status === 'queued' && index > 0 && <button type="button" className="icon-btn" title={t('Run earlier')} onClick={() => queue.move(job.id, index - 1)}><FiArrowUp /></button>}
                {job.status === 'running' && <button type="button" className="icon-btn" title={t('Cancel')} onClick={() => queue.cancel(job.id)}><FiX /></button>}
                {(job.status === 'failed' || job.status === 'cancelled') && <button type="button" className="icon-btn" title={t('Try again')} onClick={() => queue.retry(job.id)}><FiRotateCcw /></button>}
                {firstOutput != null && <button type="button" className="icon-btn" title={t('Show in folder')} onClick={() => vc.showInFolder(firstOutput)}><FiFolder /></button>}
                {job.status !== 'running' && <button type="button" className="icon-btn" title={t('Remove from queue')} onClick={() => queue.remove(job.id)}><FiTrash2 /></button>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default memo(QueuePanel);
