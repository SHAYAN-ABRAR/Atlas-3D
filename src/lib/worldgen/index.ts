import { HEIGHTFIELD_RES, WORLD_SIZE } from '@/config/constants';
import { hashString } from '@/lib/utils';
import type { GeneratedWorld, WorldState } from '@/types/world';
import { generateCity } from './city';
import { buildHeightfield, makeSampler } from './heightfield';
import { generateVegetation } from './vegetation';

/**
 * Pure, deterministic world derivation. Cached so cosmetic changes
 * (lighting, materials, particles) never trigger a re-generation.
 */

const cache = new Map<string, GeneratedWorld>();
const CACHE_LIMIT = 6;

function genKey(world: WorldState): string {
  const mapHash =
    world.map.enabled && world.map.analysis
      ? hashString(world.map.analysis.cells.join(',')).toString(36)
      : '0';
  return JSON.stringify([
    world.seed,
    world.terrain,
    world.water.enabled,
    world.city,
    world.roads,
    world.vegetation,
    mapHash,
  ]);
}

export function generateWorld(world: WorldState): GeneratedWorld {
  const key = genKey(world);
  const cached = cache.get(key);
  if (cached) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const t0 = performance.now();
  const size = WORLD_SIZE;
  const res = HEIGHTFIELD_RES;

  const { heights, waterLevel } = buildHeightfield(world, res, size);
  let sampler = makeSampler(heights, res, size);

  const { roads, polylines, junctions, buildings } = generateCity(world, sampler, waterLevel, size);

  const half = size / 2;
  const cell = size / (res - 1);

  // Grade the terrain along every road so streets rest on smooth, even ground.
  for (const r of roads) {
    const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
    if (len < 1) continue;
    const steps = Math.max(2, Math.ceil(len / (cell * 0.8)));
    const path: number[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      path.push(sampler(r.ax + (r.bx - r.ax) * t, r.az + (r.bz - r.az) * t));
    }
    // Moving average = the graded route profile.
    const smooth = path.map((_, i) => {
      let sum = 0;
      let n = 0;
      for (let k = -4; k <= 4; k++) {
        const j = i + k;
        if (j >= 0 && j < path.length) {
          sum += path[j];
          n++;
        }
      }
      return sum / n;
    });
    const radius = r.width * 0.5 + 2.5;
    for (let s = 0; s <= steps; s++) {
      // Deep-water spans become bridges — the renderer keeps the deck above
      // the surface — so leave the lakebed alone instead of raising a berm
      // that pokes through the water as a mud causeway. Shallow shore zones
      // still grade up to form natural abutments.
      if (world.water.enabled && smooth[s] < waterLevel - 0.7) continue;
      const t = s / steps;
      const cx = r.ax + (r.bx - r.ax) * t;
      const cz = r.az + (r.bz - r.az) * t;
      const target = Math.max(smooth[s], waterLevel + 0.4);
      const x0 = Math.max(0, Math.floor((cx - radius + half) / cell));
      const x1 = Math.min(res - 1, Math.ceil((cx + radius + half) / cell));
      const z0 = Math.max(0, Math.floor((cz - radius + half) / cell));
      const z1 = Math.min(res - 1, Math.ceil((cz + radius + half) / cell));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(-half + x * cell - cx, -half + z * cell - cz) / radius;
          if (d > 1) continue;
          const i = z * res + x;
          heights[i] += (target - heights[i]) * 0.85 * (1 - d * d);
        }
      }
    }
  }
  sampler = makeSampler(heights, res, size);

  // Settle each building onto a flat pad so nothing floats or clips. Road
  // grading can pull shoreline lots down after placement — drop those
  // instead of leaving a building poking out of the water.
  const settled: typeof buildings = [];
  for (const b of buildings) {
    b.y = sampler(b.x, b.z);
    if (b.y < waterLevel + 0.5) continue;
    settled.push(b);
    const rad = Math.max(b.w, b.d) * 0.72 + cell;
    const x0 = Math.max(0, Math.floor((b.x - rad + half) / cell));
    const x1 = Math.min(res - 1, Math.ceil((b.x + rad + half) / cell));
    const z0 = Math.max(0, Math.floor((b.z - rad + half) / cell));
    const z1 = Math.min(res - 1, Math.ceil((b.z + rad + half) / cell));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const wx = -half + x * cell;
        const wz = -half + z * cell;
        const d = Math.hypot(wx - b.x, wz - b.z) / rad;
        if (d > 1) continue;
        const i = z * res + x;
        const blend = 0.9 * (1 - d * d);
        heights[i] = heights[i] + (b.y - heights[i]) * blend;
      }
    }
  }
  sampler = makeSampler(heights, res, size);

  // Occupancy grid so trees keep clear of streets and lots.
  const OCC = 128;
  const occ = new Uint8Array(OCC * OCC);
  const occScale = OCC / size;
  const mark = (x: number, z: number, r: number) => {
    const gx0 = Math.max(0, Math.floor((x - r + half) * occScale));
    const gx1 = Math.min(OCC - 1, Math.ceil((x + r + half) * occScale));
    const gz0 = Math.max(0, Math.floor((z - r + half) * occScale));
    const gz1 = Math.min(OCC - 1, Math.ceil((z + r + half) * occScale));
    for (let gz = gz0; gz <= gz1; gz++)
      for (let gx = gx0; gx <= gx1; gx++) occ[gz * OCC + gx] = 1;
  };
  for (const b of settled) mark(b.x, b.z, Math.max(b.w, b.d) * 0.75 + 1.5);
  for (const r of roads) {
    const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
    const steps = Math.max(1, Math.ceil(len / (size / OCC)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      mark(r.ax + (r.bx - r.ax) * t, r.az + (r.bz - r.az) * t, r.width * 0.5 + 2);
    }
  }
  const isOccupied = (x: number, z: number) => {
    const gx = Math.floor((x + half) * occScale);
    const gz = Math.floor((z + half) * occScale);
    if (gx < 0 || gz < 0 || gx >= OCC || gz >= OCC) return true;
    return occ[gz * OCC + gx] === 1;
  };

  const trees = generateVegetation(world, sampler, waterLevel, size, isOccupied);

  // Stats
  let underwater = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] < waterLevel) underwater++;
  let roadLength = 0;
  for (const r of roads) roadLength += Math.hypot(r.bx - r.ax, r.bz - r.az);
  let tallest = 0;
  for (const b of settled) tallest = Math.max(tallest, b.h);
  const landArea = size * size * (1 - underwater / heights.length);
  const greenCoverage =
    landArea > 0 ? Math.min(1, (trees.length * 30) / landArea) : 0;

  const generated: GeneratedWorld = {
    key,
    size,
    res,
    heights,
    waterLevel,
    roads,
    roadPolylines: polylines,
    junctions,
    buildings: settled,
    trees,
    heightAt: sampler,
    stats: {
      buildings: settled.length,
      tallestBuilding: tallest,
      trees: trees.length,
      roadLength,
      waterCoverage: underwater / heights.length,
      greenCoverage,
      triangleEstimate:
        (res - 1) * (res - 1) * 2 +
        settled.length * 22 +
        trees.length * 60 +
        roads.length * 12 +
        junctions.length * 18,
    },
  };

  cache.set(key, generated);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  if (typeof window !== 'undefined') {
    // Signal generation timing to whoever is listening (console panel).
    window.dispatchEvent(
      new CustomEvent('atlas:generated', {
        detail: { ms: performance.now() - t0, stats: generated.stats },
      }),
    );
  }
  return generated;
}
