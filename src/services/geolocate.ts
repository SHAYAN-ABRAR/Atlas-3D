/**
 * Automatic map geolocation: reads the place labels burned into an uploaded
 * map screenshot (OCR runs locally via tesseract.js), geocodes them against
 * OpenStreetMap's Nominatim, then downloads the real roads, water, buildings
 * and green space for that area from the Overpass API and rasterizes them
 * into the standard `MapAnalysis` grid.
 *
 * Privacy: the image itself never leaves the machine — only the place-name
 * strings the OCR extracts are sent, as geocoding queries. Every step is
 * best-effort: any failure (no labels, offline, ambiguous location) makes
 * the caller fall back to pure pixel classification.
 */

import { MAP_ANALYSIS_RES } from '@/config/constants';
import type { MapAnalysis } from '@/types/world';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/** Public Overpass instances, tried in order — any one can 504 under load. */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const TERRAIN = 0;
const WATER = 1;
const VEGETATION = 2;
const ROAD = 3;
const BUILDING = 4;

interface GeoPoint {
  lat: number;
  lon: number;
  name: string;
}

/** Result of a successful locate + fetch, ready to become a MapAnalysis. */
export interface LocatedMap {
  analysis: MapAnalysis;
  location: string;
}

/* ------------------------------------------------------------------ */
/* OCR: extract candidate place names from the image                   */
/* ------------------------------------------------------------------ */

