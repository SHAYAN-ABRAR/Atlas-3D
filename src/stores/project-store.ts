import { create } from 'zustand';
import { DEFAULT_WORLD } from '@/config/constants';
import { uid } from '@/lib/utils';
import type { ProjectRecord } from '@/types/project';
import type { WorldState } from '@/types/world';

export interface LogEntry {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  at: number;
}

export interface HistoryEntry {
  label: string;
  world: WorldState;
  at: number;
}

/** Deep-ish merge: each top-level section of WorldState merges shallowly. */
export type WorldPatch = {
  [K in keyof WorldState]?: WorldState[K] extends object ? Partial<WorldState[K]> : WorldState[K];
};

function mergeWorld(world: WorldState, patch: WorldPatch): WorldState {
  const next = { ...world };
  for (const key of Object.keys(patch) as (keyof WorldState)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      (next as Record<string, unknown>)[key] = {
        ...(world[key] as object),
        ...(value as object),
      };
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface ProjectStore {
  projectId: string | null;
  name: string;
  createdAt: number;
  mapImage: string | null;
  world: WorldState;
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
  lastSavedAt: number | null;
  logs: LogEntry[];

  newProject: (name?: string, world?: Partial<WorldState>, mapImage?: string | null) => string;
  loadProject: (record: ProjectRecord) => void;
  setName: (name: string) => void;
  setMapImage: (dataUrl: string | null) => void;
  updateWorld: (patch: WorldPatch, label: string, options?: { commit?: boolean }) => void;
  setWorld: (world: WorldState, label: string) => void;
  /** Drag-friendly editing: snapshot once at drag start, commit once at release. */
  beginTransient: () => void;
  endTransient: (label: string) => void;
  undo: () => void;
  redo: () => void;
  jumpTo: (index: number) => void;
  markSaved: (record: ProjectRecord) => void;
  log: (level: LogEntry['level'], message: string) => void;
  clearLogs: () => void;
  toRecord: (thumbnail: string | null) => ProjectRecord | null;
}

const MAX_HISTORY = 60;
const MAX_LOGS = 250;

let pendingSnapshot: WorldState | null = null;

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projectId: null,
  name: 'Untitled world',
  createdAt: Date.now(),
  mapImage: null,
  world: clone(DEFAULT_WORLD),
  past: [],
  future: [],
  dirty: false,
  lastSavedAt: null,
  logs: [],

  newProject: (name = 'Untitled world', worldPatch = {}, mapImage = null) => {
    pendingSnapshot = null;
    const id = uid('p_');
    const world = mergeWorld(clone(DEFAULT_WORLD), worldPatch as WorldPatch);
    if (worldPatch.seed === undefined) world.seed = Math.floor(Math.random() * 2 ** 31);
    set({
      projectId: id,
      name,
      createdAt: Date.now(),
      mapImage,
      world,
      past: [],
      future: [],
      dirty: true,
      lastSavedAt: null,
      logs: [{ id: uid(), level: 'success', message: `Project “${name}” created`, at: Date.now() }],
    });
    return id;
  },

  loadProject: (record) => {
    pendingSnapshot = null;
    set({
      projectId: record.id,
      name: record.name,
      createdAt: record.createdAt,
      mapImage: record.mapImage,
      world: mergeWorld(clone(DEFAULT_WORLD), clone(record.world)),
      past: [],
      future: [],
      dirty: false,
      lastSavedAt: record.updatedAt,
      logs: [{ id: uid(), level: 'info', message: `Opened “${record.name}”`, at: Date.now() }],
    });
  },

  setName: (name) => set({ name, dirty: true }),
  setMapImage: (mapImage) => set({ mapImage, dirty: true }),

  updateWorld: (patch, label, options) => {
    const { world, past } = get();
    const commit = options?.commit !== false;
    const next = mergeWorld(world, patch);
    set({
      world: next,
      dirty: true,
      past: commit
        ? [...past.slice(-MAX_HISTORY + 1), { label, world: clone(world), at: Date.now() }]
        : past,
      future: commit ? [] : get().future,
    });
  },

  setWorld: (world, label) => {
    const prev = get();
    set({
      world: clone(world),
      dirty: true,
      past: [
        ...prev.past.slice(-MAX_HISTORY + 1),
        { label, world: clone(prev.world), at: Date.now() },
      ],
      future: [],
    });
  },

  beginTransient: () => {
    pendingSnapshot = clone(get().world);
  },

  endTransient: (label) => {
    if (!pendingSnapshot) return;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    if (JSON.stringify(snapshot) === JSON.stringify(get().world)) return;
    set((s) => ({
      past: [...s.past.slice(-MAX_HISTORY + 1), { label, world: snapshot, at: Date.now() }],
      future: [],
    }));
  },

  undo: () => {
    const { past, future, world } = get();
    if (past.length === 0) return;
    const entry = past[past.length - 1];
    set({
      world: entry.world,
      past: past.slice(0, -1),
      future: [{ label: entry.label, world: clone(world), at: Date.now() }, ...future].slice(
        0,
        MAX_HISTORY,
      ),
      dirty: true,
    });
    get().log('info', `Undo — ${entry.label}`);
  },

  redo: () => {
    const { past, future, world } = get();
    if (future.length === 0) return;
    const entry = future[0];
    set({
      world: entry.world,
      future: future.slice(1),
      past: [...past, { label: entry.label, world: clone(world), at: Date.now() }].slice(
        -MAX_HISTORY,
      ),
      dirty: true,
    });
    get().log('info', `Redo — ${entry.label}`);
  },

  jumpTo: (index) => {
    const { past } = get();
    let steps = past.length - index;
    while (steps > 0) {
      get().undo();
      steps--;
    }
  },

  markSaved: (record) => {
    const state = get();
    if (state.projectId !== record.id) return;
    // A write acknowledges its own immutable snapshot, never edits made in flight.
    const current =
      state.world === record.world &&
      state.name === record.name &&
      state.mapImage === record.mapImage;
    set({ dirty: !current, lastSavedAt: record.updatedAt });
  },

  log: (level, message) =>
    set((s) => ({
      logs: [...s.logs.slice(-MAX_LOGS + 1), { id: uid(), level, message, at: Date.now() }],
    })),

  clearLogs: () => set({ logs: [] }),

  toRecord: (thumbnail) => {
    const s = get();
    if (!s.projectId) return null;
    return {
      id: s.projectId,
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: Date.now(),
      thumbnail,
      world: s.world,
      mapImage: s.mapImage,
    };
  },
}));
