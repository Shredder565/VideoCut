import { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiChevronUp } from 'react-icons/fi';

import type { MediaInfo, StripFrame } from '../media';
import { formatTime, readStripFrames } from '../media';
import { errorText } from '../bridge';

const typeColors: Record<string, string> = { I: 'var(--green)', P: 'var(--select)', B: 'var(--text-muted)' };

// The exact frames around the cursor (decoded by ffmpeg, not the player), with their I/P/B type.
// Clicking a frame goes to it. Paused only: while playing it would always lag behind.
export default function FrameStrip({ info, time, playing, clipStart, clipEnd, onSeek }: {
  info: MediaInfo,
  time: number,
  playing: boolean,
  clipStart: number | undefined,
  clipEnd: number | undefined,
  onSeek: (time: number) => void,
}) {
  const [open, setOpen] = useState(true);
  const [frames, setFrames] = useState<StripFrame[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const fps = info.fps ?? 25;
  const frameDuration = 1 / fps;

  useEffect(() => {
    if (!open || playing || info.video == null) return undefined;
    requestRef.current += 1;
    const request = requestRef.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await readStripFrames({ info, time, before: 3, after: 4, height: 72 });
        if (request !== requestRef.current) {
          result.forEach((f) => URL.revokeObjectURL(f.url));
          return;
        }
        setFrames((old) => {
          old.forEach((f) => URL.revokeObjectURL(f.url));
          return result;
        });
        setError(undefined);
      } catch (err) {
        if (request === requestRef.current) setError(errorText(err));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [info, open, playing, time]);

  const isAt = (f: StripFrame, t: number | undefined) => t != null && Math.abs(f.time - t) < frameDuration / 2;

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button type="button" className="btn btn-ghost" style={{ fontSize: '.78em', padding: '.25em .7em', margin: '.2em .3em' }} onClick={() => setOpen((v) => !v)}>
        {open ? <FiChevronDown /> : <FiChevronUp />} Frames
        {open && playing && <span className="muted"> · pause to see the frames</span>}
        {open && loading && <span className="muted"> · reading…</span>}
      </button>
      {open && (
        <div style={{ display: 'flex', gap: 6, padding: '0 10px 8px', overflow: 'hidden', minHeight: 96, opacity: playing ? 0.4 : 1 }}>
          {error != null && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}
          {frames.map((f) => {
            const current = Math.abs(f.time - time) < frameDuration / 2;
            return (
              <button
                key={f.url}
                type="button"
                onClick={() => onSeek(f.time)}
                title={`${formatTime(f.time)} · ${f.type} frame`}
                style={{ position: 'relative', padding: 0, border: `2px solid ${current ? 'var(--accent)' : 'transparent'}`, borderRadius: 8, background: 'none', cursor: 'pointer', flexShrink: 0 }}
              >
                <img src={f.url} alt="" style={{ display: 'block', height: 72, borderRadius: 6 }} />
                <span style={{ position: 'absolute', top: 3, left: 3, fontSize: 10, fontWeight: 800, color: 'white', background: typeColors[f.type] ?? '#777', borderRadius: 4, padding: '0 4px' }}>{f.type}</span>
                {isAt(f, clipStart) && <span style={{ position: 'absolute', top: 3, right: 3, fontSize: 9.5, fontWeight: 800, color: 'white', background: 'var(--green)', borderRadius: 4, padding: '0 4px' }}>IN</span>}
                {isAt(f, clipEnd) && <span style={{ position: 'absolute', top: 3, right: 3, fontSize: 9.5, fontWeight: 800, color: 'white', background: 'var(--red)', borderRadius: 4, padding: '0 4px' }}>OUT</span>}
                <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>{formatTime(f.time).slice(3)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
