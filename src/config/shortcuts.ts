import { modKey } from '@/lib/utils';

export interface ShortcutDef {
  keys: string;
  label: string;
}

export const SHORTCUT_GROUPS: { title: string; items: ShortcutDef[] }[] = [
  {
    title: 'General',
    items: [
      { keys: `${modKey} K`, label: 'Command palette' },
      { keys: `${modKey} S`, label: 'Save project' },
      { keys: `${modKey} Z`, label: 'Undo' },
      { keys: `${modKey} ⇧ Z`, label: 'Redo' },
      { keys: '?', label: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { keys: `${modKey} B`, label: 'Toggle left panel' },
      { keys: `${modKey} I`, label: 'Toggle right panel' },
      { keys: `${modKey} J`, label: 'Toggle bottom panel' },
    ],
  },
  {
    title: 'Camera',
    items: [
      { keys: '1', label: 'Orbit mode  ·  WASD pan' },
      { keys: '2', label: 'Walk mode  ·  WASD + Space' },
      { keys: '3', label: 'Fly mode  ·  WASD + E/Q' },
      { keys: 'F', label: 'Frame world' },
      { keys: '⇧ B', label: 'Bookmark camera' },
      { keys: '⇧ F', label: 'Fullscreen viewport' },
    ],
  },
  {
    title: 'Viewport',
    items: [
      { keys: 'G', label: 'Toggle grid' },
      { keys: 'M', label: 'Toggle minimap' },
      { keys: 'P', label: 'Performance overlay' },
    ],
  },
];
