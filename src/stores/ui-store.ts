import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL, type QualityLevel } from '@/config/constants';
import { STORAGE_PREFIX } from '@/config/constants';
import type { CameraBookmark } from '@/types/project';

export type Theme = 'dark' | 'light';
export type CameraMode = 'orbit' | 'walk' | 'fly';
export type LeftTab = 'scene' | 'assets' | 'history';
export type RightTab = 'design' | 'assistant';
export type BottomTab = 'console' | 'performance' | 'generation';

export interface LayerVisibility {
  terrain: boolean;
  water: boolean;
  roads: boolean;
  buildings: boolean;
  vegetation: boolean;
  effects: boolean;
}

interface UIStore {
  theme: Theme;
  // Layout
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  leftTab: LeftTab;
  rightTab: RightTab;
  bottomTab: BottomTab;
  // Viewport
  cameraMode: CameraMode;
  showGrid: boolean;
  showGizmo: boolean;
  showMinimap: boolean;
  showPerf: boolean;
  showTuning: boolean;
  quality: QualityLevel;
  autoQuality: boolean;
  bookmarks: CameraBookmark[];
  layers: LayerVisibility;
  // Overlays (transient — not persisted)
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  // AI settings
  ollamaUrl: string;
  ollamaModel: string;

  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  set: (partial: Partial<UIStore>) => void;
  togglePanel: (which: 'left' | 'right' | 'bottom') => void;
  toggleLayer: (layer: keyof LayerVisibility) => void;
  addBookmark: (b: CameraBookmark) => void;
  removeBookmark: (id: string) => void;
}

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      leftOpen: true,
      rightOpen: true,
      bottomOpen: true,
      leftWidth: 264,
      rightWidth: 320,
      bottomHeight: 176,
      leftTab: 'scene',
      rightTab: 'design',
      bottomTab: 'console',
      cameraMode: 'orbit',
      showGrid: true,
      showGizmo: true,
      showMinimap: true,
      showPerf: false,
      showTuning: false,
      quality: 'balanced',
      autoQuality: true,
      bookmarks: [],
      layers: {
        terrain: true,
        water: true,
        roads: true,
        buildings: true,
        vegetation: true,
        effects: true,
      },
      paletteOpen: false,
      shortcutsOpen: false,
      settingsOpen: false,
      ollamaUrl: OLLAMA_DEFAULT_URL,
      ollamaModel: OLLAMA_DEFAULT_MODEL,

      setTheme: (theme) => {
        set({ theme });
        if (typeof document !== 'undefined') {
          document.documentElement.classList.toggle('dark', theme === 'dark');
        }
      },
      toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
      set: (partial) => set(partial),
      togglePanel: (which) =>
        set((s) =>
          which === 'left'
            ? { leftOpen: !s.leftOpen }
            : which === 'right'
              ? { rightOpen: !s.rightOpen }
              : { bottomOpen: !s.bottomOpen },
        ),
      toggleLayer: (layer) =>
        set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),
      addBookmark: (b) => set((s) => ({ bookmarks: [...s.bookmarks, b].slice(-12) })),
      removeBookmark: (id) =>
        set((s) => ({ bookmarks: s.bookmarks.filter((x) => x.id !== id) })),
    }),
    {
      name: `${STORAGE_PREFIX}ui`,
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persisted) => {
        const s = persisted as Partial<UIStore>;
        // Retired default models: replace with the current default so a
        // shipped default change reaches existing browsers. A model the
        // user typed in Settings themselves is never one of these.
        const retired = ['kimi-k2.6:cloud', 'deepseek-v3.1:671b', 'qwen3.5:397b-cloud', 'glm-5.1:cloud'];
        if (s.ollamaModel && retired.includes(s.ollamaModel)) {
          s.ollamaModel = OLLAMA_DEFAULT_MODEL;
        }
        return s;
      },
      partialize: (s) => ({
        theme: s.theme,
        leftOpen: s.leftOpen,
        rightOpen: s.rightOpen,
        bottomOpen: s.bottomOpen,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        bottomHeight: s.bottomHeight,
        leftTab: s.leftTab,
        rightTab: s.rightTab,
        bottomTab: s.bottomTab,
        showGrid: s.showGrid,
        showGizmo: s.showGizmo,
        showMinimap: s.showMinimap,
        showPerf: s.showPerf,
        quality: s.quality,
        autoQuality: s.autoQuality,
        bookmarks: s.bookmarks,
        ollamaUrl: s.ollamaUrl,
        ollamaModel: s.ollamaModel,
      }),
    },
  ),
);
