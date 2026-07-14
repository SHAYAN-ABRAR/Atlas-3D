'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Leva } from 'leva';
import { PanelBottomClose, PanelLeftClose, PanelRightClose } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Logo } from '@/components/ui/logo';
import { buildActions } from '@/config/actions';
import { on, viewportRuntime } from '@/lib/bus';
import { clamp, cn } from '@/lib/utils';
import { useAutosave } from '@/hooks/use-autosave';
import { useShortcuts } from '@/hooks/use-shortcuts';
import { getProject, loadLocal, putProject, saveLocal } from '@/services/db';
import { analyzeMapImage, fileToDataUrl } from '@/services/map-analysis';
import { readShareFile } from '@/services/share';
import { useChatStore } from '@/stores/chat-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { BottomPanel } from './bottom-panel';
import { CommandPalette } from './command-palette';
import { LeftPanel } from './left-panel';
import { MiniMap } from './minimap';
import { SettingsDialog, ShortcutsOverlay } from './overlays';
import { RightPanel } from './right-panel';
import { StatusBar } from './status-bar';
import { TopBar } from './top-bar';

const Viewport = dynamic(() => import('@/three/viewport'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-ink-faint">
      Initializing renderer…
    </div>
  ),
});

/* ------------------------------------------------------------------ */

