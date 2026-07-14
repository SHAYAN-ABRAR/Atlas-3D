# Atlas 3D

**Transform any 2D map into an explorable 3D world.**

Atlas 3D is a local-first creative studio that runs entirely in your browser. Drop in a
satellite image, blueprint, floor plan, or hand-drawn map — the app classifies it on your
machine, builds terrain, streets, architecture and atmosphere around it, then hands you the
camera and an AI co-designer. There are no accounts, no cloud storage, and no external
database: every project lives in IndexedDB and localStorage on your computer.

Built with Next.js, React Three Fiber and Three.js. AI runs through a local
[Ollama](https://ollama.com) instance, with a built-in offline interpreter as fallback —
the app is fully usable without any model at all.

---

## Table of contents

- [Quick start](#quick-start)
- [Setting up the AI assistant](#setting-up-the-ai-assistant)
- [Using the studio](#using-the-studio)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [The procedural engine](#the-procedural-engine)
- [Importing maps](#importing-maps)
- [Exporting and sharing](#exporting-and-sharing)
- [Where your data lives](#where-your-data-lives)
- [Architecture](#architecture)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Scripts](#scripts)

---

## Quick start

**Requirements:** Node.js 18+ and a browser with WebGL 2 (any recent Chrome, Edge, Firefox
or Safari).

```bash
git clone git@github.com:SHAYAN-ABRAR/atlas-3d.git
cd atlas-3d
npm install
npm run dev
```

Open <http://localhost:3000>. Drop a map image onto the landing page — or click
**Start from a blank world** — and you're in the studio.

For a production build:

```bash
npm run build
npm run start
```

---

## Setting up the AI assistant

The assistant streams from a locally running Ollama server. Nothing leaves your machine
unless you choose an Ollama **cloud** model (those execute on Ollama's servers under your
Ollama account).

```bash
# install ollama from https://ollama.com, then:
ollama run kimi-k2.6:cloud
```

The default model is `kimi-k2.6:cloud`. Both the endpoint (`http://127.0.0.1:11434`) and
the model name are configurable in **Settings → Local AI**, with a one-click connection
test. Any chat-capable Ollama model works — e.g. `gemma4:31b-cloud` or a fully local model
like `llama3.1`.

> **Note on cloud models:** some Ollama cloud models (including Kimi) require a paid
> Ollama subscription. If the status chip says *Model not pulled* or requests fail with
> `403 — this model requires a subscription`, either upgrade at
> [ollama.com/upgrade](https://ollama.com/upgrade) or switch the model in Settings.

### No Ollama? It still works

When the model is unreachable, a built-in offline interpreter maps common requests to
scene commands using keyword rules. All of these work with zero AI setup:

- “Create a medieval kingdom” · “Generate a cyberpunk district”
- “Sunset lighting” · “Rainy evening” · “Clear night with stars”
- “Replace every building with Japanese architecture”
- “Make all roads 25% wider” · “Add sidewalks”
- “Make it mountainous with rivers” · “More trees” · “Make everything marble”
- “How many buildings are there?” · “Optimize this scene for mobile”
- “Give me a cinematic fly-through”

Messages answered offline are tagged with an `offline` badge in the chat.

### How the AI edits the scene

The model receives a compact summary of the live world (terrain, city, lighting, stats)
and replies with a short sentence plus a fenced ` ```atlas ` block containing JSON
commands — for example:

```json
{ "commands": [ { "action": "set_lighting", "preset": "sunset" },
                { "action": "set_weather", "particles": "rain" } ] }
```

Atlas validates each command, applies the whole batch as **one undo step**, strips the
JSON from the chat bubble, and shows green “applied” chips under the message. The full
action list covers world generation, terrain, buildings, roads, vegetation, water,
lighting, weather, materials, camera fly-throughs, optimization and scene statistics.

---

## Using the studio

The workspace is a three-panel layout around a WebGL viewport. Every panel is resizable
(drag the dividers, double-click to reset) and collapsible.

### Left panel

| Tab | What it does |
|---|---|
| **Scene** | Hierarchy of the world — terrain, water, roads, buildings, vegetation, atmosphere — with live counts, per-layer visibility toggles (eye icons), and click-to-edit navigation into the inspector. |
| **Assets** | Your source map (preview, re-analyze, toggle “guide generation”, remove) plus six starter worlds: Medieval Kingdom, Cyberpunk District, Modern City, Island Village, Mountain Wilds, Nordic Harbor. |
| **History** | The undo timeline. Every edit is a labeled entry — click any point to jump back to it. |

### Right panel

| Tab | What it does |
|---|---|
| **Design** | The inspector: World (seed + reroll), Terrain (style, elevation, water level, rivers), Buildings (architecture, layout, density, max floors, extent), Roads (width, sidewalks), Vegetation (species, density), Lighting & atmosphere (preset, fog, exposure, weather particles), Materials (scene-wide override), Performance (quality tier, auto-degrade, overlays). Sliders coalesce into a single undo step per drag. |
| **Assistant** | The AI chat: streaming replies, applied-command chips, prompt history, ⭐ favorites (star any of your messages), and 19 curated prompt templates grouped by category. |

### Bottom panel

| Tab | What it does |
|---|---|
| **Console** | Timestamped log of everything the app does — imports, generation timing, assistant actions, exports, warnings. |
| **Performance** | Live FPS graph with a 60 fps reference line, frame time, draw calls, triangle count. |
| **Generation** | Current world statistics: building count, tallest structure, trees, road length, water and green coverage, triangle estimate, seed, last generation time. |

### Viewport

- **Orbit** (`1`) — drag to rotate, scroll to zoom, right-drag to pan.
- **Walk** (`2`) — click to capture the mouse; WASD to move, Shift to sprint,
  Space to jump, Esc to release. Gravity keeps you grounded to the terrain.
- **Fly** (`3`) — free flight; E/Q or Space/C for up/down.
- **Cinematic fly-through** — the clapperboard button, the palette, or just ask the
  assistant. Any input hands the camera back to you.
- **Minimap** (`M`) — live top-down render with your position and view cone.
  **Click anywhere on it to teleport.**
- Camera **bookmarks** (`Shift B`, bookmark menu in the top bar), **frame world** (`F`),
  orientation gizmo, infinite grid (`G`), fullscreen (`Shift F`), one-click screenshots.

Autosave runs ~1.2 s after you stop editing (the dot next to the project name shows save
state); `Ctrl S` flushes immediately. Dark and light themes are in Settings or the
top-bar toggle.

---

## Keyboard shortcuts

Press `?` in the studio for this list in-app.

| Keys | Action |
|---|---|
| `Ctrl K` | Command palette (every action, searchable) |
| `Ctrl S` | Save project |
| `Ctrl Z` / `Ctrl ⇧ Z` / `Ctrl Y` | Undo / redo |
| `Ctrl B` / `Ctrl I` / `Ctrl J` | Toggle left / right / bottom panel |
| `1` / `2` / `3` | Orbit / walk / fly camera |
| `F` | Frame the whole world |
| `G` / `M` / `P` | Toggle grid / minimap / performance overlay |
| `⇧ B` | Bookmark the current camera |
| `⇧ F` | Fullscreen viewport |
| `?` | Shortcut overlay |

---

## The procedural engine

Everything derives deterministically from a small, serializable **world description**
(seed + settings). The same seed produces the identical world on any machine — which is
what makes undo, autosave and project sharing nearly free.

- **Terrain** — seeded simplex/fBm heightfields in six styles: *flat, plains, rolling
  hills, mountains* (domain-warped ridged multifractal), *islands* (radial falloff), and
  *canyon* (terraced). Rivers walk downhill from high ground with momentum and carve
  smooth channels. Terrain is vertex-colored by elevation, slope (rock on steep faces),
  and broad moisture patches, with a tiling grain texture for close-up detail.
- **Cities** — three street layouts (*grid*, *radial*, *organic*) with terrain-aware lot
  placement (slope and water checks), downtown height falloff, and terrain **grading**:
  the ground is smoothed under every road and flattened into a pad under every building.
  Medieval radial towns get a castle keep.
- **Architecture** — six styles (*modern, medieval, japanese, cyberpunk, nordic,
  industrial*), each with its own palette, footprint range, roof form (flat parapet,
  pyramid, pagoda overhang) and window color. Facades are procedural textures — glass
  with sky reflection by day, a matching emissive window grid that lights up at night.
- **Vegetation** — noise-masked scatter that respects water, slopes, roads and lots.
  Conifers are stacked-cone silhouettes, broadleaf trees are multi-lobe faceted crowns;
  five species palettes.
- **Lighting** — seven presets (*midday, dawn, sunset, night, overcast, rainy evening,
  cyberpunk night*) driving the sun, sky scattering, fog, stars, exposure and window
  glow, plus procedural image-based lighting so glass and metal always have something to
  reflect. Weather particles: rain, snow, fireflies, embers.
- **Materials** — scene-wide overrides (marble, dark walnut, concrete, sandstone,
  obsidian, copper) that re-skin every building; “Original” restores each style's palette.

All textures are painted onto canvases at runtime. The repository contains **zero binary
assets**.

---

## Importing maps

Drop an image anywhere (landing page, viewport, or the Assets tab). Two analysis paths
produce the same 96×96 class grid that guides generation:

**1. Auto-location (satellite screenshots with place labels).** The importer OCRs the
place names burned into the screenshot (tesseract.js, on your machine), geocodes them
against OpenStreetMap's Nominatim, keeps only labels that agree on one area, then
downloads the *real* roads, water bodies, buildings and green space for that spot from
the Overpass API. The world is then built from actual map data — streets connect, ponds
sit where they really are. The console and Assets tab show the located place name.
Privacy note: the image itself never leaves your machine; only the extracted place-name
text is sent as geocoding queries.

**2. Pixel classification (everything else, and the offline fallback).** The image is
downsampled to the grid in a Web Worker, auto-leveled so hazy and punchy renders measure
alike, and each cell is classified:

| Class | Detected from | Effect on generation |
|---|---|---|
| Water | blue or algae-green, glassy-smooth regions | sinks below the water line |
| Vegetation | green-dominant or textured dark canopy | forests concentrate here |
| Road | ribbon-shaped gray/dark corridors, route overlays | road segments trace the runs |
| Building | massive bright or textured blocks, brick/roof reds | lots and structures appear here |
| Terrain | warm dirt, sand, open ground, everything else | normal heightfield |

Ambiguous colors (gray pavement vs. rooftop, dark pond vs. tree shade) are resolved by
*shape*: thin ribbons become streets, compact smooth blobs become water, textured mass
becomes buildings or canopy.

The console reports the coverage breakdown after analysis. The **“Guide generation with
this map”** switch (Assets tab) toggles between map-guided and purely procedural
generation at any time — the map is stored with the project, so you can re-analyze or
remove it later.

Works with satellite imagery, floor plans, blueprints, historical maps, fantasy maps,
dungeon maps, and pen-on-paper sketches — anything where color roughly encodes meaning.

---

## Exporting and sharing

From the **Export** menu in the top bar:

| Format | Notes |
|---|---|
| **GLB** | Instancing is baked into plain meshes — opens in Blender, three.js viewers, game engines. |
| **OBJ** | Same baked geometry for legacy pipelines. |
| **PNG** | Exact viewport frame at canvas resolution. |
| **.atlas3d** | The whole project — world description, seed, source map image — as one JSON file. Drop it onto Atlas 3D on any other computer and the **identical** world regenerates there. This is the intended way to move work between desktops. |

---

## Where your data lives

Everything is local. Refresh, close the tab, reboot — nothing is lost, and nothing is
sent anywhere.

| Store | Contents |
|---|---|
| IndexedDB `atlas3d` → `projects` | Full project records: world state, source map, thumbnail, timestamps. |
| `localStorage atlas3d:ui` | Theme, panel layout and sizes, quality tier, camera bookmarks, Ollama endpoint/model. |
| `localStorage atlas3d:current-project` | Which project the studio reopens. |
| `localStorage atlas3d:prompt-history` / `atlas3d:saved-prompts` | Assistant history and favorites. |
| `localStorage atlas3d:chat:<project-id>` | Per-project conversation. |

To wipe everything, clear site data for `localhost:3000` in your browser.

---

## Architecture

```
src/
  app/               Next.js App Router — landing page, /studio, global CSS tokens
  components/
    ui/              Hand-rolled primitives (button, select, dialog, tabs, tooltip…)
    landing/         Procedural globe, upload zone, recent projects
    workspace/       Top bar, panels, inspector, assistant, palette, minimap, overlays
  three/             R3F scene graph — terrain, buildings, roads, vegetation, water,
                     atmosphere, particles, camera rig, procedural textures, viewport
  lib/
    worldgen/        The pure generation pipeline (heightfield → city → grading → trees)
    noise.ts rng.ts  Seeded simplex/fBm/ridged noise, mulberry32 PRNG
    bus.ts           Typed event bus + per-frame runtime values (kept out of React state)
    minimap-draw.ts  Shared top-down renderer (minimap + project thumbnails)
  services/          IndexedDB, Ollama client + command protocol, offline interpreter,
                     map analysis, GLB/OBJ/PNG exporters, .atlas3d share format
  stores/            Zustand — project (world + undo/redo + logs), UI layout, chat
  hooks/             Keyboard shortcuts, debounced autosave
  workers/           Map-classification Web Worker (main-thread fallback included)
  config/            Design constants, presets, world/prompt templates, action registry
  types/             Strict shared TypeScript types
```

Design decisions worth knowing:

- **Description vs. derivation.** `WorldState` (a few KB of JSON) is the only persisted
  truth. The heavy `GeneratedWorld` (heightfield, building/tree instances, stats) is a
  cached pure function of it — cosmetic edits like lighting never trigger regeneration.
- **One undo model.** Inspector edits, AI command batches and slider drags all commit
  snapshots to the same history; the History tab is just a view of it.
- **Imperative escape hatch.** Camera moves, exports and screenshots flow through a tiny
  typed event bus instead of React state; per-frame values (FPS, camera pose) live in a
  mutable runtime object polled by the status bar and minimap.
- **Command palette and shortcuts share one action registry**, so they can never drift
  apart.

---

## Performance

- Buildings, roofs, trunks and canopies are **instanced meshes** — a full city renders in
  ~20 draw calls.
- Three quality tiers (resolution scale, shadow map size) plus an **auto-governor**: if
  FPS stays below ~27 for five seconds it steps the quality down once and logs it.
- Frustum culling, texture/geometry disposal on regeneration, DPR clamping, and a
  generation cache keyed by the gen-relevant subset of the world state.
- Typical scene: 60–70 buildings, ~450 trees, ~250 k triangles at a steady 140+ fps on a
  mid-range GPU.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Assistant chip says **Offline interpreter** | Ollama isn't running. Start it (`ollama serve` happens automatically with the desktop app) and click the chip to re-check. Offline commands still work meanwhile. |
| Chip says **Model not pulled** | `ollama pull <model>` — or change the model in Settings to one you already have (`ollama list`). |
| `403 — model requires a subscription` in the console | That Ollama **cloud** model isn't included in your Ollama plan. Upgrade at ollama.com/upgrade or pick another model in Settings. |
| Viewport is black / blank | Confirm WebGL 2 at `chrome://gpu` (or your browser's equivalent) and that hardware acceleration is enabled. |
| FPS is low | Let the auto-governor act, or set Performance → Quality to *Mobile*; reduce vegetation density and city extent for very large scenes. |
| A generated world looks wrong after an update | Roll a new seed (dice button) or pick a starter world — old projects keep their exact saved settings by design. |

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server at `localhost:3000` |
| `npm run build` | Type-checked, linted production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run format` | Prettier over `src/` |

---

Built by **Shayan Abrar**. Powered by Next.js, React Three Fiber, Three.js, Zustand,
Framer Motion, Tailwind CSS and Ollama.
