// The clips of the open file: what to keep (or remove), with undo.

export interface Clip {
  id: string,
  start: number,
  end: number,
  name: string,
  // ticked clips are exported (in "keep" mode)
  selected: boolean,
  colorIndex: number,
}

export type CutMode = 'keep' | 'remove';

export interface EditorState {
  clips: Clip[],
  current: number,
  mode: CutMode,
  past: Clip[][],
  future: Clip[][],
}

export const clipColors = ['#f0714f', '#7a85f0', '#3fb98a', '#e7a93b', '#4fa9e0', '#c46fd6', '#e4688f', '#8fbf45', '#36b5b0', '#b98a5e', '#9a7ef0', '#e28a4a'];

let idCounter = 0;
export function newClipId() {
  idCounter += 1;
  return `c${Date.now().toString(36)}${idCounter}`;
}

function nextColor(clips: Clip[]) {
  return clips.reduce((max, c) => Math.max(max, c.colorIndex), -1) + 1;
}

export const emptyEditor: EditorState = { clips: [], current: 0, mode: 'keep', past: [], future: [] };

export type EditorAction =
  | { type: 'reset', clips: Omit<Clip, 'id' | 'colorIndex'>[], mode?: CutMode | undefined }
  | { type: 'add', start: number, end: number, name?: string }
  | { type: 'update', index: number, changes: Partial<Pick<Clip, 'start' | 'end' | 'name' | 'selected'>> }
  | { type: 'remove', index: number }
  | { type: 'duplicate', index: number }
  | { type: 'split', index: number, at: number }
  | { type: 'move', index: number, to: number }
  | { type: 'select', index: number }
  | { type: 'setAllSelected', selected: boolean }
  | { type: 'invertSelection' }
  | { type: 'removeUnselected' }
  | { type: 'mode', mode: CutMode }
  | { type: 'undo' }
  | { type: 'redo' };

const minLength = 0.001;

function clamp(clips: Clip[], current: number) {
  return Math.max(0, Math.min(current, clips.length - 1));
}

// changes the clips, remembering the previous ones for undo
function edit(state: EditorState, clips: Clip[], current = state.current): EditorState {
  return { ...state, clips, current: clamp(clips, current), past: [...state.past.slice(-99), state.clips], future: [] };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'reset': {
      const clips = action.clips.map((c, i) => ({ ...c, id: newClipId(), colorIndex: i }));
      return { clips, current: 0, mode: action.mode ?? 'keep', past: [], future: [] };
    }
    case 'add': {
      const clip: Clip = { id: newClipId(), start: action.start, end: Math.max(action.end, action.start + minLength), name: action.name ?? '', selected: true, colorIndex: nextColor(state.clips) };
      // keep the list in time order when adding
      const clips = [...state.clips, clip].sort((a, b) => a.start - b.start);
      return edit(state, clips, clips.indexOf(clip));
    }
    case 'update': {
      const old = state.clips[action.index];
      if (old == null) return state;
      const updated = { ...old, ...action.changes };
      if (updated.end - updated.start < minLength) return state;
      return edit(state, state.clips.map((c, i) => (i === action.index ? updated : c)));
    }
    case 'remove': {
      if (state.clips[action.index] == null) return state;
      return edit(state, state.clips.filter((_c, i) => i !== action.index), action.index > 0 ? action.index - 1 : 0);
    }
    case 'duplicate': {
      const old = state.clips[action.index];
      if (old == null) return state;
      const copy = { ...old, id: newClipId(), colorIndex: nextColor(state.clips) };
      const clips = [...state.clips];
      clips.splice(action.index + 1, 0, copy);
      return edit(state, clips, action.index + 1);
    }
    case 'split': {
      const old = state.clips[action.index];
      if (old == null || action.at <= old.start + minLength || action.at >= old.end - minLength) return state;
      const first = { ...old, end: action.at };
      const second = { ...old, id: newClipId(), start: action.at, colorIndex: nextColor(state.clips) };
      const clips = [...state.clips];
      clips.splice(action.index, 1, first, second);
      return edit(state, clips, action.index + 1);
    }
    case 'move': {
      if (state.clips[action.index] == null || action.to < 0 || action.to >= state.clips.length) return state;
      const clips = [...state.clips];
      const [item] = clips.splice(action.index, 1);
      clips.splice(action.to, 0, item!);
      return edit(state, clips, action.to);
    }
    case 'select':
      return { ...state, current: clamp(state.clips, action.index) };
    case 'setAllSelected':
      return edit(state, state.clips.map((c) => ({ ...c, selected: action.selected })));
    case 'invertSelection':
      return edit(state, state.clips.map((c) => ({ ...c, selected: !c.selected })));
    case 'removeUnselected':
      return edit(state, state.clips.filter((c) => c.selected), 0);
    case 'mode':
      return { ...state, mode: action.mode };
    case 'undo': {
      const prev = state.past.at(-1);
      if (prev == null) return state;
      return { ...state, clips: prev, current: clamp(prev, state.current), past: state.past.slice(0, -1), future: [state.clips, ...state.future] };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (next == null) return state;
      return { ...state, clips: next, current: clamp(next, state.current), past: [...state.past, state.clips], future: rest };
    }
    default:
      return state;
  }
}

// The parts of the file that get exported: the ticked clips in "keep" mode, or everything between the clips in "remove" mode
export function getExportRanges(state: Pick<EditorState, 'clips' | 'mode'>, duration: number) {
  if (state.mode === 'keep') {
    return state.clips.filter((c) => c.selected && c.end > c.start).map((c) => ({ start: c.start, end: Math.min(c.end, duration), name: c.name }));
  }
  const removed = [...state.clips].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const ranges: { start: number, end: number, name: string }[] = [];
  let pos = 0;
  for (const c of removed) {
    if (c.start - pos > minLength) ranges.push({ start: pos, end: c.start, name: '' });
    pos = Math.max(pos, c.end);
  }
  if (duration - pos > minLength) ranges.push({ start: pos, end: duration, name: '' });
  return ranges;
}

// Project file next to the video: <name>.videocut.json
export interface ProjectFile {
  app: 'VideoCut',
  version: 1,
  media: string,
  mode: CutMode,
  clips: { start: number, end: number, name: string, selected: boolean }[],
}

export function toProjectFile(mediaName: string, state: EditorState): ProjectFile {
  return { app: 'VideoCut', version: 1, media: mediaName, mode: state.mode, clips: state.clips.map(({ start, end, name, selected }) => ({ start, end, name, selected })) };
}

export function parseProjectFile(text: string): { mode: CutMode, clips: { start: number, end: number, name: string, selected: boolean }[] } | undefined {
  try {
    const json = JSON.parse(text) as Partial<ProjectFile>;
    if (json.app !== 'VideoCut' || !Array.isArray(json.clips)) return undefined;
    const clips = json.clips.filter((c) => typeof c?.start === 'number' && typeof c.end === 'number' && c.end > c.start)
      .map((c) => ({ start: c.start, end: c.end, name: typeof c.name === 'string' ? c.name : '', selected: c.selected !== false }));
    return { mode: json.mode === 'remove' ? 'remove' : 'keep', clips };
  } catch {
    return undefined;
  }
}
