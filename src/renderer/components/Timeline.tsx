import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';

import type { Clip, CutMode } from '../editor';
import { clipColors } from '../editor';
import { formatTime } from '../media';

const rulerHeight = 20;
const waveHeight = 42;
const clipHeight = 34;

// nice ruler steps in seconds
const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export default function Timeline({ duration, time, playing, clips, current, mode, keyframes, waveform, zoom, onZoom, onSeek, onSelectClip, onUpdateClip, onScrub }: {
  duration: number,
  time: number,
  playing: boolean,
  clips: Clip[],
  current: number,
  mode: CutMode,
  keyframes: number[],
  waveform: { peaks: Float32Array, perSecond: number } | undefined,
  zoom: number,
  onZoom: (zoom: number) => void,
  onSeek: (time: number) => void,
  onSelectClip: (index: number) => void,
  onUpdateClip: (index: number, changes: { start?: number, end?: number }) => void,
  onScrub?: (scrubbing: boolean) => void,
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewWidth, setViewWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const dragRef = useRef<{ kind: 'seek' } | { kind: 'start' | 'end', index: number } | undefined>(undefined);

  const contentWidth = Math.max(viewWidth, viewWidth * zoom);
  const pps = contentWidth / duration;
  const x = useCallback((t: number) => t * pps, [pps]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el == null) return undefined;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // keep the playhead in view
  useEffect(() => {
    const el = scrollRef.current;
    if (el == null || zoom <= 1) return;
    const px = time * pps;
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 20) {
      el.scrollLeft = playing ? px - 20 : px - el.clientWidth / 2;
    }
  }, [playing, pps, time, zoom]);

  // waveform and keyframe ticks for the visible part only (the content can be far wider than a canvas can be)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas == null) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewWidth * dpr);
    canvas.height = Math.round(waveHeight * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx == null) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewWidth, waveHeight);
    const style = getComputedStyle(canvas);
    if (waveform != null) {
      ctx.fillStyle = style.getPropertyValue('--wave') || '#999';
      const mid = waveHeight / 2;
      for (let px = 0; px < viewWidth; px += 1) {
        const t0 = (scrollLeft + px) / pps;
        const t1 = (scrollLeft + px + 1) / pps;
        const i0 = Math.floor(t0 * waveform.perSecond);
        const i1 = Math.max(i0 + 1, Math.floor(t1 * waveform.perSecond));
        let max = 0;
        for (let i = i0; i < i1 && i < waveform.peaks.length; i += 1) max = Math.max(max, waveform.peaks[i]!);
        const h = Math.max(0.5, max * (waveHeight / 2 - 2));
        ctx.fillRect(px, mid - h, 1, h * 2);
      }
    }
    // keyframes only when zoomed in far enough to tell them apart
    if (keyframes.length > 0 && keyframes.length * (viewWidth / contentWidth) < viewWidth / 4) {
      ctx.fillStyle = style.getPropertyValue('--key') || '#888';
      const from = scrollLeft / pps;
      const to = (scrollLeft + viewWidth) / pps;
      for (const k of keyframes) {
        if (k >= from && k <= to) ctx.fillRect(Math.round(k * pps - scrollLeft), waveHeight - 7, 1.5, 7);
      }
    }
  }, [contentWidth, keyframes, pps, scrollLeft, viewWidth, waveform]);

  const ticks = useMemo(() => {
    const minPx = 90;
    const step = steps.find((s) => s * pps >= minPx) ?? 3600;
    const from = Math.floor((scrollLeft / pps) / step) * step;
    const to = (scrollLeft + viewWidth) / pps;
    const out: number[] = [];
    for (let t = from; t <= to + step; t += step) out.push(t);
    return { out, step };
  }, [pps, scrollLeft, viewWidth]);

  const timeAt = useCallback((clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - rect.left + el.scrollLeft) / pps));
  }, [duration, pps]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const handle = target.dataset['handle'];
    const index = target.dataset['index'];
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if ((handle === 'start' || handle === 'end') && index != null) {
      dragRef.current = { kind: handle, index: Number(index) };
      onSelectClip(Number(index));
      return;
    }
    if (index != null) onSelectClip(Number(index));
    dragRef.current = { kind: 'seek' };
    onScrub?.(true);
    onSeek(timeAt(e.clientX));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null) return;
    const t = timeAt(e.clientX);
    if (drag.kind === 'seek') onSeek(t);
    else {
      onUpdateClip(drag.index, drag.kind === 'start' ? { start: t } : { end: t });
      onSeek(t);
    }
  };

  const onPointerUp = () => {
    if (dragRef.current?.kind === 'seek') onScrub?.(false);
    dragRef.current = undefined;
  };

  // Ctrl+wheel zooms around the mouse, plain wheel scrolls
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (el == null) return;
    if (e.ctrlKey) {
      const t = timeAt(e.clientX);
      const newZoom = Math.max(1, Math.min(4096, zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      onZoom(newZoom);
      requestAnimationFrame(() => {
        const newPps = Math.max(viewWidth, viewWidth * newZoom) / duration;
        el.scrollLeft = t * newPps - (e.clientX - el.getBoundingClientRect().left);
      });
    } else if (zoom > 1) {
      el.scrollLeft += e.deltaY + e.deltaX;
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      style={{ position: 'relative', overflowX: zoom > 1 ? 'auto' : 'hidden', overflowY: 'hidden', background: 'var(--timeline-bg)', cursor: 'text', userSelect: 'none', touchAction: 'none' }}
    >
      <div style={{ position: 'relative', width: contentWidth, height: rulerHeight + waveHeight + clipHeight + 12 }}>
        {/* ruler */}
        {ticks.out.map((t) => (
          <div key={t} style={{ position: 'absolute', left: x(t), top: 0, height: rulerHeight, borderLeft: '1px solid var(--border-strong)', paddingLeft: 4, fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            {ticks.step < 1 ? formatTime(t).slice(3) : formatTime(t, { short: true })}
          </div>
        ))}

        {/* waveform + keyframes (drawn for the visible part, follows the scroll) */}
        <canvas ref={canvasRef} style={{ position: 'absolute', left: scrollLeft, top: rulerHeight, width: viewWidth, height: waveHeight, pointerEvents: 'none', ['--wave' as string]: 'var(--border-strong)', ['--key' as string]: 'var(--accent)' }} />

        {/* clips */}
        {clips.map((c, i) => {
          const left = x(c.start);
          const width = Math.max(2, x(c.end) - left);
          const color = clipColors[c.colorIndex % clipColors.length]!;
          const isCurrent = i === current;
          const dim = mode === 'keep' && !c.selected;
          return (
            <div
              key={c.id}
              data-index={i}
              title={`${c.name || `Clip ${i + 1}`}: ${formatTime(c.start)} → ${formatTime(c.end)}`}
              style={{
                position: 'absolute',
                left,
                width,
                top: rulerHeight + waveHeight + 4,
                height: clipHeight,
                borderRadius: 9,
                background: mode === 'remove' ? `repeating-linear-gradient(135deg, ${color}66 0 6px, ${color}33 6px 12px)` : `${color}${dim ? '40' : 'cc'}`,
                border: `2px solid ${isCurrent ? 'var(--text)' : `${color}`}`,
                boxSizing: 'border-box',
                color: 'white',
                fontSize: 11.5,
                fontWeight: 600,
                padding: '0 10px',
                lineHeight: `${clipHeight - 4}px`,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textShadow: '0 1px 2px rgb(0 0 0 / 40%)',
                cursor: 'pointer',
              }}
            >
              {width > 40 ? (c.name || `${i + 1}`) : ''}
              <div data-handle="start" data-index={i} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize' }} />
              <div data-handle="end" data-index={i} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'ew-resize' }} />
            </div>
          );
        })}

        {/* playhead */}
        <div style={{ position: 'absolute', left: x(time) - 1, top: 0, bottom: 0, width: 2, background: 'var(--accent)', pointerEvents: 'none' }}>
          <div style={{ position: 'absolute', top: 0, left: -5, width: 12, height: 8, background: 'var(--accent)', borderRadius: '0 0 6px 6px' }} />
        </div>
      </div>
    </div>
  );
}
