import { describe, expect, it } from 'vitest';

import { editorReducer, emptyEditor, getExportRanges, parseProjectFile, toProjectFile } from './editor';
import type { EditorState } from './editor';

function withClips(...ranges: [number, number][]): EditorState {
  return editorReducer(emptyEditor, { type: 'reset', clips: ranges.map(([start, end]) => ({ start, end, name: '', selected: true })) });
}

describe('editor', () => {
  it('adds clips in time order and selects the new one', () => {
    let s = withClips([10, 20]);
    s = editorReducer(s, { type: 'add', start: 2, end: 5 });
    expect(s.clips.map((c) => c.start)).toEqual([2, 10]);
    expect(s.current).toBe(0);
  });

  it('splits a clip at a time inside it', () => {
    const s = editorReducer(withClips([0, 10]), { type: 'split', index: 0, at: 4 });
    expect(s.clips.map((c) => [c.start, c.end])).toEqual([[0, 4], [4, 10]]);
    expect(s.current).toBe(1);
  });

  it('ignores a split outside the clip', () => {
    const s0 = withClips([0, 10]);
    expect(editorReducer(s0, { type: 'split', index: 0, at: 12 })).toBe(s0);
  });

  it('rejects an update that makes the end come before the start', () => {
    const s0 = withClips([0, 10]);
    expect(editorReducer(s0, { type: 'update', index: 0, changes: { end: -1 } })).toBe(s0);
  });

  it('undoes and redoes', () => {
    let s = withClips([0, 10]);
    s = editorReducer(s, { type: 'remove', index: 0 });
    expect(s.clips).toHaveLength(0);
    s = editorReducer(s, { type: 'undo' });
    expect(s.clips).toHaveLength(1);
    s = editorReducer(s, { type: 'redo' });
    expect(s.clips).toHaveLength(0);
  });

  it('moves, duplicates and selects', () => {
    let s = withClips([0, 1], [2, 3], [4, 5]);
    s = editorReducer(s, { type: 'move', index: 2, to: 0 });
    expect(s.clips.map((c) => c.start)).toEqual([4, 0, 2]);
    s = editorReducer(s, { type: 'duplicate', index: 1 });
    expect(s.clips.map((c) => c.start)).toEqual([4, 0, 0, 2]);
    s = editorReducer(s, { type: 'update', index: 0, changes: { selected: false } });
    s = editorReducer(s, { type: 'invertSelection' });
    expect(s.clips.map((c) => c.selected)).toEqual([true, false, false, false]);
    s = editorReducer(s, { type: 'removeUnselected' });
    expect(s.clips).toHaveLength(1);
  });

  it('exports the ticked clips in keep mode, in list order', () => {
    let s = withClips([10, 20], [0, 5]);
    s = editorReducer(s, { type: 'update', index: 1, changes: { selected: false } });
    expect(getExportRanges(s, 100)).toEqual([{ start: 10, end: 20, name: '' }]);
  });

  it('exports what is between the clips in remove mode', () => {
    let s = withClips([10, 20], [0, 5], [15, 30]);
    s = editorReducer(s, { type: 'mode', mode: 'remove' });
    expect(getExportRanges(s, 60).map(({ start, end }) => [start, end])).toEqual([[5, 10], [30, 60]]);
  });

  it('round-trips a project file and rejects other JSON', () => {
    const s = withClips([1, 2], [3, 4.5]);
    const text = JSON.stringify(toProjectFile('a.mp4', s));
    expect(parseProjectFile(text)?.clips).toEqual([{ start: 1, end: 2, name: '', selected: true }, { start: 3, end: 4.5, name: '', selected: true }]);
    expect(parseProjectFile('{"version":2,"cutSegments":[]}')).toBeUndefined();
    expect(parseProjectFile('not json')).toBeUndefined();
  });
});
