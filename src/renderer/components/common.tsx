import type { ReactNode } from 'react';
import { FiX } from 'react-icons/fi';

// VideoCut mark: a rounded tile with a play triangle cut by a blade
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)" />
      <path d="M11 8.5 L24 16 L11 23.5 Z" fill="white" />
      <path d="M7 24 L25 7" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M7 24 L25 7" stroke="white" strokeWidth="1.2" strokeLinecap="round" opacity=".9" />
    </svg>
  );
}

export function PanelHeader({ title, subtitle, onClose, children }: { title: string, subtitle?: string | undefined, onClose: () => void, children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '.5em', padding: '1em 1em .65em', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      <div className="grow">
        <div style={{ fontWeight: 700, fontSize: '1.12em' }}>{title}</div>
        {subtitle != null && <div className="small muted" style={{ marginTop: '.25em', lineHeight: 1.35 }}>{subtitle}</div>}
      </div>
      {children}
      <button type="button" className="icon-btn" onClick={onClose} title="Close panel"><FiX /></button>
    </div>
  );
}

export function Progress({ value, label }: { value: number, label?: string | undefined }) {
  return (
    <div>
      <div className="progress"><div style={{ width: `${Math.round(value * 100)}%` }} /></div>
      {label != null && <div className="small muted" style={{ marginTop: '.3em' }}>{label} {Math.round(value * 100)}%</div>}
    </div>
  );
}

export function Dialog({ title, onClose, children, width }: { title: string, onClose: () => void, children: ReactNode, width?: number }) {
  return (
    <div className="overlay" role="presentation" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card dialog" role="dialog" aria-label={title} style={width != null ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <div className="row">
          <div className="grow" style={{ fontWeight: 700, fontSize: '1.2em' }}>{title}</div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close"><FiX /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirname(path: string) {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i > 0 ? path.slice(0, i) : path;
}

export function stripExt(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function joinPath(dir: string, name: string) {
  return `${dir.replace(/[\\/]+$/, '')}\\${name}`;
}

export function extname(path: string) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

// Fills in {{name}} placeholders (the app is English only; this keeps the texts in one readable form)
export function t(text: string, vars?: Record<string, string | number>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => String(vars?.[key] ?? ''));
}
