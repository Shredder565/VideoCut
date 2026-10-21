import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { Settings, TestApiRequest } from '../shared/api';
import { defaultSettings } from '../shared/api';
import { vc, createRunner, errorText, isCancelled, createTaskRunner } from './bridge';
import { editorReducer, emptyEditor, getExportRanges, parseProjectFile, toProjectFile } from './editor';
import type { CutMode } from './editor';
import { containerForInput, containers, probeMedia, readKeyframes, readWaveform } from './media';
import type { MediaInfo } from './media';
import { exportClips } from '../engine/exporter';
import { analyzeStream, fixStream, getDefaultFormat } from '../engine/streamFix';
import type { StreamFixFormat } from '../engine/streamFix';
import { detectAdBreaks } from '../engine/adDetect';
import { planJoin, runJoin } from '../engine/smartJoin';
import type { NewBatchJob, RunJob } from '../engine/batchQueue';
import useQueue from './useQueue';

import HeaderBar from './components/HeaderBar';
import Rail from './components/Rail';
import type { PanelId } from './components/Rail';
import Welcome from './components/Welcome';
import Player from './components/Player';
import type { PlayerHandle } from './components/Player';
import FrameStrip from './components/FrameStrip';
import Timeline from './components/Timeline';
import TransportBar from './components/TransportBar';
import ClipList from './components/ClipList';
import RepairPanel, { getRepairedPath } from './components/RepairPanel';
import AdsPanel from './components/AdsPanel';
import JoinPanel from './components/JoinPanel';
import QueuePanel from './components/QueuePanel';
import { ExportDialog, SettingsDialog, TracksDialog } from './components/Dialogs';
import type { ExportState } from './components/Dialogs';
import { PanelHeader, basename, dirname, joinPath, stripExt } from './components/common';

const panelWidth = 350;

function projectPathFor(path: string) {
  return joinPath(dirname(path), `${stripExt(basename(path))}.videocut.json`);
}

// tracks kept by default: everything except data streams and cover pictures
function defaultTracks(info: MediaInfo) {
  return new Set(info.streams.filter((s) => (s.codec_type === 'video' && s.disposition?.attached_pic !== 1) || s.codec_type === 'audio' || s.codec_type === 'subtitle').map((s) => s.index));
}

