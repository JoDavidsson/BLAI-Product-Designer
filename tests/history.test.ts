import { describe, expect, it } from 'vitest';
import { createNode, createProject } from '../shared/model';
import { ProjectHistory } from '../src/lib/project-history';

describe('project edit history', () => {
  it('groups typing in one field and preserves persisted revision metadata on undo and redo', () => {
    const history = new ProjectHistory();
    const original = createProject('Original');
    const first = { ...original, title: 'First' };
    const second = { ...first, title: 'Second' };
    const field = {};
    history.record(original, first, field, 100);
    history.record(first, second, field, 300);
    const saved = { ...second, revision: 9, updatedAt: '2026-10-17T12:00:00.000Z' };
    const undone = history.undo(saved)!;
    expect(undone.title).toBe('Original');
    expect(undone.revision).toBe(9);
    expect(undone.updatedAt).toBe(saved.updatedAt);
    expect(history.canUndo).toBe(false);
    expect(history.redo(undone)?.title).toBe('Second');
  });
  it('restores deleted components and their pinned annotations together', () => {
    const history = new ProjectHistory();
    const original = createProject();
    const node = createNode('button');
    original.screens = [
      {
        id: 'screen',
        name: 'Home',
        description: '',
        platform: 'mobile',
        state: 'default',
        nodes: [node],
      },
    ];
    original.comments = [
      {
        id: 'note',
        body: 'Open the trip',
        target: { kind: 'node', nodeId: node.id, screenId: 'screen', x: 0.2, y: 0.8 },
        status: 'open',
        replies: [],
        createdAt: original.createdAt,
      },
    ];
    const deleted = {
      ...original,
      screens: [],
      comments: original.comments.map((comment) => ({
        ...comment,
        target: { kind: 'project' as const, x: 0.2, y: 0.8 },
      })),
    };
    history.record(original, deleted);
    const restored = history.undo(deleted)!;
    expect(restored.screens[0].nodes[0].id).toBe(node.id);
    expect(restored.comments[0].target.nodeId).toBe(node.id);
    expect(history.redo(restored)?.screens).toEqual([]);
  });
  it('clears redo when a new direction is taken and never crosses projects', () => {
    const history = new ProjectHistory();
    const original = createProject('Original');
    const edited = { ...original, title: 'Edited' };
    history.record(original, edited);
    history.undo(edited);
    history.record(original, { ...original, title: 'New direction' });
    expect(history.canRedo).toBe(false);
    expect(history.undo(createProject('Another project'))).toBeNull();
    expect(history.canUndo).toBe(false);
  });
  it('bounds history and ignores autosave metadata-only changes', () => {
    const history = new ProjectHistory(2);
    let project = createProject('0');
    for (let i = 1; i <= 3; i++) {
      const next = { ...project, title: String(i) };
      history.record(project, next);
      project = next;
    }
    expect(history.record(project, { ...project, revision: 8 })).toBe(false);
    project = history.undo(project)!;
    expect(project.title).toBe('2');
    project = history.undo(project)!;
    expect(project.title).toBe('1');
    expect(history.undo(project)).toBeNull();
  });
});