function Resizer({
  orientation,
  onDelta,
  onDoubleClick,
}: {
  orientation: 'vertical' | 'horizontal';
  onDelta: (d: number) => void;
  onDoubleClick?: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let last = orientation === 'vertical' ? e.clientX : e.clientY;
        const move = (ev: PointerEvent) => {
          const now = orientation === 'vertical' ? ev.clientX : ev.clientY;
          onDelta(now - last);
          last = now;
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      className={cn(
        'relative z-10 shrink-0 bg-line transition-colors hover:bg-accent/60 active:bg-accent',
        orientation === 'vertical' ? 'w-px cursor-col-resize px-0' : 'h-px cursor-row-resize',
      )}
      style={orientation === 'vertical' ? { paddingLeft: 3, marginLeft: -3, backgroundClip: 'content-box' } : { paddingTop: 3, marginTop: -3, backgroundClip: 'content-box' }}
    />
  );
}

/* ------------------------------------------------------------------ */

function ViewportOverlays() {
  const cameraMode = useUIStore((s) => s.cameraMode);
  const showPerf = useUIStore((s) => s.showPerf);
  const [tick, setTick] = useState(0);
  const [cinematic, setCinematic] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setCinematic(viewportRuntime.flythrough);
    }, 300);
    return () => clearInterval(id);
  }, []);
  void tick;

  return (
    <div className="pointer-events-none absolute inset-0">
      {showPerf && (
        <div className="absolute left-3 top-3 rounded-md bg-black/55 px-2.5 py-1.5 font-mono text-2xs leading-4 text-white/85 backdrop-blur-sm">
          <div>{viewportRuntime.fps.toFixed(0)} fps · {viewportRuntime.frameMs.toFixed(1)} ms</div>
          <div className="text-white/55">
            {viewportRuntime.drawCalls} calls · {(viewportRuntime.triangles / 1000).toFixed(0)}k tris
          </div>
        </div>
      )}
      <AnimatePresence>
        {cameraMode !== 'orbit' && !cinematic && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3.5 py-1.5 text-2xs text-white/90 backdrop-blur-sm"
          >
            Click to look around · WASD move · Shift sprint
            {cameraMode === 'walk' ? ' · Space jump' : ' · E/Q up & down'} · Esc release
          </motion.div>
        )}
        {cinematic && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-3.5 py-1.5 text-2xs text-white/90 backdrop-blur-sm"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
            Cinematic fly-through — press any key to take over
          </motion.div>
        )}
      </AnimatePresence>
      <MiniMap />
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Workspace() {
  const [ready, setReady] = useState(false);
  const ui = useUIStore();
  const viewportWrapRef = useRef<HTMLDivElement>(null);

  useShortcuts();
  useAutosave();

  // ---- Boot: open the current project or create a fresh one. ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const store = useProjectStore.getState();
      const currentId = loadLocal<string | null>('current-project', null);
      if (currentId) {
        try {
          const record = await getProject(currentId);
          if (record && !cancelled) {
            store.loadProject(record);
            useChatStore.getState().loadFor(record.id);
            setReady(true);
            return;
          }
        } catch {
          // fall through to a new project
        }
      }
      if (!cancelled) {
        const id = store.newProject();
        saveLocal('current-project', id);
        const record = store.toRecord(null);
        if (record) await putProject(record).catch(() => undefined);
        useChatStore.getState().loadFor(id);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Theme class sync (the boot script set it pre-paint). ----
  useEffect(() => {
    document.documentElement.classList.toggle('dark', ui.theme === 'dark');
  }, [ui.theme]);

  // ---- Generation timing → console. ----
  useEffect(() => {
    const handler = (e: Event) => {
      const { ms } = (e as CustomEvent<{ ms: number }>).detail;
      useProjectStore.getState().log('info', `World generated in ${ms.toFixed(0)} ms`);
    };
    window.addEventListener('atlas:generated', handler);
    return () => window.removeEventListener('atlas:generated', handler);
  }, []);

  // ---- Camera bookmark event (from Shift+B). ----
  useEffect(() => {
    const handler = () => buildActions().find((a) => a.id === 'cam-bookmark')?.run();
    window.addEventListener('atlas:bookmark-camera', handler);
    return () => window.removeEventListener('atlas:bookmark-camera', handler);
  }, []);

  // ---- Fullscreen for the viewport wrapper. ----
  useEffect(
    () =>
      on('viewport:fullscreen', () => {
        const el = viewportWrapRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen();
      }),
    [],
  );

  // ---- Drag & drop import: images become guided maps, .atlas3d loads a project. ----
  const onDrop = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    const store = useProjectStore.getState();
    if (file.name.toLowerCase().endsWith('.atlas3d')) {
      try {
        const record = await readShareFile(file);
        await putProject(record);
        store.loadProject(record);
        saveLocal('current-project', record.id);
        useChatStore.getState().loadFor(record.id);
        store.log('success', `Imported project “${record.name}”`);
      } catch (err) {
        store.log('error', `Import failed: ${String(err)}`);
      }
      return;
    }
    if (file.type.startsWith('image/')) {
      try {
        store.log('info', `Analyzing “${file.name}”…`);
        const dataUrl = await fileToDataUrl(file);
        const analysis = await analyzeMapImage(dataUrl, file.name, (s) => store.log('info', s));
        store.setMapImage(dataUrl);
        store.updateWorld({ map: { enabled: true, analysis } }, `Import map ${file.name}`);
        store.log(
          'success',
          analysis.source === 'osm'
            ? `Located “${analysis.location}” — world is built from real OpenStreetMap data`
            : `Map analyzed — generation is now guided by “${file.name}”`,
        );
        useUIStore.getState().set({ leftTab: 'assets', leftOpen: true });
      } catch (err) {
        store.log('error', `Map import failed: ${String(err)}`);
      }
    }
  }, []);

  const { getRootProps, isDragActive } = useDropzone({
    onDrop: (files) => void onDrop(files),
    noClick: true,
    noKeyboard: true,
  });

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-3"
        >
          <Logo size={28} />
          <span className="text-xs text-ink-faint">Opening workspace…</span>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen select-none flex-col overflow-hidden bg-bg text-ink">
      <Leva hidden={!ui.showTuning} collapsed titleBar={{ title: 'Advanced tuning' }} />
      <TopBar />

      <div className="flex min-h-0 flex-1">
        {/* Left panel */}
        <AnimatePresence initial={false}>
          {ui.leftOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: ui.leftWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              className="shrink-0 overflow-hidden border-r border-line bg-surface"
            >
              <div style={{ width: ui.leftWidth }} className="h-full">
                <LeftPanel />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
        {ui.leftOpen && (
          <Resizer
            orientation="vertical"
            onDelta={(d) => ui.set({ leftWidth: clamp(ui.leftWidth + d, 200, 420) })}
            onDoubleClick={() => ui.set({ leftWidth: 264 })}
          />
        )}

        {/* Center column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            {...getRootProps({
              ref: viewportWrapRef,
              className: 'relative min-h-0 flex-1 bg-bg outline-none',
            })}
          >
            <Viewport />
            <ViewportOverlays />
            <AnimatePresence>
              {isDragActive && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[1px]"
                >
                  <div className="rounded-md bg-raised px-4 py-2.5 text-[13px] text-ink shadow-float">
                    Drop a map image or an <span className="font-mono">.atlas3d</span> project
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Collapsed-panel restore buttons */}
            {!ui.leftOpen && (
              <button
                onClick={() => ui.togglePanel('left')}
                className="absolute left-2 top-2 z-10 rounded-md bg-surface/90 p-1.5 text-ink-faint shadow-soft backdrop-blur hover:text-ink"
                title="Show left panel (Ctrl+B)"
              >
                <PanelLeftClose size={14} className="-scale-x-100" />
              </button>
            )}
            {!ui.rightOpen && (
              <button
                onClick={() => ui.togglePanel('right')}
                className="absolute right-2 top-14 z-10 rounded-md bg-surface/90 p-1.5 text-ink-faint shadow-soft backdrop-blur hover:text-ink"
                title="Show right panel (Ctrl+I)"
              >
                <PanelRightClose size={14} className="-scale-x-100" />
              </button>
            )}
            {!ui.bottomOpen && (
              <button
                onClick={() => ui.togglePanel('bottom')}
                className="absolute bottom-2 left-2 z-10 rounded-md bg-surface/90 p-1.5 text-ink-faint shadow-soft backdrop-blur hover:text-ink"
                title="Show bottom panel (Ctrl+J)"
              >
                <PanelBottomClose size={14} className="-scale-y-100" />
              </button>
            )}
          </div>

          {ui.bottomOpen && (
            <Resizer
              orientation="horizontal"
              onDelta={(d) => ui.set({ bottomHeight: clamp(ui.bottomHeight - d, 110, 380) })}
              onDoubleClick={() => ui.set({ bottomHeight: 176 })}
            />
          )}
          <AnimatePresence initial={false}>
            {ui.bottomOpen && (
              <motion.section
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: ui.bottomHeight, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 40 }}
                className="shrink-0 overflow-hidden border-t border-line"
              >
                <div style={{ height: ui.bottomHeight }}>
                  <BottomPanel />
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>

        {/* Right panel */}
        {ui.rightOpen && (
          <Resizer
            orientation="vertical"
            onDelta={(d) => ui.set({ rightWidth: clamp(ui.rightWidth - d, 260, 480) })}
            onDoubleClick={() => ui.set({ rightWidth: 320 })}
          />
        )}
        <AnimatePresence initial={false}>
          {ui.rightOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: ui.rightWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              className="shrink-0 overflow-hidden border-l border-line bg-surface"
            >
              <div style={{ width: ui.rightWidth }} className="h-full">
                <RightPanel />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <StatusBar />
      <CommandPalette />
      <ShortcutsOverlay />
      <SettingsDialog />
    </div>
  );
}
