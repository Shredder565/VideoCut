import { FiFolder, FiLayers, FiMoon, FiScissors, FiSettings, FiSun } from 'react-icons/fi';

import { Logo, basename } from './common';
import { formatTime } from '../media';

export default function HeaderBar({ filePath, duration, theme, outputDir, numTracks, numTracksTotal, numRanges, canExport, onTracks, onChooseOutput, onToggleTheme, onSettings, onExport }: {
  filePath: string | undefined,
  duration: number | undefined,
  theme: 'light' | 'dark',
  outputDir: string | undefined,
  numTracks: number,
  numTracksTotal: number,
  numRanges: number,
  canExport: boolean,
  onTracks: () => void,
  onChooseOutput: () => void,
  onToggleTheme: () => void,
  onSettings: () => void,
  onExport: () => void,
}) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: '.8em', padding: '.55em 1em', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      <div className="row" style={{ gap: '.5em', flexShrink: 0 }}>
        <Logo size={26} />
        <span style={{ fontWeight: 700, fontSize: '1.08em', letterSpacing: '-.01em' }}>VideoCut</span>
      </div>

      <div className="grow row" style={{ justifyContent: 'center' }}>
        {filePath != null && (
          <>
            <span className="ellipsis" style={{ fontWeight: 600, maxWidth: '45%' }} title={filePath}>{basename(filePath)}</span>
            {duration != null && <span className="chip mono">{formatTime(duration, { short: true })}</span>}
            <button type="button" className="btn" onClick={onTracks} title="Choose which tracks to keep">
              <FiLayers /> Tracks {numTracks}/{numTracksTotal}
            </button>
          </>
        )}
      </div>

      <div className="row" style={{ flexShrink: 0, gap: '.4em' }}>
        <button type="button" className="btn btn-ghost" onClick={onChooseOutput} title={outputDir ?? 'Exports are saved next to the input file. Click to choose a folder'}>
          <FiFolder /> {outputDir != null ? basename(outputDir) : 'Save next to input'}
        </button>
        <button type="button" className="icon-btn" onClick={onToggleTheme} title="Light or dark">{theme === 'dark' ? <FiSun /> : <FiMoon />}</button>
        <button type="button" className="icon-btn" onClick={onSettings} title="Settings"><FiSettings /></button>
        <button type="button" className="btn btn-primary" style={{ fontSize: '.98em', padding: '.52em 1.25em' }} disabled={!canExport} onClick={onExport} title="Export (Ctrl+E)">
          <FiScissors /> {numRanges > 1 ? `Export ${numRanges} parts` : 'Export'}
        </button>
      </div>
    </header>
  );
}
