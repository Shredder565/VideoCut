import { useEffect, useRef, useState } from 'react';
import { FiPlus, FiScissors, FiCopy, FiTrash2, FiEdit3, FiArrowUp, FiArrowDown, FiCheckSquare, FiSquare, FiMoreHorizontal, FiCornerUpLeft, FiCornerUpRight, FiPlay } from 'react-icons/fi';

import type { Clip, CutMode, EditorAction } from '../editor';
import { clipColors } from '../editor';
import { formatTime } from '../media';
import { PanelHeader } from './common';

export default function ClipList({ clips, current, mode, fps, time, totalKept, dispatch, onSeek, onPlayClip, onClose }: {
  clips: Clip[],
  current: number,
  mode: CutMode,
  fps: number | undefined,
  time: number,
  totalKept: number,
  dispatch: (action: EditorAction) => void,
  onSeek: (t: number) => void,
  onPlayClip: (index: number) => void,
  onClose: () => void,
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<number>();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const numSelected = clips.filter((c) => c.selected).length;
  const currentClip = clips[current];

  return (
    <>
      <PanelHeader title="Clips" subtitle={mode === 'remove' ? 'These parts are cut out. Everything else is kept.' : 'Ticked clips are kept when you export.'} onClose={onClose}>
        <div style={{ position: 'relative' }}>
          <button type="button" className="icon-btn" title="More" onClick={() => setMenuOpen((v) => !v)}><FiMoreHorizontal /></button>
          {menuOpen && (
            <div className="card" role="menu" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, padding: 6, minWidth: 210, display: 'flex', flexDirection: 'column' }} onPointerLeave={() => setMenuOpen(false)}>
              {[
                ['Tick all clips', () => dispatch({ type: 'setAllSelected', selected: true })],
                ['Untick all clips', () => dispatch({ type: 'setAllSelected', selected: false })],
                ['Swap ticked and unticked', () => dispatch({ type: 'invertSelection' })],
                ['Delete unticked clips', () => dispatch({ type: 'removeUnselected' })],
                ['Delete all clips', () => dispatch({ type: 'reset', clips: [], mode })],
              ].map(([label, fn]) => (
                <button key={label as string} type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start', borderRadius: 8 }} onClick={() => { (fn as () => void)(); setMenuOpen(false); }}>{label as string}</button>
              ))}
            </div>
          )}
        </div>
      </PanelHeader>

      <div className="row wrap" style={{ padding: '.6em 1em', gap: '.4em', borderBottom: '1px solid var(--border)' }}>
        <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: 'add', start: time, end: Math.max(time + 1, time) })} title="Add a clip at the cursor (N)"><FiPlus /> New clip</button>
        <button type="button" className="btn" disabled={currentClip == null || time <= currentClip.start || time >= currentClip.end} onClick={() => dispatch({ type: 'split', index: current, at: time })} title="Split the current clip at the cursor (S)"><FiScissors /> Split</button>
      </div>

      <div style={{ flexGrow: 1, overflowY: 'auto', padding: '.7em', display: 'flex', flexDirection: 'column', gap: '.5em' }}>
        {clips.length === 0 && (
          <div className="small muted" style={{ padding: '.4em', lineHeight: 1.5 }}>
            No clips yet. Go to where a part starts and press <b>Mark in</b> (<kbd>I</kbd>), then go to its end and press <b>Mark out</b> (<kbd>O</kbd>).
          </div>
        )}
        {clips.map((c, index) => {
          const isActive = index === current;
          const color = clipColors[c.colorIndex % clipColors.length];
          const duration = c.end - c.start;
          const frames = fps != null ? Math.round(duration * fps) : undefined;
          return (
            <div
              key={c.id}
              ref={isActive ? activeRef : undefined}
              role="button"
              tabIndex={-1}
              onClick={() => { dispatch({ type: 'select', index }); onSeek(c.start); }}
              onDoubleClick={() => setRenaming(index)}
              style={{ display: 'flex', gap: '.6em', padding: '.6em .7em .6em .6em', borderRadius: 12, cursor: 'pointer', background: isActive ? 'var(--select-soft)' : 'var(--surface-2)', border: `1px solid ${isActive ? 'var(--select)' : 'var(--border)'}`, opacity: mode === 'keep' && !c.selected ? 0.55 : 1 }}
            >
              <div style={{ width: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
              <div className="grow">
                <div className="row" style={{ gap: '.4em' }}>
                  <span className="small muted" style={{ fontWeight: 700 }}>{index + 1}</span>
                  {renaming === index ? (
                    <input
                      className="input"
                      autoFocus
                      defaultValue={c.name}
                      placeholder="Clip name"
                      style={{ flexGrow: 1, padding: '.15em .4em' }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setRenaming(undefined);
                      }}
                      onBlur={(e) => { dispatch({ type: 'update', index, changes: { name: e.currentTarget.value.trim() } }); setRenaming(undefined); }}
                    />
                  ) : (
                    <span className="ellipsis grow" style={{ fontWeight: 600 }}>{c.name || 'Untitled clip'}</span>
                  )}
                </div>
                <div className="mono muted" style={{ fontSize: '.78em', marginTop: '.2em' }}>{formatTime(c.start)} → {formatTime(c.end)}</div>
                <div className="muted" style={{ fontSize: '.75em', marginTop: '.15em' }}>{formatTime(duration, { short: true })}{frames != null && ` · ${frames} frames`}</div>
                {isActive && (
                  <div className="row" style={{ gap: 2, marginTop: '.4em', marginLeft: -6 }} onClick={(e) => e.stopPropagation()} role="presentation">
                    <button type="button" className="icon-btn" title="Play this clip" onClick={() => onPlayClip(index)}><FiPlay /></button>
                    <button type="button" className="icon-btn" title="Go to the clip's start" onClick={() => onSeek(c.start)}><FiCornerUpLeft /></button>
                    <button type="button" className="icon-btn" title="Go to the clip's end" onClick={() => onSeek(c.end)}><FiCornerUpRight /></button>
                    <button type="button" className="icon-btn" title="Rename" onClick={() => setRenaming(index)}><FiEdit3 /></button>
                    <button type="button" className="icon-btn" title="Duplicate" onClick={() => dispatch({ type: 'duplicate', index })}><FiCopy /></button>
                    <button type="button" className="icon-btn" title="Move up" disabled={index === 0} onClick={() => dispatch({ type: 'move', index, to: index - 1 })}><FiArrowUp /></button>
                    <button type="button" className="icon-btn" title="Move down" disabled={index === clips.length - 1} onClick={() => dispatch({ type: 'move', index, to: index + 1 })}><FiArrowDown /></button>
                    <button type="button" className="icon-btn" title="Delete (Del)" style={{ color: 'var(--red)' }} onClick={() => dispatch({ type: 'remove', index })}><FiTrash2 /></button>
                  </div>
                )}
              </div>
              {mode === 'keep' && (
                <button type="button" className="icon-btn" title={c.selected ? 'Kept when exporting. Click to leave it out' : 'Left out when exporting. Click to keep it'} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'update', index, changes: { selected: !c.selected } }); }} style={{ alignSelf: 'flex-start', color: c.selected ? 'var(--green)' : 'var(--text-muted)', fontSize: '1.15em' }}>
                  {c.selected ? <FiCheckSquare /> : <FiSquare />}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="row small muted" style={{ padding: '.7em 1em', borderTop: '1px solid var(--border)', justifyContent: 'space-between' }}>
        <span>{mode === 'remove' ? `${clips.length} parts cut out` : `${numSelected} of ${clips.length} clips kept`}</span>
        <span className="mono" title="Length of the export">{formatTime(totalKept, { short: true })}</span>
      </div>
    </>
  );
}
