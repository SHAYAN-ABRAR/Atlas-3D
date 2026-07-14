# `map-analysis.worker.ts`

A Web Worker that classifies a downsampled map image off the main thread, so the UI
never stutters while an uploaded map is analyzed.

It is the background half of Atlas 3D's map-import pipeline: when you drop a satellite
image, floor plan, or hand-drawn map into the studio, this worker labels every cell of a
96×96 grid as **terrain / water / vegetation / road / building**. Those labels drive where
water sinks, forests concentrate, roads trace, and buildings appear during procedural
world generation.

---

## What it does

The worker is deliberately thin. All classification logic lives in the shared, pure
[`classifyPixels`](../lib/classify.ts) function, which both the worker and its main-thread
fallback call — so results are identical wherever the work runs. The worker's only job is
to receive pixel data, run the classifier, and post the result back:

```ts
import { classifyPixels } from '@/lib/classify';

self.onmessage = (e: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number }>) => {
  const { data, width, height } = e.data;
  const cells = classifyPixels(data, width, height);
  (self as unknown as Worker).postMessage({ cells });
};
```

Keeping the heavy per-pixel loop and its denoise pass on a worker thread keeps the WebGL
viewport at full frame rate during import.

---

## Message protocol

| Direction | Message shape | Meaning |
|---|---|---|
| **In** (`postMessage` → worker) | `{ data: Uint8ClampedArray; width: number; height: number }` | Raw RGBA pixels from a `res × res` canvas (`res = 96`, see `MAP_ANALYSIS_RES`). |
| **Out** (worker → `onmessage`) | `{ cells: number[] }` | One class per cell, row-major: `0` terrain · `1` water · `2` vegetation · `3` road · `4` building. |

The worker is stateless and single-shot per message — the caller spins up a fresh worker
per analysis and terminates it once a result (or error) arrives.

---

## How it fits in

```
uploaded image
      │
      ▼
analyzeMapImage()            (src/services/map-analysis.ts)
  ├─ try auto-location first  (src/services/geolocate.ts: OCR → Nominatim →
  │        Overpass → rasterize real OSM data; worker not involved)
  ├─ otherwise: cover-fit draw to a 96×96 canvas, read back RGBA
  ├─ classifyInWorker(data) ──► map-analysis.worker.ts ──► classifyPixels()
  │        │
  │        └─ 4 s timeout / worker error ─┐
  │                                       ▼
  └─ catch ─────────────────► classifyPixels() on the main thread   (fallback)
      │
      ▼
  coverage stats + per-cell labels → world generation
```

The [`analyzeMapImage`](../services/map-analysis.ts) service owns the lifecycle:

- **Timeout** — the worker is given **4 seconds**; if it hasn't replied, it's terminated
  and the request rejects.
- **Fallback** — any worker failure (timeout, `onerror`, or an environment without worker
  support) is caught and the *same* `classifyPixels` runs synchronously on the main
  thread. Analysis therefore always completes; the worker is a performance optimization,
  not a hard dependency.
- **Cleanup** — the worker is `terminate()`d on success, error, and timeout, so no worker
  outlives a single analysis.

---

## Why a separate worker file

Bundlers (Next.js / Turbopack / webpack) turn

```ts
new Worker(new URL('../workers/map-analysis.worker.ts', import.meta.url));
```

into a self-contained worker bundle at build time. The `.worker.ts` file is that bundle's
entry point — it must have no DOM dependencies and communicate only through
`postMessage`, both of which hold here since it imports a single pure function.

---

## Related files

| File | Role |
|---|---|
| [`src/lib/classify.ts`](../lib/classify.ts) | The pure classifier (color rules + shape-based candidate resolution + denoise) shared by worker and fallback. |
| [`src/services/map-analysis.ts`](../services/map-analysis.ts) | Downsamples the image, drives the worker, computes coverage stats. |
| [`src/config/constants.ts`](../config/constants.ts) | `MAP_ANALYSIS_RES` — the 96×96 analysis grid resolution. |
| [`src/types/world.ts`](../types/world.ts) | `MapAnalysis` — the result type (`cells`, `coverage`, dimensions). |
