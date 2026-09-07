'use client';

import { useEffect } from 'react';
import { emit } from '@/lib/bus';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export function useShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ui = useUIStore.getState();
      const project = useProjectStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'k':
            e.preventDefault();
            ui.set({ paletteOpen: !ui.paletteOpen });
            return;
          case 's':
            e.preventDefault();
            window.dispatchEvent(new Event('atlas:save-now'));
            return;
          case 'z':
            if (isTyping(e)) return;
            e.preventDefault();
            if (e.shiftKey) project.redo();
            else project.undo();
            return;
          case 'y':
            if (isTyping(e)) return;
            e.preventDefault();
            project.redo();
            return;
          case 'b':
            e.preventDefault();
            ui.togglePanel('left');
            return;
          case 'i':
            if (isTyping(e)) return;
            e.preventDefault();
            ui.togglePanel('right');
            return;
          case 'j':
            e.preventDefault();
            ui.togglePanel('bottom');
            return;
        }
        return;
      }

      if (e.key === 'Escape') {
        if (ui.paletteOpen || ui.shortcutsOpen || ui.settingsOpen) {
          ui.set({ paletteOpen: false, shortcutsOpen: false, settingsOpen: false });
        }
        return;
      }

      if (isTyping(e)) return;

      switch (e.key) {
        case '1':
          ui.set({ cameraMode: 'orbit' });
          break;
        case '2':
          ui.set({ cameraMode: 'walk' });
          break;
        case '3':
          ui.set({ cameraMode: 'fly' });
          break;
        case 'g':
        case 'G':
          ui.set({ showGrid: !ui.showGrid });
          break;
        case 'm':
          ui.set({ showMinimap: !ui.showMinimap });
          break;
        case 'p':
          ui.set({ showPerf: !ui.showPerf });
          break;
        case 'f':
          emit('camera:frame');
          break;
        case 'F':
          if (e.shiftKey) emit('viewport:fullscreen');
          break;
        case 'B':
          // Delegated to the actions registry (workspace listens for this event).
          if (e.shiftKey) window.dispatchEvent(new Event('atlas:bookmark-camera'));
          break;
        case '?':
          ui.set({ shortcutsOpen: !ui.shortcutsOpen });
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
