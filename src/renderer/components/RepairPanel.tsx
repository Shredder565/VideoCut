import { memo, useCallback, useState } from 'react';
import { FiAlertTriangle, FiCheckCircle, FiFile, FiFolder, FiPlay, FiSearch, FiTool, FiX } from 'react-icons/fi';

import { analyzeStream, fixStream, getDefaultFormat } from '../../engine/streamFix';
import type { StreamFixFormat, StreamFixReport, StreamFixResult } from '../../engine/streamFix';
import { PanelHeader, t, basename, dirname, joinPath, extname, stripExt } from './common';
import { vc, createTaskRunner, cancelTasks } from '../bridge';
import { formatTime } from '../media';


const formatExt: Record<StreamFixFormat, string> = { mpegts: '.ts', mpeg: '.mpg', matroska: '.mkv', mp4: '.mp4' };

export function getRepairedPath({ path, format, outDir }: { path: string, format: StreamFixFormat, outDir: string | undefined }) {
  const inExt = extname(path);
  // keep .m2ts/.mts for transport streams, so the output stays in that flavour
  const ext = format === 'mpegts' && /^\.(m2ts|mts)$/i.test(inExt) ? inExt : formatExt[format];
  return joinPath(outDir ?? dirname(path), `${stripExt(basename(path))} - repaired${ext}`);
}

