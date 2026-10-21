import { memo, useCallback, useMemo, useState } from 'react';
import { FiCheckSquare, FiSquare, FiTv, FiX } from 'react-icons/fi';

import { detectAdBreaks, findAdBreaks } from '../../engine/adDetect';
import type { AdBreak, AdDetectSignals } from '../../engine/adDetect';
import { PanelHeader, t } from './common';
import { createTaskRunner, cancelTasks } from '../bridge';
import { formatTime } from '../media';

type Sensitivity = 'strict' | 'normal' | 'loose';
const minConfidenceBySensitivity: Record<Sensitivity, number> = { strict: 0.6, normal: 0.45, loose: 0.3 };

function confidenceLabel(c: number) {
  if (c >= 0.75) return { text: 'Very likely', color: 'var(--green)' };
  if (c >= 0.55) return { text: 'Likely', color: 'var(--amber)' };
  return { text: 'Possible', color: 'var(--text-muted)' };
}

// Finds commercial breaks in the open file, lets the user review them, and turns the result into clips
function AdsPanel({ filePath, fileDuration, videoStreamIndex, audioStreamIndex, seekAbs, loadCutSegments, setKeepClips, onClose, onDone }: {
  filePath: string | undefined,
  fileDuration: number | undefined,
  videoStreamIndex: number | undefined,
  audioStreamIndex: number | undefined,
  seekAbs: (t: number) => void,
  loadCutSegments: (a: { segments: { start: number, end: number, name?: string }[], append: boolean }) => void,
  setKeepClips: () => void,
  onClose: () => void,
  onDone: () => void,
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ path: string, signals: AdDetectSignals, secondsPerMinute: number }>();
  const [sensitivity, setSensitivity] = useState<Sensitivity>('normal');
  const [rejected, setRejected] = useState<Set<number>>(new Set());

  const resultForFile = result != null && result.path === filePath ? result : undefined;

  const breaks = useMemo<AdBreak[]>(() => {
    if (resultForFile == null) return [];
    return findAdBreaks(resultForFile.signals, { minConfidence: minConfidenceBySensitivity[sensitivity] }).breaks;
  }, [resultForFile, sensitivity]);

  const scan = useCallback(async () => {
    if (filePath == null) return;
    setRunning(true);
    setError(undefined);
    setProgress(0);
    setRejected(new Set());
    try {
      const runner = createTaskRunner({ duration: fileDuration, onProgress: setProgress });
      const res = await detectAdBreaks({
        runner,
        path: filePath,
        ...(videoStreamIndex != null && { videoStreamIndex }),
        ...(audioStreamIndex != null && { audioStreamIndex }),
      });
      setResult({ path: filePath, signals: res.signals, secondsPerMinute: res.stats.secondsPerMinute });
    } catch (err) {
      console.error('Ad detection failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [audioStreamIndex, fileDuration, filePath, videoStreamIndex]);

  const accepted = breaks.filter((_b, i) => !rejected.has(i));

  const toggle = useCallback((i: number) => setRejected((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  }), []);

  // keep everything except the accepted breaks
  const keepProgramme = useCallback(() => {
    if (fileDuration == null) return;
    const parts: { start: number, end: number, name?: string }[] = [];
    let pos = 0;
    accepted.forEach((b) => {
      if (b.start - pos > 0.5) parts.push({ start: pos, end: b.start, name: t('Part {{n}}', { n: parts.length + 1 }) });
      pos = Math.max(pos, b.end);
    });
    if (fileDuration - pos > 0.5) parts.push({ start: pos, end: fileDuration, name: t('Part {{n}}', { n: parts.length + 1 }) });
    if (parts.length === 0) return;
    setKeepClips();
    loadCutSegments({ segments: parts, append: false });
    onDone();
  }, [accepted, fileDuration, loadCutSegments, onDone, setKeepClips]);

  const markBreaks = useCallback(() => {
    if (accepted.length === 0) return;
    setKeepClips();
    loadCutSegments({ segments: accepted.map((b, i) => ({ start: b.start, end: b.end, name: t('Ad break {{n}}', { n: i + 1 }) })), append: false });
    onDone();
  }, [accepted, loadCutSegments, onDone, setKeepClips]);

  const totalAds = accepted.reduce((acc, b) => acc + (b.end - b.start), 0);

  return (
    <>
      <PanelHeader title={t('Find the ads')} subtitle={t('Looks for the short black, silent gaps between commercials, and groups them into ad breaks.')} onClose={onClose} />

      <div className="panel-body" style={{ flexGrow: 1 }}>
        {filePath == null ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '.9em' }}>{t('Open a recording first.')}</div>
        ) : (
          <>
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={running} onClick={scan}><FiTv /> {resultForFile ? t('Scan again') : t('Scan for ads')}</button>
              {running && <button type="button" className="btn" onClick={cancelTasks}><FiX /> {t('Cancel')}</button>}
            </div>

            {running && (
              <div>
                <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                <div style={{ fontSize: '.75em', color: 'var(--text-muted)', marginTop: '.3em' }}>{t('Scanning… {{p}}%', { p: Math.round(progress * 100) })}</div>
              </div>
            )}

            {error != null && <div style={{ color: 'var(--red)', fontSize: '.85em' }}>{error}</div>}

            {resultForFile != null && !running && (
              <>
                <div>
                  <div className="label" style={{ marginBottom: '.35em' }}>{t('Sensitivity')}</div>
                  <div role="radiogroup" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 999, padding: 2, fontSize: '.8em', width: 'fit-content' }}>
                    {(['strict', 'normal', 'loose'] as const).map((s) => (
                      <button key={s} type="button" role="radio" aria-checked={sensitivity === s} onClick={() => { setSensitivity(s); setRejected(new Set()); }} style={{ border: 'none', borderRadius: 999, padding: '.3em .9em', cursor: 'pointer', font: 'inherit', fontWeight: 600, background: sensitivity === s ? 'var(--text)' : 'transparent', color: sensitivity === s ? 'var(--surface)' : 'var(--text-muted)' }}>
                        {{ strict: t('Fewer'), normal: t('Normal'), loose: t('More') }[s]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="label">{breaks.length === 0 ? t('No ad breaks found') : t('{{n}} ad breaks found', { n: breaks.length })}</div>

                {breaks.map((b, i) => {
                  const isAccepted = !rejected.has(i);
                  const conf = confidenceLabel(b.confidence);
                  return (
                    // eslint-disable-next-line react/no-array-index-key
                    <div key={i} className="item" style={{ flexDirection: 'row', alignItems: 'flex-start', opacity: isAccepted ? 1 : 0.55 }}>
                      <div role="button" tabIndex={-1} style={{ flexGrow: 1, cursor: 'pointer' }} onClick={() => seekAbs(b.start)} title={b.reasons.join('\n')}>
                        <div style={{ fontWeight: 600 }}>{t('Break {{n}}', { n: i + 1 })} <span style={{ fontSize: '.75em', fontWeight: 700, color: conf.color, marginLeft: '.3em' }}>{t(conf.text)}</span></div>
                        <div className="mono" style={{ fontSize: '.78em', color: 'var(--text-muted)' }}>{formatTime(b.start)} → {formatTime(b.end)}</div>
                        <div style={{ fontSize: '.75em', color: 'var(--text-muted)' }}>{formatTime(b.end - b.start, { short: true })} · {t('{{n}} spots', { n: b.spots })}</div>
                      </div>
                      <button type="button" className="icon-btn" onClick={() => toggle(i)} title={isAccepted ? t('This is an ad break. Click if it is not') : t('Not an ad break. Click if it is')} style={{ color: isAccepted ? 'var(--green)' : 'var(--text-muted)', fontSize: '1.15em' }}>
                        {isAccepted ? <FiCheckSquare /> : <FiSquare />}
                      </button>
                    </div>
                  );
                })}

                {accepted.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '.5em', marginTop: '.4em' }}>
                    <div style={{ fontSize: '.8em', color: 'var(--text-muted)' }}>{t('Ads to remove: {{n}} breaks, {{d}}', { n: accepted.length, d: formatTime(totalAds, { short: true }) })}</div>
                    <button type="button" className="btn btn-primary" onClick={keepProgramme} title={t('Replaces your clips with the parts between the ad breaks, ready to export')}>{t('Cut out the ads')}</button>
                    <button type="button" className="btn" onClick={markBreaks} title={t('Replaces your clips with the ad breaks, so you can adjust them')}>{t('Show the breaks as clips')}</button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export default memo(AdsPanel);
