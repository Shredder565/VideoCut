import { FiCheckSquare, FiSquare, FiFolder, FiPlay, FiCheckCircle, FiAlertTriangle, FiX } from 'react-icons/fi';

import type { Settings } from '../../shared/api';
import type { MediaInfo, MediaStream } from '../media';
import { containers, formatTime } from '../media';
import { Dialog, Progress, basename } from './common';
import { vc } from '../bridge';

function describeStream(s: MediaStream) {
  const parts: string[] = [s.codec_name ?? 'unknown'];
  if (s.codec_type === 'video') {
    if (s.width != null) parts.push(`${s.width}×${s.height}`);
    const [n, d] = (s.avg_frame_rate ?? '').split('/').map(Number);
    if (n != null && d != null && d > 0 && n > 0) parts.push(`${(n / d).toFixed(3).replace(/\.?0+$/, '')} fps`);
    if (s.field_order != null && s.field_order !== 'progressive' && s.field_order !== 'unknown') parts.push('interlaced');
  }
  if (s.codec_type === 'audio') {
    if (s.channel_layout != null) parts.push(s.channel_layout);
    else if (s.channels != null) parts.push(`${s.channels} ch`);
    if (s.sample_rate != null) parts.push(`${Number(s.sample_rate) / 1000} kHz`);
  }
  if (s.bit_rate != null) parts.push(`${Math.round(Number(s.bit_rate) / 1000)} kb/s`);
  return parts.join(' · ');
}

const typeLabels: Record<string, string> = { video: 'Video', audio: 'Audio', subtitle: 'Subtitles', data: 'Data', attachment: 'Attachment' };

