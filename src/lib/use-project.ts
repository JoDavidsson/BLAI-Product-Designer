import { useCallback, useEffect, useRef, useState } from 'react';
import { reconcileReferences, type Project } from '../../shared/model';
import { api } from './api';
import { ProjectHistory } from './project-history';

export function useProject() {
  const [project, setProject] = useState<Project | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [saveError, setSaveError] = useState('');
  const current = useRef<Project | null>(null);
  const revision = useRef(0);
  const changes = useRef(0);
  const savedChanges = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef<Promise<Project | null> | null>(null);
  const flushRef = useRef<() => Promise<Project | null>>(async () => null);
  const history = useRef(new ProjectHistory());
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const updateHistoryState = () =>
    setHistoryState({ canUndo: history.current.canUndo, canRedo: history.current.canRedo });

  const replace = useCallback((value: Project, options?: { record?: boolean }) => {
    if (timer.current) clearTimeout(timer.current);
    if (options?.record && current.current?.id === value.id)
      history.current.record(current.current, value);
    else history.current.clear();
    updateHistoryState();
    current.current = value;
    revision.current = value.revision;
    changes.current = 0;
    savedChanges.current = 0;
    setProject(value);
    setSaveState('saved');
    setSaveError('');
  }, []);
  const flush = useCallback(async (): Promise<Project | null> => {
    if (timer.current) clearTimeout(timer.current);
    if (running.current) {
      await running.current;
      return flushRef.current();
    }
    if (!current.current || changes.current === savedChanges.current) return current.current;
    const snapshot = current.current;
    const version = changes.current;
    setSaveState('saving');
    setSaveError('');
    const operation = api
      .save(snapshot, revision.current)
      .then(({ project: saved }) => {
        if (current.current?.id !== saved.id) return current.current;
        revision.current = saved.revision;
        savedChanges.current = version;
        const next =
          changes.current === version
            ? saved
            : { ...current.current, revision: saved.revision, updatedAt: saved.updatedAt };
        current.current = next;
        setProject(next);
        setSaveState(changes.current === version ? 'saved' : 'pending');
        return next;
      })
      .catch((error: unknown) => {
        setSaveState('error');
        setSaveError(error instanceof Error ? error.message : 'Could not save the project.');
        throw error;
      });
    running.current = operation;
    try {
      await operation;
    } finally {
      running.current = null;
    }
    if (changes.current !== savedChanges.current) return flushRef.current();
    return current.current;
  }, []);
  flushRef.current = flush;
  const commitLocal = useCallback((value: Project) => {
    if (!current.current || current.current.id !== value.id) return;
    current.current = { ...value, revision: revision.current };
    changes.current += 1;
    setProject(current.current);
    setSaveState('pending');
    setSaveError('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flushRef.current().catch(() => undefined);
    }, 650);
  }, []);
  const change = useCallback(
    (value: Project) => {
      if (!current.current || current.current.id !== value.id) return;
      const next = reconcileReferences(value, current.current);
      const active = document.activeElement;
      const editing =
        active instanceof HTMLElement &&
        (active.matches('input, textarea') || active.isContentEditable);
      if (!history.current.record(current.current, next, editing ? active : undefined)) return;
      updateHistoryState();
      commitLocal(next);
    },
    [commitLocal],
  );
  const undo = useCallback(() => {
    if (!current.current) return;
    const next = history.current.undo(current.current);
    if (next) commitLocal(next);
    updateHistoryState();
  }, [commitLocal]);
  const redo = useCallback(() => {
    if (!current.current) return;
    const next = history.current.redo(current.current);
    if (next) commitLocal(next);
    updateHistoryState();
  }, [commitLocal]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (changes.current !== savedChanges.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => {
      window.removeEventListener('beforeunload', preventLoss);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return {
    project,
    change,
    replace,
    flush,
    saveState,
    saveError,
    current,
    undo,
    redo,
    ...historyState,
  };
}
