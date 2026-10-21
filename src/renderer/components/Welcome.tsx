import type { IconType } from 'react-icons';
import { FiFilm, FiLink, FiList, FiTool, FiTv } from 'react-icons/fi';

import { Logo } from './common';
import type { PanelId } from './Rail';

export default function Welcome({ onOpen, onPanel }: { onOpen: () => void, onPanel: (p: PanelId) => void }) {
  const cards: { Icon: IconType, title: string, text: string, onClick: () => void }[] = [
    { Icon: FiFilm, title: 'Cut a video', text: 'Mark the parts to keep and export them. Only the frames next to each cut are re-encoded.', onClick: onOpen },
    { Icon: FiTool, title: 'Repair a recording', text: 'Fix broken timestamps, glitches and out of sync sound in TV recordings, without re-encoding.', onClick: () => onPanel('repair') },
    { Icon: FiTv, title: 'Find the ads', text: 'Find commercial breaks automatically, check them, and cut them out.', onClick: () => onPanel('ads') },
    { Icon: FiLink, title: 'Join videos', text: 'Join several videos into one, even when they were recorded differently.', onClick: () => onPanel('join') },
    { Icon: FiList, title: 'Run a batch', text: 'Queue up repairs, ad scans, joins and exports and let them run.', onClick: () => onPanel('queue') },
  ];

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.6em', padding: '2em', overflowY: 'auto' }}>
      <div style={{ textAlign: 'center' }}>
        <Logo size={58} />
        <h1 style={{ margin: '.3em 0 .15em', fontSize: '1.95em', letterSpacing: '-.02em' }}>What would you like to do?</h1>
        <p className="muted" style={{ margin: 0 }}>Drop a video anywhere in this window, or pick a task.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 230px))', gap: '1em', justifyContent: 'center', width: '100%', maxWidth: 1250 }}>
        {cards.map(({ Icon, title, text, onClick }, i) => (
          <button key={title} type="button" className="card" onClick={onClick} style={{ textAlign: 'left', padding: '1.2em', cursor: 'pointer', font: 'inherit', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: '.5em', border: i === 0 ? '2px solid var(--accent)' : undefined }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: i === 0 ? 'var(--accent)' : 'var(--accent-soft)', color: i === 0 ? 'white' : 'var(--accent-text)', fontSize: '1.3em' }}>
              <Icon />
            </span>
            <span style={{ fontWeight: 700, fontSize: '1.05em' }}>{title}</span>
            <span className="small muted" style={{ lineHeight: 1.4 }}>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
