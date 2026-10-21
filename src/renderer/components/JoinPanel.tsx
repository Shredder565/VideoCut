import { memo, useCallback, useState } from 'react';
import { FiArrowDown, FiArrowUp, FiFolder, FiLink, FiPlay, FiPlus, FiSearch, FiTrash2, FiX, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi';

import { planJoin, runJoin } from '../../engine/smartJoin';
import type { JoinPlan, JoinResult, JoinRunner, JoinVideoAction } from '../../engine/smartJoin';
import { PanelHeader, t, basename, dirname, joinPath, extname, stripExt } from './common';
import { vc, createTaskRunner, cancelTasks } from '../bridge';


export function createJoinRunner(options: Parameters<typeof createTaskRunner>[0] = {}): JoinRunner {
  return createTaskRunner(options);
}

export function getJoinedPath({ paths, outDir }: { paths: string[], outDir: string | undefined }) {
  const first = paths[0]!;
  const ext = extname(first);
  return joinPath(outDir ?? dirname(first), `${stripExt(basename(first))} - joined${ext}`);
}

const actionLabel: Record<JoinVideoAction, { text: string, color: string }> = {
  copy: { text: 'Copied', color: 'var(--green)' },
  smart: { text: 'Re-encoded at the join', color: 'var(--amber)' },
  encode: { text: 'Re-encoded', color: 'var(--red)' },
};

// Joins several videos into one. Files that match are copied, others are converted to match the first/most common one
function JoinPanel({ customOutDir, batchFilePaths, onOpenFile, onAddToQueue, onClose }: {
  customOutDir: string | undefined,
  batchFilePaths: string[],
  onOpenFile: (path: string) => void,
  onAddToQueue: (job: { paths: string[], outPath: string }) => void,
  onClose: () => void,
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [plan, setPlan] = useState<JoinPlan>();
  const [result, setResult] = useState<JoinResult>();
  const [running, setRunning] = useState<'plan' | 'join'>();
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<string>();
  const [error, setError] = useState<string>();

  const changePaths = useCallback((fn: (p: string[]) => string[]) => {
    setPaths(fn);
    setPlan(undefined);
    setResult(undefined);
  }, []);

  const addFiles = useCallback(async () => {
    const filePaths = await vc.openFiles({ title: t('Choose videos to join'), multiple: true });
    const canceled = filePaths.length === 0;
    if (!canceled) changePaths((p) => [...p, ...filePaths]);
  }, [changePaths]);

  const move = useCallback((i: number, d: number) => changePaths((p) => {
    const next = [...p];
    const [item] = next.splice(i, 1);
    next.splice(i + d, 0, item!);
    return next;
  }), [changePaths]);

  const check = useCallback(async () => {
    setRunning('plan');
    setError(undefined);
    try {
      setPlan(await planJoin({ runner: createTaskRunner(), inputs: paths.map((path) => ({ path })) }));
    } catch (err) {
      console.error('Join planning failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(undefined);
    }
  }, [paths]);

  const outPath = paths.length > 0 ? getJoinedPath({ paths, outDir: customOutDir }) : undefined;

  const doJoin = useCallback(async () => {
    if (plan == null || outPath == null) return;
    setRunning('join');
    setError(undefined);
    setProgress(0);
    try {
      setResult(await runJoin({ runner: createJoinRunner(), plan, outPath, tempDir: dirname(outPath), onProgress: (p, s) => { setProgress(p); setStage(s); } }));
    } catch (err) {
      console.error('Join failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(undefined);
    }
  }, [outPath, plan]);

  return (
    <>
      <PanelHeader title={t('Join videos')} subtitle={t('Matching videos are joined without re-encoding. Others are converted to match, and only the joins are re-encoded where possible.')} onClose={onClose} />

      <div className="panel-body" style={{ flexGrow: 1 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={running != null} onClick={addFiles}><FiPlus /> {t('Add videos…')}</button>
          {batchFilePaths.length > 1 && paths.length === 0 && <button type="button" className="btn" onClick={() => changePaths(() => [...batchFilePaths])}>{t('Use the files list')}</button>}
          {paths.length > 0 && <button type="button" className="btn btn-ghost" disabled={running != null} onClick={() => changePaths(() => [])}>{t('Clear')}</button>}
        </div>

        {paths.map((path, i) => {
          const inputPlan = plan?.inputs[i];
          const label = inputPlan != null ? actionLabel[inputPlan.action] : undefined;
          return (
            // eslint-disable-next-line react/no-array-index-key
            <div key={`${path}-${i}`} className="item">
              <div className="row" style={{ gap: '.4em' }}>
                <span style={{ fontWeight: 700, fontSize: '.8em', color: 'var(--text-muted)' }}>{i + 1}</span>
                <span style={{ fontWeight: 600, flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>{basename(path)}</span>
                <button type="button" className="icon-btn" disabled={i === 0 || running != null} title={t('Move up')} onClick={() => move(i, -1)}><FiArrowUp /></button>
                <button type="button" className="icon-btn" disabled={i === paths.length - 1 || running != null} title={t('Move down')} onClick={() => move(i, 1)}><FiArrowDown /></button>
                <button type="button" className="icon-btn" disabled={running != null} title={t('Remove')} onClick={() => changePaths((p) => p.filter((_x, j) => j !== i))}><FiTrash2 /></button>
              </div>
              {inputPlan != null && label != null && (
                <div style={{ fontSize: '.78em' }} title={[...inputPlan.reasons, ...inputPlan.audioReasons].join('\n')}>
                  <span style={{ fontWeight: 700, color: label.color }}>{t(label.text)}</span>
                  {inputPlan.index === plan?.targetIndex && <span style={{ color: 'var(--text-muted)' }}> · {t('sets the format')}</span>}
                  {inputPlan.reasons.length > 0 && <div style={{ color: 'var(--text-muted)' }}>{inputPlan.reasons.join('; ')}</div>}
                </div>
              )}
            </div>
          );
        })}

        {paths.length >= 2 && (
          <div className="row">
            <button type="button" className={`btn${plan ? '' : ' btn-primary'}`} disabled={running != null} onClick={check}><FiSearch /> {plan ? t('Check again') : t('Check the videos')}</button>
            {running != null && <button type="button" className="btn" onClick={cancelTasks}><FiX /> {t('Cancel')}</button>}
          </div>
        )}
        {paths.length === 1 && <div style={{ fontSize: '.85em', color: 'var(--text-muted)' }}>{t('Add at least one more video.')}</div>}

        {running === 'join' && (
          <div>
            <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div style={{ fontSize: '.75em', color: 'var(--text-muted)', marginTop: '.3em' }}>{stage ?? t('Joining…')} {Math.round(progress * 100)}%</div>
          </div>
        )}
        {running === 'plan' && <div style={{ fontSize: '.8em', color: 'var(--text-muted)' }}>{t('Checking the videos…')}</div>}

        {error != null && <div style={{ color: 'var(--red)', fontSize: '.85em' }}>{error}</div>}

        {plan != null && outPath != null && running == null && result == null && (
          <>
            {plan.summary.length > paths.length && (
              <div style={{ fontSize: '.78em', color: 'var(--text-muted)' }}>{plan.summary.slice(paths.length).join(' ')}</div>
            )}
            <div style={{ fontSize: '.78em', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{t('Saves as')} {outPath}</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={doJoin}><FiLink /> {t('Join now')}</button>
              <button type="button" className="btn" onClick={() => onAddToQueue({ paths, outPath })}>{t('Add to queue')}</button>
            </div>
          </>
        )}

        {result != null && running == null && (
          <div className="item" style={{ borderColor: result.problems.length === 0 ? 'var(--green)' : 'var(--amber)' }}>
            <div className="row" style={{ fontWeight: 700 }}>
              {result.problems.length === 0 ? <FiCheckCircle style={{ color: 'var(--green)' }} /> : <FiAlertTriangle style={{ color: 'var(--amber)' }} />}
              {result.problems.length === 0 ? t('Joined') : t('Joined, with some problems')}
            </div>
            <div style={{ fontSize: '.8em' }}>{t('{{frames}} frames from {{n}} videos', { frames: result.frames, n: result.parts.length })}</div>
            {[...result.problems, ...result.warnings].map((p) => <div key={p} style={{ fontSize: '.78em', color: 'var(--amber)' }}>• {p}</div>)}
            <div className="row" style={{ marginTop: '.3em' }}>
              <button type="button" className="btn btn-primary" onClick={() => onOpenFile(result.outPath)}><FiPlay /> {t('Open it')}</button>
              <button type="button" className="btn" onClick={() => vc.showInFolder(result.outPath)}><FiFolder /> {t('Show in folder')}</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default memo(JoinPanel);