// Repair: checks a recording for broken timestamps, damaged data and A/V offset, and remuxes it without re-encoding
function RepairPanel({ filePath, customOutDir, onOpenFile, onAddToQueue, onClose }: {
  filePath: string | undefined,
  customOutDir: string | undefined,
  onOpenFile: (path: string) => void,
  onAddToQueue: (job: { path: string, outPath: string, format: StreamFixFormat | undefined, tracks: 'all' | 'main', fixAvOffset: boolean }) => void,
  onClose: () => void,
}) {
  const [pickedPath, setPickedPath] = useState<string>();
  const path = pickedPath ?? filePath;
  const [running, setRunning] = useState<'analyze' | 'fix'>();
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<string>();
  const onStageProgress = useCallback((newStage: string, fraction: number) => { setStage(newStage); setProgress(fraction); }, []);
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<StreamFixReport>();
  const [result, setResult] = useState<StreamFixResult>();
  const [format, setFormat] = useState<StreamFixFormat | 'same'>('same');
  const [tracks, setTracks] = useState<'all' | 'main'>('all');
  const [fixAvOffset, setFixAvOffset] = useState(true);

  const reportForPath = report != null && report.path === path ? report : undefined;
  const effectiveFormat = format === 'same' ? (reportForPath ? getDefaultFormat(reportForPath.container) : 'mpegts') : format;

  const pickFile = useCallback(async () => {
    const filePaths = await vc.openFiles({ title: t('Choose a recording to repair'), multiple: false });
    const canceled = filePaths.length === 0;
    if (canceled || filePaths[0] == null) return;
    setPickedPath(filePaths[0]);
    setReport(undefined);
    setResult(undefined);
  }, []);

  const analyze = useCallback(async () => {
    if (path == null) return;
    setRunning('analyze');
    setError(undefined);
    setResult(undefined);
    setProgress(0);
    try {
      setReport(await analyzeStream({ runner: createTaskRunner(), path, onProgress: onStageProgress }));
    } catch (err) {
      console.error('Stream analysis failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(undefined);
    }
  }, [onStageProgress, path]);

  const fix = useCallback(async () => {
    if (path == null || reportForPath == null) return;
    setRunning('fix');
    setError(undefined);
    setProgress(0);
    try {
      const outPath = getRepairedPath({ path, format: effectiveFormat, outDir: customOutDir });
      const runner = createTaskRunner({ duration: reportForPath.contentDuration ?? reportForPath.duration, onProgress: (p) => setProgress(0.35 + p * 0.55) });
      setResult(await fixStream({ runner, path, outPath, report: reportForPath, options: { format: effectiveFormat, tracks, fixAvOffset }, onProgress: onStageProgress }));
    } catch (err) {
      console.error('Stream fix failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(undefined);
    }
  }, [customOutDir, effectiveFormat, fixAvOffset, onStageProgress, path, reportForPath, tracks]);

  const addToQueue = useCallback(() => {
    if (path == null) return;
    onAddToQueue({ path, outPath: getRepairedPath({ path, format: effectiveFormat, outDir: customOutDir }), format: format === 'same' ? undefined : format, tracks, fixAvOffset });
  }, [customOutDir, effectiveFormat, fixAvOffset, format, onAddToQueue, path, tracks]);

  return (
    <>
      <PanelHeader title={t('Repair a recording')} subtitle={t('Fixes broken timestamps, glitches and out of sync sound in TV recordings. Nothing is re-encoded.')} onClose={onClose} />

      <div className="panel-body" style={{ flexGrow: 1 }}>
        <div className="item" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <FiFile style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={path}>{path != null ? basename(path) : t('No file chosen')}</span>
          <button type="button" className="btn" onClick={pickFile} disabled={running != null}>{t('Choose…')}</button>
        </div>
        {pickedPath != null && filePath != null && pickedPath !== filePath && (
          <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => { setPickedPath(undefined); setReport(undefined); setResult(undefined); }}>{t('Use the open video instead')}</button>
        )}

        <div className="row">
          <button type="button" className={`btn${reportForPath ? '' : ' btn-primary'}`} disabled={path == null || running != null} onClick={analyze}><FiSearch /> {reportForPath ? t('Check again') : t('Check for problems')}</button>
          {running != null && <button type="button" className="btn" onClick={cancelTasks}><FiX /> {t('Cancel')}</button>}
        </div>

        {running != null && (
          <div>
            <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div style={{ fontSize: '.75em', color: 'var(--text-muted)', marginTop: '.3em' }}>{stage ?? (running === 'analyze' ? t('Checking…') : t('Repairing…'))} {Math.round(progress * 100)}%</div>
          </div>
        )}

        {error != null && <div style={{ color: 'var(--red)', fontSize: '.85em' }}>{error}</div>}

        {reportForPath != null && running == null && (
          <>
            <div className="item" style={{ borderColor: reportForPath.needsFix ? 'var(--amber)' : 'var(--green)' }}>
              <div className="row" style={{ fontWeight: 700 }}>
                {reportForPath.needsFix ? <FiAlertTriangle style={{ color: 'var(--amber)' }} /> : <FiCheckCircle style={{ color: 'var(--green)' }} />}
                {reportForPath.needsFix ? t('Problems found') : t('This recording looks fine')}
              </div>
              {reportForPath.problems.map((p) => <div key={p} style={{ fontSize: '.82em' }}>• {p}</div>)}
              {reportForPath.notes.map((n) => <div key={n} style={{ fontSize: '.78em', color: 'var(--text-muted)' }}>{n}</div>)}
              <div style={{ fontSize: '.75em', color: 'var(--text-muted)', marginTop: '.2em' }}>
                {reportForPath.container}
                {reportForPath.contentDuration != null && ` · ${formatTime(reportForPath.contentDuration, { short: true })}`}
                {reportForPath.avOffset != null && ` · ${t('sound starts {{ms}} ms after the picture', { ms: Math.round(reportForPath.avOffset * 1000) })}`}
              </div>
            </div>

            <div className="label">{t('Output')}</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <select className="input" value={format} onChange={(e) => setFormat(e.target.value as StreamFixFormat | 'same')}>
                <option value="same">{t('Same type as the recording')}</option>
                <option value="mpegts">MPEG-TS (.ts)</option>
                <option value="matroska">Matroska (.mkv)</option>
                <option value="mp4">MP4 (.mp4)</option>
                <option value="mpeg">MPEG-PS (.mpg)</option>
              </select>
              <select className="input" value={tracks} onChange={(e) => setTracks(e.target.value as 'all' | 'main')}>
                <option value="all">{t('Keep all tracks')}</option>
                <option value="main">{t('Main picture and sound only')}</option>
              </select>
            </div>
            <div className="row" style={{ fontSize: '.85em' }}>
              <input id="tw-repair-av" type="checkbox" checked={fixAvOffset} onChange={(e) => setFixAvOffset(e.target.checked)} />
              <label htmlFor="tw-repair-av" style={{ cursor: 'pointer' }}>{t('Start picture and sound together')}</label>
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary" onClick={fix}><FiTool /> {reportForPath.needsFix ? t('Repair') : t('Remux anyway')}</button>
              <button type="button" className="btn" onClick={addToQueue}>{t('Add to queue')}</button>
            </div>
          </>
        )}

        {result != null && running == null && (
          <div className="item" style={{ borderColor: result.ok ? 'var(--green)' : 'var(--amber)' }}>
            <div className="row" style={{ fontWeight: 700 }}>
              {result.ok ? <FiCheckCircle style={{ color: 'var(--green)' }} /> : <FiAlertTriangle style={{ color: 'var(--amber)' }} />}
              {result.ok ? t('Repaired') : t('Repaired, with some problems left')}
            </div>
            {result.actions.map((a) => <div key={a} style={{ fontSize: '.8em' }}>• {a}</div>)}
            {result.remainingProblems.map((p) => <div key={p} style={{ fontSize: '.8em', color: 'var(--amber)' }}>• {p}</div>)}
            <div style={{ fontSize: '.75em', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{result.outPath}</div>
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

export default memo(RepairPanel);