/** Downscale huge screenshots so OCR stays fast and accurate. */
async function ocrCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('decode failed'));
    el.src = dataUrl;
  });
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Score OCR lines for "looks like a place label" and return the best few. */
export function rankLabelCandidates(rawLines: string[], limit = 4): string[] {
  const seen = new Set<string>();
  const scored: { text: string; score: number }[] = [];
  for (const raw of rawLines) {
    // Strip OCR junk but keep word structure.
    const text = raw.replace(/[^A-Za-z0-9\s'&.-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 5 || text.length > 48) continue;
    const letters = text.replace(/[^A-Za-z]/g, '').length;
    if (letters / text.length < 0.6) continue;
    const words = text.split(' ').filter((w) => w.length > 1);
    if (words.length < 2) continue; // single words geocode too ambiguously
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const capitalized = words.filter((w) => /^[A-Z]/.test(w)).length;
    const roadSuffix = /\b(rd|road|ave|avenue|st|street|lane|blvd|highway|bridge|park|market|school|college|university|hospital|station|mosque|temple|church|library|stadium|airport)\b/i.test(
      text,
    );
    const score = words.length * 2 + capitalized + (roadSuffix ? 3 : 0);
    scored.push({ text, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.text);
}

async function extractLabels(dataUrl: string): Promise<string[]> {
  const { recognize } = await import('tesseract.js');
  const canvas = await ocrCanvas(dataUrl);
  const result = await recognize(canvas, 'eng');
  return rankLabelCandidates(result.data.text.split('\n'));
}

/* ------------------------------------------------------------------ */
/* Geocoding via Nominatim (rate-limited to 1 request/second)          */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function geocode(query: string): Promise<GeoPoint | null> {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!hits.length) return null;
  return {
    lat: parseFloat(hits[0].lat),
    lon: parseFloat(hits[0].lon),
    name: hits[0].display_name,
  };
}

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Geocodes the candidate labels and picks the tightest cluster: labels from
 * one screenshot must resolve near each other, so agreeing hits are trusted
 * and lone outliers (ambiguous names matched on the wrong continent) drop.
 * Returns the cluster centroid plus a ground-size estimate from its spread.
 */
export function consensus(points: GeoPoint[]): { center: GeoPoint; sideMeters: number } | null {
  if (points.length === 0) return null;
  let best: GeoPoint[] = [points[0]];
  for (const p of points) {
    const cluster = points.filter((q) => haversineMeters(p, q) < 6000);
    if (cluster.length > best.length) best = cluster;
  }
  if (points.length >= 2 && best.length < 2) return null; // all hits disagree — untrustworthy
  const center: GeoPoint = {
    lat: best.reduce((s, p) => s + p.lat, 0) / best.length,
    lon: best.reduce((s, p) => s + p.lon, 0) / best.length,
    name: best[0].name,
  };
  let spread = 0;
  for (const p of best) for (const q of best) spread = Math.max(spread, haversineMeters(p, q));
  // Labels cluster near the middle of a screenshot, so the visible ground
  // extent is comfortably larger than their spread.
  const sideMeters = best.length >= 2 ? Math.min(4000, Math.max(900, spread * 2.5)) : 1200;
  return { center, sideMeters };
}

/* ------------------------------------------------------------------ */
/* Overpass: real map data for the located area                        */
/* ------------------------------------------------------------------ */

interface OverpassElement {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { role: string; geometry?: { lat: number; lon: number }[] }[];
}

export async function fetchOsm(
  center: GeoPoint,
  sideMeters: number,
): Promise<{ elements: OverpassElement[]; bbox: [number, number, number, number] }> {
  const dLat = sideMeters / 2 / 111320;
  const dLon = sideMeters / 2 / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const bbox: [number, number, number, number] = [
    center.lat - dLat,
    center.lon - dLon,
    center.lat + dLat,
    center.lon + dLon,
  ];
  const bb = bbox.join(',');
  const query = `[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)"](${bb});
  way["building"](${bb});
  way["natural"="water"](${bb});
  way["water"](${bb});
  way["waterway"~"^(river|canal)$"](${bb});
  way["landuse"~"^(forest|grass|meadow|recreation_ground|reservoir|basin|orchard)$"](${bb});
  way["leisure"~"^(park|garden|pitch)$"](${bb});
  way["natural"~"^(wood|scrub)$"](${bb});
  relation["natural"="water"](${bb});
);
out geom 8000;`;
  let lastError: unknown = new Error('no Overpass endpoint reachable');
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      // Per-mirror abort: a hung instance must not eat the whole budget.
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = (await res.json()) as { elements: OverpassElement[] };
      return { elements: json.elements, bbox };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Rasterize OSM geometry into the analysis grid                       */
/* ------------------------------------------------------------------ */

type Ring = [number, number][]; // grid-space [x, z]

function toGrid(
  geometry: { lat: number; lon: number }[],
  bbox: [number, number, number, number],
  res: number,
): Ring {
  const [south, west, north, east] = bbox;
  return geometry.map(({ lat, lon }) => [
    ((lon - west) / (east - west)) * res,
    ((north - lat) / (north - south)) * res, // north at the top of the grid
  ]);
}

/** Even-odd scanline polygon fill. */
function fillRing(cells: number[], res: number, ring: Ring, cls: number): void {
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [, z] of ring) {
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  for (let z = Math.max(0, Math.floor(z0)); z <= Math.min(res - 1, Math.ceil(z1)); z++) {
    const scan = z + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      if (az <= scan === bz <= scan) continue;
      xs.push(ax + ((scan - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.round(xs[k]));
      const to = Math.min(res - 1, Math.round(xs[k + 1]) - 1);
      for (let x = from; x <= to; x++) cells[z * res + x] = cls;
    }
  }
}

/** Paints a polyline with the given radius (0 = single cell). */
function strokeLine(cells: number[], res: number, line: Ring, cls: number, radius: number): void {
  const paint = (x: number, z: number) => {
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = Math.round(x) + dx;
        const cz = Math.round(z) + dz;
        if (cx >= 0 && cz >= 0 && cx < res && cz < res) cells[cz * res + cx] = cls;
      }
  };
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1];
    const [bx, bz] = line[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) * 2));
    for (let s = 0; s <= steps; s++) {
      paint(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
    }
  }
}

const isClosed = (ring: Ring) =>
  ring.length > 3 &&
  Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.01;

/** Width multiplier per OSM road class. */
function roadWidthClass(highway: string): number {
  if (/^(motorway|trunk)$/.test(highway)) return 1.7;
  if (highway === 'primary') return 1.5;
  if (/^(secondary|tertiary)$/.test(highway)) return 1.2;
  return 1;
}

/**
 * Clips a polyline to the grid square [0, res], splitting it into the
 * sub-paths that lie inside (Liang–Barsky per segment). Clamping instead
 * would drag exit points along the border and bend the road.
 */
export function clipPath(pts: Ring, res: number): Ring[] {
  const out: Ring[] = [];
  let current: Ring = [];
  const flush = () => {
    if (current.length >= 2) out.push(current);
    current = [];
  };
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const dx = bx - ax;
    const dz = bz - az;
    let t0 = 0;
    let t1 = 1;
    let rejected = false;
    for (const [p, q] of [
      [-dx, ax],
      [dx, res - ax],
      [-dz, az],
      [dz, res - az],
    ]) {
      if (p === 0) {
        if (q < 0) rejected = true;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (rejected || t0 > t1) {
      flush();
      continue;
    }
    const enter: [number, number] = [ax + dx * t0, az + dz * t0];
    const exit: [number, number] = [ax + dx * t1, az + dz * t1];
    if (current.length === 0 || t0 > 0) {
      flush();
      current = [enter];
    }
    current.push(exit);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

/**
 * Exact road centerlines in grid coordinates, clipped to the grid square.
 * These ride along with the rasterized cells so world generation can lay
 * streets with their true curves instead of re-tracing pixels.
 */
export function extractRoadPaths(
  elements: OverpassElement[],
  bbox: [number, number, number, number],
  res: number,
): { w: number; pts: [number, number][] }[] {
  const paths: { w: number; pts: [number, number][] }[] = [];
  for (const el of elements) {
    const highway = el.tags?.highway;
    if (!highway || !el.geometry) continue;
    const w = roadWidthClass(highway);
    for (const pts of clipPath(toGrid(el.geometry, bbox, res), res)) {
      paths.push({ w, pts });
    }
  }
  return paths;
}

export function rasterizeOsm(
  elements: OverpassElement[],
  bbox: [number, number, number, number],
  res: number,
): number[] {
  const cells = new Array<number>(res * res).fill(TERRAIN);

  const rings = (el: OverpassElement): Ring[] => {
    if (el.geometry) return [toGrid(el.geometry, bbox, res)];
    if (el.members)
      return el.members
        .filter((m) => m.role === 'outer' && m.geometry)
        .map((m) => toGrid(m.geometry!, bbox, res));
    return [];
  };

  // Ground covers first, then buildings, then roads — so streets always
  // stay continuous and buildings never bury the road network.
  const passes: [(t: Record<string, string>) => boolean, number, boolean][] = [
    [(t) => 'landuse' in t || 'leisure' in t || t.natural === 'wood' || t.natural === 'scrub', VEGETATION, true],
    [(t) => t.natural === 'water' || 'water' in t || t.landuse === 'reservoir' || t.landuse === 'basin', WATER, true],
    [(t) => 'waterway' in t, WATER, false],
    [(t) => 'building' in t, BUILDING, true],
    [(t) => 'highway' in t, ROAD, false],
  ];

  for (const [match, cls, asFill] of passes) {
    for (const el of elements) {
      const tags = el.tags ?? {};
      if (!match(tags)) continue;
      for (const ring of rings(el)) {
        if (ring.length < 2) continue;
        if (asFill && isClosed(ring)) fillRing(cells, res, ring, cls);
        else if (cls === ROAD) {
          const major = /^(motorway|trunk|primary)$/.test(tags.highway ?? '');
          strokeLine(cells, res, ring, cls, major ? 1 : 0);
        } else strokeLine(cells, res, ring, cls, 1);
      }
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
}

/** Short human name: "Agargaon, Dhaka" instead of the full address chain. */
function shortName(displayName: string): string {
  return displayName.split(',').slice(0, 2).map((s) => s.trim()).join(', ');
}

/**
 * The full pipeline. Resolves to null when the map cannot be confidently
 * located; throws only on unexpected errors (callers treat both as
 * "fall back to pixel classification").
 */
export async function locateMap(
  dataUrl: string,
  sourceName: string,
  onStatus?: (status: string) => void,
): Promise<LocatedMap | null> {
  if (typeof window === 'undefined' || !navigator.onLine) return null;

  onStatus?.('Reading place labels…');
  const labels = await withTimeout(extractLabels(dataUrl), 30000, 'OCR');
  if (labels.length === 0) return null;

  onStatus?.('Locating area…');
  const points: GeoPoint[] = [];
  for (const label of labels) {
    if (points.length > 0) await sleep(1100); // Nominatim fair-use: 1 req/s
    try {
      const hit = await withTimeout(geocode(label), 8000, 'geocoding');
      if (hit) points.push(hit);
    } catch {
      // one bad label is fine — consensus decides
    }
  }
  const area = consensus(points);
  if (!area) return null;

  onStatus?.(`Fetching map data for ${shortName(area.center.name)}…`);
  const { elements, bbox } = await withTimeout(
    fetchOsm(area.center, area.sideMeters),
    40000, // three mirrors × 12 s per-mirror abort, plus body download
    'Overpass',
  );
  if (elements.length < 10) return null; // essentially empty map data

  const res = MAP_ANALYSIS_RES;
  const cells = rasterizeOsm(elements, bbox, res);
  const roadPaths = extractRoadPaths(elements, bbox, res);
  const counts = [0, 0, 0, 0, 0];
  for (const c of cells) counts[c]++;
  const total = cells.length;
  const location = shortName(area.center.name);

  return {
    location,
    analysis: {
      width: res,
      height: res,
      cells,
      sourceName,
      location,
      source: 'osm',
      roadPaths,
      coverage: {
        water: counts[WATER] / total,
        vegetation: counts[VEGETATION] / total,
        road: counts[ROAD] / total,
        building: counts[BUILDING] / total,
      },
    },
  };
}