export default function App() {
  const [settings, setSettingsState] = useState<Settings>(defaultSettings);
  const [version, setVersion] = useState('');
  const [info, setInfo] = useState<MediaInfo>();
  const [loading, setLoading] = useState<string>();
  const [editor, dispatch] = useReducer(editorReducer, emptyEditor);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panel, setPanel] = useState<PanelId | undefined>('clips');
  const [keyframes, setKeyframes] = useState<number[]>([]);
  const [waveform, setWaveform] = useState<{ peaks: Float32Array, perSecond: number }>();
  const [tracks, setTracks] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<'export' | 'tracks' | 'settings'>();
  const [exportState, setExportState] = useState<ExportState>({ phase: 'options', progress: 0, stage: undefined, outputs: [], warnings: [], error: undefined });
  const [toast, setToast] = useState<string>();
  const playerRef = useRef<PlayerHandle>(null);
  const exportCancelRef = useRef<(() => void) | undefined>(undefined);
  const loadedProjectRef = useRef<string | undefined>(undefined);

  const showToast = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? undefined : t)), 2600);
  }, []);

  useEffect(() => {
    vc.getSettings().then(setSettingsState).catch(() => undefined);
    vc.appVersion().then(setVersion).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset['theme'] = settings.theme;
  }, [settings.theme]);

  const changeSettings = useCallback(async (changes: Partial<Settings>) => {
    setSettingsState((s) => ({ ...s, ...changes }));
    setSettingsState(await vc.setSettings(changes));
  }, []);

  const duration = info?.duration ?? 0;
  const currentClip = editor.clips[editor.current];
  const ranges = useMemo(() => (info != null ? getExportRanges(editor, info.duration) : []), [editor, info]);
  const totalLength = ranges.reduce((acc, r) => acc + (r.end - r.start), 0);

  // ---- opening files ----

  const openFile = useCallback(async (path: string) => {
    setLoading('Opening…');
    try {
      const newInfo = await probeMedia(path);
      setPlaying(false);
      setTime(0);
      setZoom(1);
      setKeyframes([]);
      setWaveform(undefined);
      setInfo(newInfo);
      setTracks(defaultTracks(newInfo));
      // clips from the project file next to the video, if there is one
      const project = await vc.readText(projectPathFor(path));
      const parsed = project != null ? parseProjectFile(project) : undefined;
      dispatch({ type: 'reset', clips: parsed?.clips ?? [], mode: parsed?.mode });
      loadedProjectRef.current = path;
      if (parsed != null && parsed.clips.length > 0) showToast(`Loaded ${parsed.clips.length} clips from the project file`);
      readKeyframes(newInfo).then(setKeyframes).catch((err: unknown) => console.warn('keyframes', err));
      readWaveform(newInfo).then(setWaveform).catch((err: unknown) => console.warn('waveform', err));
      setPanel((p) => p ?? 'clips');
    } catch (err) {
      showToast(`Can't open ${basename(path)}: ${errorText(err)}`);
      throw err;
    } finally {
      setLoading(undefined);
    }
  }, [showToast]);

  const openDialog = useCallback(async () => {
    const [path] = await vc.openFiles({ title: 'Open a video', multiple: false });
    if (path != null) await openFile(path).catch(() => undefined);
  }, [openFile]);

  // save the clips next to the video whenever they change
  useEffect(() => {
    if (info == null || loadedProjectRef.current !== info.path) return undefined;
    const timer = setTimeout(() => {
      const projectPath = projectPathFor(info.path);
      if (editor.clips.length === 0) {
        vc.exists(projectPath).then((exists) => (exists ? vc.writeText(projectPath, JSON.stringify(toProjectFile(basename(info.path), editor), null, 2)) : undefined)).catch(() => undefined);
        return;
      }
      vc.writeText(projectPath, JSON.stringify(toProjectFile(basename(info.path), editor), null, 2)).catch((err: unknown) => console.warn('project save', err));
    }, 600);
    return () => clearTimeout(timer);
  }, [editor, info]);

  // ---- playback and navigation ----

  const seek = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(duration, t));
    setTime(clamped);
    playerRef.current?.seek(clamped);
  }, [duration]);

  const frameDuration = info?.fps != null ? 1 / info.fps : 0.04;
  const step = useCallback((frames: number) => {
    playerRef.current?.pause();
    // land on frame starts: round the current position to a frame first
    const frame = Math.round(time / frameDuration) + frames;
    seek(frame * frameDuration);
  }, [frameDuration, seek, time]);

  const goKeyframe = useCallback((dir: -1 | 1) => {
    const eps = frameDuration / 2;
    const k = dir > 0 ? keyframes.find((t) => t > time + eps) : [...keyframes].reverse().find((t) => t < time - eps);
    if (k != null) seek(k);
  }, [frameDuration, keyframes, seek, time]);

  // ---- editing ----

  const markIn = useCallback(() => {
    if (info == null) return;
    if (currentClip == null || time >= currentClip.end) {
      dispatch({ type: 'add', start: time, end: currentClip == null || time >= currentClip.end ? Math.min(duration, time + Math.min(10, duration - time) || duration) : currentClip.end });
    } else {
      dispatch({ type: 'update', index: editor.current, changes: { start: time } });
    }
  }, [currentClip, duration, editor.current, info, time]);

  const markOut = useCallback(() => {
    if (info == null) return;
    if (currentClip == null || time <= currentClip.start) {
      dispatch({ type: 'add', start: Math.max(0, time - Math.min(10, time)), end: time });
    } else {
      dispatch({ type: 'update', index: editor.current, changes: { end: time } });
    }
  }, [currentClip, editor.current, info, time]);

  const setClipTime = useCallback((which: 'start' | 'end', t: number) => {
    if (currentClip == null) return false;
    const changes = which === 'start' ? { start: t } : { end: t };
    const next = { ...currentClip, ...changes };
    if (next.end <= next.start || t < 0 || t > duration) return false;
    dispatch({ type: 'update', index: editor.current, changes });
    seek(t);
    return true;
  }, [currentClip, duration, editor.current, seek]);

  const addClipAtCursor = useCallback(() => {
    if (info == null) return;
    dispatch({ type: 'add', start: time, end: Math.min(duration, time + Math.max(1, Math.min(10, duration - time))) });
  }, [duration, info, time]);

  const playClip = useCallback((index: number) => {
    const c = editor.clips[index];
    if (c != null) playerRef.current?.playRange(c.start, c.end);
  }, [editor.clips]);

  // ---- export ----

  const getContainer = useCallback(() => {
    if (info == null) return undefined;
    const chosen = containers.find((c) => c.id === settings.container);
    return chosen != null ? { format: chosen.format, ext: chosen.ext } : containerForInput(info, info.path);
  }, [info, settings.container]);

  const runExport = useCallback(async (opts?: { ranges?: typeof ranges, path?: string, tracks?: number[] }) => {
    if (info == null) throw new Error('No file open');
    const container = getContainer()!;
    const theRanges = opts?.ranges ?? ranges;
    const { runner, exists, cancel, dispose } = createRunner({ jobId: `export-${Date.now()}` });
    const controller = new AbortController();
    exportCancelRef.current = () => {
      controller.abort();
      cancel();
    };
    setExportState({ phase: 'running', progress: 0, stage: 'Starting', outputs: [], warnings: [], error: undefined });
    try {
      const result = await exportClips({
        runner: { ...runner, exists },
        request: {
          input: { path: info.path, duration: info.duration },
          clips: theRanges.map((r) => ({ start: r.start, end: r.end, ...(r.name ? { name: r.name } : {}) })),
          streamIndexes: opts?.tracks ?? [...tracks].sort((a, b) => a - b),
          outDir: settings.outputDir ?? dirname(info.path),
          baseName: stripExt(basename(info.path)),
          container,
          mode: settings.smartCut && info.video != null ? 'smart' : 'keyframe',
          merge: settings.exportMode === 'merge' && theRanges.length > 1,
        },
        onProgress: (p, stage) => setExportState((s) => ({ ...s, progress: p, stage })),
        signal: controller.signal,
      });
      setExportState({ phase: 'done', progress: 1, stage: undefined, outputs: result.outputPaths, warnings: result.warnings, error: undefined });
      return result;
    } catch (err) {
      setExportState({ phase: 'failed', progress: 0, stage: undefined, outputs: [], warnings: [], error: isCancelled(err) || controller.signal.aborted ? 'Cancelled.' : errorText(err) });
      throw err;
    } finally {
      exportCancelRef.current = undefined;
      dispose();
    }
  }, [getContainer, info, ranges, settings.exportMode, settings.outputDir, settings.smartCut, tracks]);

  const openExport = useCallback(() => {
    if (info == null || ranges.length === 0) {
      showToast(info == null ? 'Open a video first' : 'Mark a clip to export first');
      return;
    }
    setExportState({ phase: 'options', progress: 0, stage: undefined, outputs: [], warnings: [], error: undefined });
    setDialog('export');
  }, [info, ranges.length, showToast]);

  const chooseOutputFolder = useCallback(async () => {
    const dir = await vc.chooseFolder('Where should exports be saved?');
    if (dir != null) await changeSettings({ outputDir: dir });
  }, [changeSettings]);

  // ---- queue ----

  const runJoinJob = useCallback(async (paths: string[], outPath: string, onProgress: (p: number) => void, signal: AbortSignal) => {
    const runner = createTaskRunner();
    const plan = await planJoin({ runner, inputs: paths.map((path) => ({ path })) });
    await runJoin({ runner, plan, outPath, tempDir: dirname(outPath), onProgress: (p) => onProgress(p), signal });
    return { outputPaths: [outPath] };
  }, []);

  const runJob = useCallback<RunJob>(async (job, { onProgress, signal }) => {
    const [path] = job.inputPaths;
    if (path == null) throw new Error('No input');
    const outDir = job.outputDir ?? settings.outputDir;
    if (job.kind === 'streamFix') {
      const { format, tracks: keepTracks, fixAvOffset } = job.options as { format?: StreamFixFormat, tracks?: 'all' | 'main', fixAvOffset?: boolean };
      const report = await analyzeStream({ runner: createTaskRunner(), path, onProgress: (_s, f) => onProgress(f * 0.2) });
      const fmt = format ?? getDefaultFormat(report.container);
      const outPath = getRepairedPath({ path, format: fmt, outDir });
      await fixStream({ runner: createTaskRunner({ duration: report.contentDuration ?? report.duration, onProgress: (p) => onProgress(0.2 + p * 0.75) }), path, outPath, report, options: { format: fmt, ...(keepTracks != null && { tracks: keepTracks }), ...(fixAvOffset != null && { fixAvOffset }) } });
      return { outputPaths: [outPath] };
    }
    if (job.kind === 'adDetect') {
      const result = await detectAdBreaks({ runner: createTaskRunner(), path, onProgress, signal });
      const parts: { start: number, end: number, name: string, selected: boolean }[] = [];
      let pos = 0;
      result.breaks.forEach((b) => {
        if (b.start - pos > 0.5) parts.push({ start: pos, end: b.start, name: `Part ${parts.length + 1}`, selected: true });
        pos = Math.max(pos, b.end);
      });
      if (result.stats.duration - pos > 0.5) parts.push({ start: pos, end: result.stats.duration, name: `Part ${parts.length + 1}`, selected: true });
      // the programme parts become the clips of the recording's project file (an existing one is kept)
      let projectPath = projectPathFor(path);
      if (await vc.exists(projectPath)) projectPath = joinPath(dirname(path), `${stripExt(basename(path))}.ads.videocut.json`);
      await vc.writeText(projectPath, JSON.stringify({ app: 'VideoCut', version: 1, media: basename(path), mode: 'keep', clips: parts }, null, 2));
      return { outputPaths: [projectPath] };
    }
    if (job.kind === 'join') {
      const { outPath } = job.options as { outPath: string };
      return runJoinJob(job.inputPaths, outPath, onProgress, signal);
    }
    if (job.kind === 'export') {
      const { ranges: jobRanges, tracks: jobTracks } = job.options as { ranges: typeof ranges, tracks: number[] };
      if (info?.path !== path) await openFile(path);
      const result = await runExport({ ranges: jobRanges, path, tracks: jobTracks });
      setDialog(undefined);
      return { outputPaths: result.outputPaths };
    }
    throw new Error(`Unknown job type ${job.kind}`);
  }, [info?.path, openFile, runExport, runJoinJob, settings.outputDir]);

  const queue = useQueue(runJob);
  const addJob = useCallback((job: NewBatchJob) => {
    queue.add(job);
    showToast('Added to the queue');
  }, [queue, showToast]);

  // ---- keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || dialog != null) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return; }
      if (info == null) return;
      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: 'undo' }); return; }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); dispatch({ type: 'redo' }); return; }
      if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
      switch (e.key) {
        case ' ': e.preventDefault(); playerRef.current?.toggle(); break;
        case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) goKeyframe(-1); else if (ctrl) seek(time - 5); else step(-1); break;
        case 'ArrowRight': e.preventDefault(); if (e.shiftKey) goKeyframe(1); else if (ctrl) seek(time + 5); else step(1); break;
        case 'Home': seek(0); break;
        case 'End': seek(duration); break;
        case 'i': case 'I': markIn(); break;
        case 'o': case 'O': markOut(); break;
        case 'n': case 'N': addClipAtCursor(); break;
        case 's': case 'S': if (currentClip != null) dispatch({ type: 'split', index: editor.current, at: time }); break;
        case 'Delete': if (currentClip != null) dispatch({ type: 'remove', index: editor.current }); break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addClipAtCursor, currentClip, dialog, duration, editor.current, goKeyframe, info, markIn, markOut, openDialog, openExport, seek, step, time]);

  // ---- drag and drop ----

  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file != null) openFile(vc.pathForFile(file)).catch(() => undefined);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFile]);

  // ---- test API (only active when started with --test-api) ----

  const testHandlersRef = useRef<(r: TestApiRequest) => Promise<unknown>>(async () => undefined);
  useEffect(() => {
    testHandlersRef.current = async ({ action, body }) => {
      if (action === 'open') {
        await openFile((body as { path: string }).path);
        return { duration: info?.duration };
      }
      if (action === 'clips') {
        const { clips, mode } = body as { clips: { start: number, end: number, name?: string }[], mode?: CutMode };
        dispatch({ type: 'reset', clips: clips.map((c) => ({ start: c.start, end: c.end, name: c.name ?? '', selected: true })), mode });
        return { count: clips.length };
      }
      if (action === 'settings') {
        await changeSettings(body as Partial<Settings>);
        return settings;
      }
      if (action === 'export') {
        const result = await runExport();
        return result;
      }
      return { file: info?.path, clips: editor.clips.length, ranges, time };
    };
  });
  useEffect(() => vc.onTestRequest((request) => {
    testHandlersRef.current(request)
      .then((value) => vc.sendTestResponse(request.id, { ok: true, value }))
      .catch((err: unknown) => vc.sendTestResponse(request.id, { ok: false, error: errorText(err) }));
  }), []);

  // ---- layout ----

  const togglePanel = (p: PanelId) => setPanel((cur) => (cur === p ? undefined : p));
  const closePanel = () => setPanel(undefined);

  const renderPanel = () => {
    switch (panel) {
      case 'clips':
        return info != null ? (
          <ClipList clips={editor.clips} current={editor.current} mode={editor.mode} fps={info.fps} time={time} totalKept={totalLength} dispatch={dispatch} onSeek={seek} onPlayClip={playClip} onClose={closePanel} />
        ) : (
          <>
            <PanelHeader title="Clips" onClose={closePanel} />
            <div className="panel-body small muted">Open a video to start marking the parts you want.</div>
          </>
        );
      case 'repair':
        return <RepairPanel filePath={info?.path} customOutDir={settings.outputDir} onOpenFile={(p) => { openFile(p).catch(() => undefined); }} onAddToQueue={(job) => addJob({ kind: 'streamFix', inputPaths: [job.path], options: { ...(job.format != null && { format: job.format }), tracks: job.tracks, fixAvOffset: job.fixAvOffset } })} onClose={closePanel} />;
      case 'ads':
        return (
          <AdsPanel
            filePath={info?.path}
            fileDuration={info?.duration}
            videoStreamIndex={info?.video?.index}
            audioStreamIndex={info?.audio?.index}
            seekAbs={seek}
            loadCutSegments={({ segments }) => dispatch({ type: 'reset', clips: segments.map((s) => ({ start: s.start, end: s.end, name: s.name ?? '', selected: true })), mode: 'keep' })}
            setKeepClips={() => dispatch({ type: 'mode', mode: 'keep' })}
            onClose={closePanel}
            onDone={() => setPanel('clips')}
          />
        );
      case 'join':
        return <JoinPanel customOutDir={settings.outputDir} batchFilePaths={[]} onOpenFile={(p) => { openFile(p).catch(() => undefined); }} onAddToQueue={(job) => addJob({ kind: 'join', inputPaths: job.paths, options: { outPath: job.outPath } })} onClose={closePanel} />;
      case 'queue':
        return (
          <QueuePanel
            queue={queue.queue}
            jobs={queue.jobs}
            paused={queue.paused}
            processing={queue.processing}
            onStart={queue.start}
            canAddCurrent={info != null && ranges.length > 0}
            onAddCurrent={() => info != null && addJob({ kind: 'export', inputPaths: [info.path], options: { ranges, tracks: [...tracks] } })}
            onClose={closePanel}
          />
        );
      default:
        return null;
    }
  };

  const queueCount = queue.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <HeaderBar
        filePath={info?.path}
        duration={info?.duration}
        theme={settings.theme}
        outputDir={settings.outputDir}
        numTracks={tracks.size}
        numTracksTotal={info?.streams.length ?? 0}
        numRanges={ranges.length}
        canExport={info != null && ranges.length > 0}
        onTracks={() => setDialog('tracks')}
        onChooseOutput={chooseOutputFolder}
        onToggleTheme={() => changeSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
        onSettings={() => setDialog('settings')}
        onExport={openExport}
      />

      <div style={{ flexGrow: 1, display: 'flex', minHeight: 0 }}>
        <Rail active={panel} onSelect={togglePanel} onOpen={openDialog} badges={{ clips: editor.clips.length > 1 ? editor.clips.length : 0, queue: queueCount }} />

        {panel != null && (
          <aside style={{ width: panelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
            {renderPanel()}
          </aside>
        )}

        <main style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
          <div style={{ position: 'relative', flexGrow: 1, minHeight: 120, overflow: 'hidden', borderRadius: 'var(--radius)', background: info != null ? 'var(--stage)' : 'transparent', boxShadow: info != null ? 'var(--shadow)' : undefined }}>
            {info == null && <Welcome onOpen={openDialog} onPanel={setPanel} />}
            {info != null && (
              <Player key={info.path} ref={playerRef} info={info} volume={settings.volume} onTime={setTime} onPlaying={setPlaying} />
            )}
            {loading != null && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgb(0 0 0 / 30%)', color: 'white', fontWeight: 600 }}>{loading}</div>
            )}
          </div>

          <div className="card" style={{ flexShrink: 0, overflow: 'hidden' }}>
            {info?.video != null && (
              <FrameStrip info={info} time={time} playing={playing} clipStart={currentClip?.start} clipEnd={currentClip?.end} onSeek={seek} />
            )}
            {info != null && (
              <Timeline
                duration={info.duration}
                time={time}
                playing={playing}
                clips={editor.clips}
                current={editor.current}
                mode={editor.mode}
                keyframes={keyframes}
                waveform={waveform}
                zoom={zoom}
                onZoom={setZoom}
                onSeek={seek}
                onSelectClip={(index) => dispatch({ type: 'select', index })}
                onUpdateClip={(index, changes) => dispatch({ type: 'update', index, changes })}
              />
            )}
            <TransportBar
              enabled={info != null}
              playing={playing}
              time={time}
              fps={info?.fps}
              hasVideo={info?.video != null}
              clip={currentClip}
              mode={editor.mode}
              zoom={zoom}
              canUndo={editor.past.length > 0}
              canRedo={editor.future.length > 0}
              onTogglePlay={() => playerRef.current?.toggle()}
              onStep={step}
              onKeyframe={goKeyframe}
              onSeek={seek}
              onMarkIn={markIn}
              onMarkOut={markOut}
              onSetClipTime={setClipTime}
              onGoClipStart={() => currentClip != null && seek(currentClip.start)}
              onGoClipEnd={() => currentClip != null && seek(currentClip.end)}
              onPlayClip={() => playClip(editor.current)}
              onMode={(mode) => dispatch({ type: 'mode', mode })}
              onZoom={setZoom}
              onUndo={() => dispatch({ type: 'undo' })}
              onRedo={() => dispatch({ type: 'redo' })}
            />
          </div>
        </main>
      </div>

      {dialog === 'tracks' && info != null && <TracksDialog info={info} keep={tracks} onChange={setTracks} onClose={() => setDialog(undefined)} />}
      {dialog === 'settings' && <SettingsDialog settings={settings} version={version} onSettings={changeSettings} onClose={() => setDialog(undefined)} />}
      {dialog === 'export' && info != null && (
        <ExportDialog
          info={info}
          settings={settings}
          numRanges={ranges.length}
          totalLength={totalLength}
          numTracks={tracks.size}
          state={exportState}
          onSettings={changeSettings}
          onChooseFolder={chooseOutputFolder}
          onStart={() => { runExport().catch(() => undefined); }}
          onCancel={() => exportCancelRef.current?.()}
          onClose={() => setDialog(undefined)}
          onOpenOutput={(p) => { setDialog(undefined); openFile(p).catch(() => undefined); }}
        />
      )}
      {toast != null && <div className="toast">{toast}</div>}
    </div>
  );
}
