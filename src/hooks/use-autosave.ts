'use client';

import { useEffect } from 'react';
import { debounce } from '@/lib/utils';
import { renderThumbnail } from '@/lib/minimap-draw';
import { generateWorld } from '@/lib/worldgen';
import { saveProjectSnapshot } from '@/services/project-save';
import { useProjectStore } from '@/stores/project-store';

/**
 * Debounced autosave to IndexedDB. Every world/name/map change persists ~1.2s
 * after the user stops editing; `atlas:save-now` (Ctrl+S) flushes immediately.
 */
export function useAutosave() {
  useEffect(() => {
    let disposed = false;

    const save = async (manual = false, st = useProjectStore.getState()) => {
      if (!st.projectId || disposed) return;
      if (!st.dirty) {
        if (manual) st.log('info', 'Project is already saved');
        return;
      }
      let thumbnail: string | null = null;
      try {
        thumbnail = renderThumbnail(generateWorld(st.world), st.world);
      } catch {
        // Thumbnail is decorative — never block a save on it.
      }
      const record = {
        id: st.projectId,
        name: st.name,
        createdAt: st.createdAt,
        updatedAt: Date.now(),
        world: st.world,
        mapImage: st.mapImage,
        thumbnail,
      };
      try {
        await saveProjectSnapshot(record);
        useProjectStore.getState().markSaved(record);
        const current = useProjectStore.getState();
        if (manual && current.projectId === record.id && !current.dirty)
          current.log('success', 'Project saved');
      } catch (err) {
        const current = useProjectStore.getState();
        if (current.projectId === record.id)
          current.log('error', `Autosave failed: ${String(err)}`);
      }
    };

    const debounced = debounce(() => void save(), 1200);
    const unsub = useProjectStore.subscribe((state, prev) => {
      // Keep the outgoing project's edits when a new project replaces the store.
      if (state.projectId !== prev.projectId && prev.projectId && prev.dirty)
        void save(false, prev);
      if (
        state.projectId !== prev.projectId ||
        state.world !== prev.world ||
        state.name !== prev.name ||
        state.mapImage !== prev.mapImage
      ) {
        debounced();
      }
    });

    const flush = () => {
      debounced.cancel();
      void save();
    };
    const saveNow = () => {
      debounced.cancel();
      void save(true);
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    if (useProjectStore.getState().dirty) debounced();
    window.addEventListener('atlas:save-now', saveNow);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      flush();
      disposed = true;
      unsub();
      window.removeEventListener('atlas:save-now', saveNow);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);
}
