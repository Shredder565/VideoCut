import { FiPause, FiPlay, FiChevronLeft, FiChevronRight, FiSkipBack, FiSkipForward, FiZoomIn, FiZoomOut, FiCornerDownRight, FiCornerUpLeft, FiKey, FiRepeat, FiRotateCcw, FiRotateCw } from 'react-icons/fi';

import type { Clip, CutMode } from '../editor';
import { formatTime } from '../media';
import TimeInput from './TimeInput';

function Divider() {
  return <div style={{ width: 1, alignSelf: 'stretch', margin: '.3em .2em', background: 'var(--border)' }} />;
}

export default function TransportBar({ enabled, playing, time, fps, hasVideo, clip, mode, zoom, canUndo, canRedo, onTogglePlay, onStep, onKeyframe, onSeek, onMarkIn, onMarkOut, onSetClipTime, onGoClipStart, onGoClipEnd, onPlayClip, onMode, onZoom, onUndo, onRedo }: {
  enabled: boolean,
  playing: boolean,
  time: number,
  fps: number | undefined,
  hasVideo: boolean,
  clip: Clip | undefined,
  mode: CutMode,
  zoom: number,
  canUndo: boolean,
  canRedo: boolean,
  onTogglePlay: () => void,
  onStep: (frames: number) => void,
  onKeyframe: (direction: -1 | 1) => void,
  onSeek: (t: number) => void,
  onMarkIn: () => void,
  onMarkOut: () => void,
  onSetClipTime: (which: 'start' | 'end', t: number) => boolean,
  onGoClipStart: () => void,
  onGoClipEnd: () => void,
  onPlayClip: () => void,
  onMode: (mode: CutMode) => void,
  onZoom: (zoom: number) => void,
  onUndo: () => void,
  onRedo: () => void,
}) {
  const frame = fps != null ? Math.round(time * fps) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.35em', padding: '.55em .9em .65em', opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? undefined : 'none' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) auto minmax(0, 1fr)', alignItems: 'center', gap: '.5em' }}>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
          <TimeInput value={time} onChange={(t) => { onSeek(t); }} title="Current position. Type a time to go there" width={140} />
          <span className="small muted" style={{ marginTop: 3, paddingLeft: 4 }}>
            {frame != null ? <>Frame <span className="mono">{frame}</span></> : 'Audio'}
          </span>
        </div>

        <div className="row" style={{ gap: '.35em' }}>
          <button type="button" className="btn" onClick={onMarkIn} title="Start the current clip here (I)" style={{ borderColor: 'var(--green)' }}>
            <FiCornerDownRight style={{ color: 'var(--green)' }} /> Mark in
          </button>
          <TimeInput value={clip?.start} onChange={(t) => onSetClipTime('start', t)} disabled={clip == null} title="Start of the current clip" />
          <button type="button" className="icon-btn" onClick={onGoClipStart} disabled={clip == null} title="Go to the clip's start"><FiCornerUpLeft /></button>

          <Divider />
          <button type="button" className="icon-btn" onClick={() => onSeek(0)} title="Go to the start (Home)"><FiSkipBack /></button>
          {hasVideo && <button type="button" className="icon-btn" onClick={() => onKeyframe(-1)} title="Previous keyframe (Shift+←)"><FiKey style={{ transform: 'scaleX(-1)' }} /></button>}
          <button type="button" className="icon-btn" onClick={() => onStep(-1)} title="One frame back (←)"><FiChevronLeft size={20} /></button>
          <button
            type="button"
            onClick={onTogglePlay}
            title="Play/pause (Space)"
            style={{ width: 48, height: 48, borderRadius: 15, border: 'none', cursor: 'pointer', background: 'var(--text)', color: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3em', boxShadow: 'var(--shadow)' }}
          >
            {playing ? <FiPause /> : <FiPlay style={{ marginLeft: 3 }} />}
          </button>
          <button type="button" className="icon-btn" onClick={() => onStep(1)} title="One frame forward (→)"><FiChevronRight size={20} /></button>
          {hasVideo && <button type="button" className="icon-btn" onClick={() => onKeyframe(1)} title="Next keyframe (Shift+→)"><FiKey /></button>}
          <button type="button" className="icon-btn" onClick={() => onSeek(Number.MAX_SAFE_INTEGER)} title="Go to the end (End)"><FiSkipForward /></button>
          <Divider />

          <button type="button" className="icon-btn" onClick={onGoClipEnd} disabled={clip == null} title="Go to the clip's end"><FiCornerUpLeft style={{ transform: 'scaleX(-1)' }} /></button>
          <TimeInput value={clip?.end} onChange={(t) => onSetClipTime('end', t)} disabled={clip == null} title="End of the current clip" />
          <button type="button" className="btn" onClick={onMarkOut} title="End the current clip here (O)" style={{ borderColor: 'var(--red)' }}>
            Mark out <FiCornerDownRight style={{ color: 'var(--red)', transform: 'scaleX(-1)' }} />
          </button>
        </div>

        <div />
      </div>

      <div className="row" style={{ gap: '.4em' }}>
        <div className="segmented" role="radiogroup" title="What happens to the clips when you export">
          <button type="button" role="radio" aria-checked={mode === 'keep'} onClick={() => onMode('keep')} style={mode === 'keep' ? { background: 'var(--green)', color: 'white' } : undefined}>Keep clips</button>
          <button type="button" role="radio" aria-checked={mode === 'remove'} onClick={() => onMode('remove')} style={mode === 'remove' ? { background: 'var(--red)', color: 'white' } : undefined}>Remove clips</button>
        </div>
        <button type="button" className="icon-btn" onClick={onPlayClip} disabled={clip == null} title="Play the current clip"><FiRepeat /></button>
        <button type="button" className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)"><FiRotateCcw /></button>
        <button type="button" className="icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)"><FiRotateCw /></button>
        <div className="grow" />
        <span className="small muted">{clip != null ? `Clip ${formatTime(clip.end - clip.start, { short: true })}` : ''}</span>
        <Divider />
        <button type="button" className="icon-btn" onClick={() => onZoom(Math.max(1, zoom / 2))} title="Zoom out (Ctrl+wheel)"><FiZoomOut /></button>
        <span className="chip mono" style={{ minWidth: 46, justifyContent: 'center' }}>{zoom < 10 ? zoom.toFixed(zoom % 1 === 0 ? 0 : 1) : Math.round(zoom)}×</span>
        <button type="button" className="icon-btn" onClick={() => onZoom(Math.min(4096, zoom * 2))} title="Zoom in (Ctrl+wheel)"><FiZoomIn /></button>
      </div>
    </div>
  );
}
