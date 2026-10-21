import type { IconType } from 'react-icons';
import { FiFilm, FiFolderPlus, FiLink, FiList, FiTool, FiTv } from 'react-icons/fi';

export type PanelId = 'clips' | 'repair' | 'ads' | 'join' | 'queue';

const items: { id: PanelId, Icon: IconType, label: string, hint: string }[] = [
  { id: 'clips', Icon: FiFilm, label: 'Clips', hint: 'The parts of the video you keep or remove' },
  { id: 'repair', Icon: FiTool, label: 'Repair', hint: 'Check and repair TV recordings' },
  { id: 'ads', Icon: FiTv, label: 'Ads', hint: 'Find commercial breaks' },
  { id: 'join', Icon: FiLink, label: 'Join', hint: 'Join several videos into one' },
  { id: 'queue', Icon: FiList, label: 'Queue', hint: 'Jobs that run one after another' },
];

export default function Rail({ active, onSelect, onOpen, badges }: {
  active: PanelId | undefined,
  onSelect: (panel: PanelId) => void,
  onOpen: () => void,
  badges: Partial<Record<PanelId, number>>,
}) {
  return (
    <nav style={{ width: 78, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.35em', padding: '.8em 0', background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
      <button type="button" title="Open a video (Ctrl+O)" onClick={onOpen} style={{ width: 46, height: 46, borderRadius: 13, border: 'none', cursor: 'pointer', background: 'var(--accent)', color: 'white', fontSize: '1.25em', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '.6em' }}>
        <FiFolderPlus />
      </button>
      {items.map(({ id, Icon, label, hint }) => {
        const isActive = active === id;
        const badge = badges[id];
        return (
          <button
            key={id}
            type="button"
            title={hint}
            onClick={() => onSelect(id)}
            style={{ position: 'relative', width: 64, padding: '.5em 0 .42em', border: 'none', borderRadius: 12, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.25em', font: 'inherit', fontSize: '.74em', fontWeight: 600, background: isActive ? 'var(--accent-soft)' : 'transparent', color: isActive ? 'var(--accent-text)' : 'var(--text-muted)' }}
          >
            <Icon style={{ fontSize: '1.7em' }} />
            {label}
            {badge != null && badge > 0 && (
              <span style={{ position: 'absolute', top: 2, right: 8, minWidth: 16, height: 16, borderRadius: 8, background: 'var(--select)', color: 'white', fontSize: 10, lineHeight: '16px', textAlign: 'center', padding: '0 3px' }}>{badge}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
