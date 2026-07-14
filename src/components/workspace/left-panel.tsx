'use client';

import {
  Building2,
  Clock3,
  Droplets,
  Eye,
  EyeOff,
  FileUp,
  Globe2,
  Image as ImageIcon,
  Mountain,
  Route,
  Sparkles,
  Trash2,
  Trees,
  Undo2,
} from 'lucide-react';
import { useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs } from '@/components/ui/tabs';
import { WORLD_TEMPLATES } from '@/config/world-templates';
import { cn, timeAgo } from '@/lib/utils';
import { generateWorld } from '@/lib/worldgen';
import { applyCommands } from '@/services/commands';
import { analyzeMapImage, fileToDataUrl } from '@/services/map-analysis';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore, type LayerVisibility, type LeftTab } from '@/stores/ui-store';

/* ------------------------------------------------------------------ */
/* Scene tree                                                          */
/* ------------------------------------------------------------------ */

function SceneTree() {
  const world = useProjectStore((s) => s.world);
  const name = useProjectStore((s) => s.name);
  const layers = useUIStore((s) => s.layers);
  const toggleLayer = useUIStore((s) => s.toggleLayer);
  const set = useUIStore((s) => s.set);
  const gen = useMemo(() => generateWorld(world), [world]);

  const rows: {
    id: keyof LayerVisibility;
    label: string;
    icon: React.ReactNode;
    meta?: string;
    section: string;
  }[] = [
    { id: 'terrain', label: 'Terrain', icon: <Mountain size={13} />, meta: world.terrain.style, section: 'sec-terrain' },
    { id: 'water', label: 'Water', icon: <Droplets size={13} />, meta: world.water.enabled ? `${(gen.stats.waterCoverage * 100).toFixed(0)}%` : 'off', section: 'sec-terrain' },
    { id: 'roads', label: 'Roads', icon: <Route size={13} />, meta: `${(gen.stats.roadLength / 1000).toFixed(1)} km`, section: 'sec-buildings' },
    { id: 'buildings', label: 'Buildings', icon: <Building2 size={13} />, meta: gen.stats.buildings.toLocaleString(), section: 'sec-buildings' },
    { id: 'vegetation', label: 'Vegetation', icon: <Trees size={13} />, meta: gen.stats.trees.toLocaleString(), section: 'sec-vegetation' },
    { id: 'effects', label: 'Atmosphere', icon: <Sparkles size={13} />, meta: world.lighting.preset, section: 'sec-lighting' },
  ];

  const focus = (section: string) => {
    set({ rightOpen: true, rightTab: 'design' });
    requestAnimationFrame(() =>
      document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  return (
    <div className="p-2">
      <div className="flex items-center gap-2 rounded px-2 py-1.5">
        <Globe2 size={14} className="text-accent" />
        <span className="truncate text-[13px] font-medium text-ink">{name}</span>
      </div>
      <div className="mt-0.5 space-y-px pl-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="group flex items-center gap-2 rounded pl-2 pr-1 hover:bg-overlay"
          >
            <button
              onClick={() => focus(row.section)}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
              title={`Edit ${row.label.toLowerCase()}`}
            >
              <span className="text-ink-faint">{row.icon}</span>
              <span className={cn('text-xs', layers[row.id] ? 'text-ink' : 'text-ink-faint line-through')}>
                {row.label}
              </span>
              {row.meta && (
                <span className="ml-auto font-mono text-2xs tabular-nums text-ink-faint">
                  {row.meta}
                </span>
              )}
            </button>
            <button
              onClick={() => toggleLayer(row.id)}
              className={cn(
                'rounded p-1 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100',
                !layers[row.id] && 'opacity-100 text-ink-muted',
              )}
              aria-label={`Toggle ${row.label} visibility`}
            >
              {layers[row.id] ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

function AssetsTab() {
  const mapImage = useProjectStore((s) => s.mapImage);
  const world = useProjectStore((s) => s.world);
  const setMapImage = useProjectStore((s) => s.setMapImage);
  const updateWorld = useProjectStore((s) => s.updateWorld);
  const log = useProjectStore((s) => s.log);

  const importMap = async (file: File) => {
    try {
      log('info', `Analyzing “${file.name}”…`);
      const dataUrl = await fileToDataUrl(file);
      const analysis = await analyzeMapImage(dataUrl, file.name, (s) => log('info', s));
      setMapImage(dataUrl);
      updateWorld({ map: { enabled: true, analysis } }, `Import map ${file.name}`);
      const c = analysis.coverage;
      const from =
        analysis.source === 'osm'
          ? `Located “${analysis.location}” — built from OpenStreetMap data`
          : 'Analyzed from pixels';
      log(
        'success',
        `${from} — water ${(c.water * 100).toFixed(0)}%, vegetation ${(c.vegetation * 100).toFixed(0)}%, roads ${(c.road * 100).toFixed(0)}%, built ${(c.building * 100).toFixed(0)}%`,
      );
    } catch (err) {
      log('error', `Map import failed: ${String(err)}`);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'image/*': [] },
    multiple: false,
    onDrop: (files) => files[0] && void importMap(files[0]),
  });

  return (
    <div className="space-y-4 p-3">
      <div>
        <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-ink-faint">
          Source map
        </div>
        {mapImage ? (
          <div className="overflow-hidden rounded-md border border-line">
            <img src={mapImage} alt="Project map" className="block max-h-40 w-full object-cover" />
            <div className="space-y-2.5 border-t border-line p-2.5">
              {world.map.analysis?.location && (
                <div className="text-2xs text-ink-faint">
                  Located: <span className="text-ink-muted">{world.map.analysis.location}</span>
                  {' · '}OpenStreetMap data
                </div>
              )}
              <Switch
                label="Guide generation with this map"
                checked={world.map.enabled}
                onChange={(v) => updateWorld({ map: { enabled: v } }, v ? 'Enable map guidance' : 'Disable map guidance')}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={async () => {
                    const analysis = await analyzeMapImage(mapImage, 'map');
                    updateWorld({ map: { analysis } }, 'Re-analyze map');
                    log('success', 'Map re-analyzed');
                  }}
                >
                  Re-analyze
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setMapImage(null);
                    updateWorld({ map: { enabled: false, analysis: null } }, 'Remove map');
                  }}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            {...getRootProps()}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-6 text-center transition-colors',
              isDragActive ? 'border-accent bg-accent/5' : 'hover:border-ink-faint',
            )}
          >
            <input {...getInputProps()} />
            <FileUp size={16} className="text-ink-faint" />
            <div className="text-xs text-ink-muted">
              Drop a map, blueprint or floor plan
              <div className="mt-0.5 text-2xs text-ink-faint">PNG · JPG · WEBP</div>
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-ink-faint">
          Starter worlds
        </div>
        <div className="space-y-1">
          {WORLD_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => applyCommands([{ action: 'generate_world', template: t.id }])}
              className="group w-full rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-overlay"
            >
              <div className="flex items-center gap-2">
                <ImageIcon size={13} className="text-ink-faint group-hover:text-accent" />
                <span className="text-xs font-medium text-ink">{t.name}</span>
              </div>
              <div className="mt-0.5 pl-[21px] text-2xs leading-relaxed text-ink-faint">
                {t.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const past = useProjectStore((s) => s.past);
  const future = useProjectStore((s) => s.future);
  const jumpTo = useProjectStore((s) => s.jumpTo);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  return (
    <div className="p-2">
      <div className="mb-2 flex gap-1.5 px-1">
        <Button size="sm" className="flex-1" disabled={past.length === 0} onClick={undo}>
          <Undo2 size={12} /> Undo
        </Button>
        <Button size="sm" className="flex-1" disabled={future.length === 0} onClick={redo}>
          <Undo2 size={12} className="-scale-x-100" /> Redo
        </Button>
      </div>
      {past.length === 0 && future.length === 0 && (
        <div className="px-3 py-8 text-center text-xs text-ink-faint">
          Edits will appear here as an undoable timeline.
        </div>
      )}
      <div className="space-y-px">
        {past.map((entry, i) => (
          <button
            key={`${entry.at}-${i}`}
            onClick={() => jumpTo(i)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-overlay"
            title="Jump back to before this edit"
          >
            <Clock3 size={11} className="shrink-0 text-ink-faint" />
            <span className="flex-1 truncate text-xs text-ink-muted">{entry.label}</span>
            <span className="font-mono text-2xs text-ink-faint">{timeAgo(entry.at)}</span>
          </button>
        ))}
        <div className="flex items-center gap-2 rounded bg-accent/10 px-2 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="text-xs font-medium text-ink">Current state</span>
        </div>
        {future.map((entry, i) => (
          <div
            key={`f-${entry.at}-${i}`}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 opacity-50"
          >
            <Clock3 size={11} className="shrink-0 text-ink-faint" />
            <span className="flex-1 truncate text-xs text-ink-faint">{entry.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function LeftPanel() {
  const tab = useUIStore((s) => s.leftTab);
  const set = useUIStore((s) => s.set);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-2">
        <Tabs<LeftTab>
          layoutId="left-tabs"
          value={tab}
          onChange={(v) => set({ leftTab: v })}
          tabs={[
            { value: 'scene', label: 'Scene' },
            { value: 'assets', label: 'Assets' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'scene' && <SceneTree />}
        {tab === 'assets' && <AssetsTab />}
        {tab === 'history' && <HistoryTab />}
      </div>
    </div>
  );
}