export function TracksDialog({ info, keep, onChange, onClose }: { info: MediaInfo, keep: Set<number>, onChange: (keep: Set<number>) => void, onClose: () => void }) {
  return (
    <Dialog title="Tracks" onClose={onClose} width={620}>
      <div className="small muted">Ticked tracks are kept when you export.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.45em' }}>
        {info.streams.map((s) => {
          const on = keep.has(s.index);
          return (
            <button
              key={s.index}
              type="button"
              className="item"
              onClick={() => {
                const next = new Set(keep);
                if (on) next.delete(s.index); else next.add(s.index);
                onChange(next);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'var(--text)', opacity: on ? 1 : 0.6 }}
            >
              <span style={{ fontSize: '1.2em', color: on ? 'var(--green)' : 'var(--text-muted)', display: 'flex' }}>{on ? <FiCheckSquare /> : <FiSquare />}</span>
              <span className="grow">
                <span style={{ fontWeight: 600 }}>{typeLabels[s.codec_type] ?? s.codec_type} {s.index}</span>
                {s.tags?.language != null && <span className="chip" style={{ marginLeft: '.5em' }}>{s.tags.language}</span>}
                {s.tags?.title != null && <span className="muted"> · {s.tags.title}</span>}
                <div className="small muted">{describeStream(s)}</div>
              </span>
            </button>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

export interface ExportState {
  phase: 'options' | 'running' | 'done' | 'failed',
  progress: number,
  stage: string | undefined,
  outputs: string[],
  warnings: string[],
  error: string | undefined,
}

export function ExportDialog({ info, settings, numRanges, totalLength, numTracks, state, onSettings, onChooseFolder, onStart, onCancel, onClose, onOpenOutput }: {
  info: MediaInfo,
  settings: Settings,
  numRanges: number,
  totalLength: number,
  numTracks: number,
  state: ExportState,
  onSettings: (changes: Partial<Settings>) => void,
  onChooseFolder: () => void,
  onStart: () => void,
  onCancel: () => void,
  onClose: () => void,
  onOpenOutput: (path: string) => void,
}) {
  const running = state.phase === 'running';
  const hasVideo = info.video != null;
  return (
    <Dialog title={running ? 'Exporting…' : 'Export'} onClose={running ? () => undefined : onClose} width={600}>
      {state.phase === 'options' && (
        <>
          <div className="item" style={{ flexDirection: 'row', gap: '1.2em' }}>
            <div><div className="label">Parts</div><div style={{ fontWeight: 700, fontSize: '1.2em' }}>{numRanges}</div></div>
            <div><div className="label">Length</div><div className="mono" style={{ fontWeight: 700, fontSize: '1.2em' }}>{formatTime(totalLength, { short: true })}</div></div>
            <div><div className="label">Tracks</div><div style={{ fontWeight: 700, fontSize: '1.2em' }}>{numTracks}/{info.streams.length}</div></div>
          </div>

          {numRanges > 1 && (
            <div>
              <div className="label" style={{ marginBottom: '.4em' }}>Output</div>
              <div className="segmented" role="radiogroup">
                <button type="button" role="radio" aria-checked={settings.exportMode === 'separate'} onClick={() => onSettings({ exportMode: 'separate' })}>One file per part</button>
                <button type="button" role="radio" aria-checked={settings.exportMode === 'merge'} onClick={() => onSettings({ exportMode: 'merge' })}>All parts in one file</button>
              </div>
            </div>
          )}

          {hasVideo && (
            <div>
              <div className="label" style={{ marginBottom: '.4em' }}>Cutting</div>
              <div className="segmented" role="radiogroup">
                <button type="button" role="radio" aria-checked={settings.smartCut} onClick={() => onSettings({ smartCut: true })}>Exact frames</button>
                <button type="button" role="radio" aria-checked={!settings.smartCut} onClick={() => onSettings({ smartCut: false })}>Fast (keyframes)</button>
              </div>
              <div className="small muted" style={{ marginTop: '.4em', lineHeight: 1.4 }}>
                {settings.smartCut
                  ? 'Cuts exactly where you marked. Only the few frames next to each cut are re-encoded; everything else is copied as it is.'
                  : 'Nothing is re-encoded, but each part starts at the keyframe at or before your mark, so it can start a little early.'}
              </div>
            </div>
          )}

          <div className="row wrap">
            <div className="grow">
              <div className="label" style={{ marginBottom: '.4em' }}>Save to</div>
              <button type="button" className="btn" onClick={onChooseFolder} title={settings.outputDir ?? 'Next to the input file'}><FiFolder /> {settings.outputDir != null ? basename(settings.outputDir) : 'Next to the input file'}</button>
              {settings.outputDir != null && <button type="button" className="btn btn-ghost" onClick={() => onSettings({ outputDir: undefined })}>Use the input's folder</button>}
            </div>
            <div>
              <div className="label" style={{ marginBottom: '.4em' }}>File type</div>
              <select className="input" value={settings.container ?? ''} onChange={(e) => onSettings({ container: e.target.value === '' ? undefined : e.target.value })}>
                <option value="">Same as the input</option>
                {containers.filter((c) => hasVideo || c.id === 'm4a' || c.id === 'mka' || c.id === 'mkv').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={onStart} disabled={numRanges === 0 || numTracks === 0}>Export</button>
          </div>
        </>
      )}

      {running && (
        <>
          <Progress value={state.progress} label={state.stage ?? 'Working…'} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onCancel}><FiX /> Cancel</button>
          </div>
        </>
      )}

      {(state.phase === 'done' || state.phase === 'failed') && (
        <>
          <div className="row" style={{ fontWeight: 700 }}>
            {state.phase === 'done'
              ? (state.warnings.length === 0 ? <FiCheckCircle style={{ color: 'var(--green)' }} /> : <FiAlertTriangle style={{ color: 'var(--amber)' }} />)
              : <FiAlertTriangle style={{ color: 'var(--red)' }} />}
            {state.phase === 'done' ? (state.warnings.length === 0 ? 'Export finished' : 'Export finished, with warnings') : 'Export failed'}
          </div>
          {state.error != null && <div className="small" style={{ color: 'var(--red)', whiteSpace: 'pre-wrap' }}>{state.error}</div>}
          {state.warnings.map((w) => <div key={w} className="small" style={{ color: 'var(--amber)' }}>• {w}</div>)}
          {state.outputs.map((p) => (
            <div key={p} className="item" style={{ flexDirection: 'row', alignItems: 'center' }}>
              <span className="grow ellipsis" title={p}>{basename(p)}</span>
              <button type="button" className="icon-btn" title="Open it here" onClick={() => onOpenOutput(p)}><FiPlay /></button>
              <button type="button" className="icon-btn" title="Show in folder" onClick={() => vc.showInFolder(p)}><FiFolder /></button>
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function SettingsDialog({ settings, version, onSettings, onClose }: { settings: Settings, version: string, onSettings: (c: Partial<Settings>) => void, onClose: () => void }) {
  return (
    <Dialog title="Settings" onClose={onClose} width={520}>
      <div>
        <div className="label" style={{ marginBottom: '.4em' }}>Look</div>
        <div className="segmented" role="radiogroup">
          <button type="button" role="radio" aria-checked={settings.theme === 'light'} onClick={() => onSettings({ theme: 'light' })}>Light</button>
          <button type="button" role="radio" aria-checked={settings.theme === 'dark'} onClick={() => onSettings({ theme: 'dark' })}>Dark</button>
        </div>
      </div>
      <div>
        <div className="label" style={{ marginBottom: '.4em' }}>Cutting</div>
        <div className="segmented" role="radiogroup">
          <button type="button" role="radio" aria-checked={settings.smartCut} onClick={() => onSettings({ smartCut: true })}>Exact frames</button>
          <button type="button" role="radio" aria-checked={!settings.smartCut} onClick={() => onSettings({ smartCut: false })}>Fast (keyframes)</button>
        </div>
      </div>
      <div>
        <div className="label" style={{ marginBottom: '.4em' }}>Keyboard</div>
        <div className="small muted" style={{ lineHeight: 1.8 }}>
          <kbd>Space</kbd> play/pause · <kbd>←</kbd> <kbd>→</kbd> one frame · <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> keyframe · <kbd>Ctrl</kbd>+<kbd>←</kbd> <kbd>→</kbd> 5 seconds ·
          {' '}<kbd>I</kbd> mark in · <kbd>O</kbd> mark out · <kbd>N</kbd> new clip · <kbd>S</kbd> split · <kbd>Del</kbd> delete clip ·
          {' '}<kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Y</kbd> redo · <kbd>Ctrl</kbd>+<kbd>O</kbd> open · <kbd>Ctrl</kbd>+<kbd>E</kbd> export
        </div>
      </div>
      <div className="small muted">VideoCut {version}. Uses FFmpeg (ffmpeg.org), included under its own licence.</div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
