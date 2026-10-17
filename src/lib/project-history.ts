import type { Project } from '../../shared/model';

type Entry = { project: Project; size: number };

/** Session-local history. Server revisions belong to persistence, never to undo. */
export class ProjectHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private group: unknown;
  private lastEdit = 0;

  constructor(
    private limit = 50,
    private budget = 8_000_000,
  ) {}

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
    this.group = undefined;
    this.lastEdit = 0;
  }

  record(previous: Project, next: Project, group?: unknown, now = Date.now()) {
    if (previous.id !== next.id) {
      this.clear();
      return;
    }
    const content = (project: Project) =>
      JSON.stringify({ ...project, revision: 0, updatedAt: '' });
    if (content(previous) === content(next)) return false;
    if (!group || group !== this.group || now - this.lastEdit > 1000 || this.future.length) {
      this.past.push(this.entry(previous));
      this.trim(this.past);
    }
    this.future = [];
    this.group = group;
    this.lastEdit = now;
    return true;
  }

  undo(current: Project) {
    return this.move(current, this.past, this.future);
  }
  redo(current: Project) {
    return this.move(current, this.future, this.past);
  }

  private entry(project: Project): Entry {
    return { project: structuredClone(project), size: JSON.stringify(project).length * 2 };
  }

  private trim(entries: Entry[]) {
    let size = entries.reduce((total, entry) => total + entry.size, 0);
    while (entries.length > this.limit || (size > this.budget && entries.length > 1)) {
      size -= entries.shift()!.size;
    }
  }

  private move(current: Project, from: Entry[], to: Entry[]): Project | null {
    if (!from.length) return null;
    if (from.at(-1)!.project.id !== current.id) {
      this.clear();
      return null;
    }
    to.push(this.entry(current));
    this.trim(to);
    const restored = structuredClone(from.pop()!.project);
    this.group = undefined;
    this.lastEdit = 0;
    return {
      ...restored,
      revision: current.revision,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
  }
}
