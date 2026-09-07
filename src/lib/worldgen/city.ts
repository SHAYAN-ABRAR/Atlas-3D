import { BUILDING_STYLES } from '@/config/constants';
import { mulberry32, type Rng } from '@/lib/rng';
import { clamp, lerp } from '@/lib/utils';
import type {
  BuildingInstance,
  RoadJunction,
  RoadPolyline,
  RoadSegment,
  WorldState,
} from '@/types/world';
import { vectorizeRoads } from './roads';
import { buildJunctionNetwork } from './road-network';

export interface CityGenResult {
  roads: RoadSegment[];
  polylines: RoadPolyline[];
  junctions: RoadJunction[];
  buildings: BuildingInstance[];
}

type Sampler = (x: number, z: number) => number;

const BASE_ROAD_WIDTH = 6.2;

/** Flattens polylines into the segment list used for grading and clearance. */
function polylinesToSegments(polylines: RoadPolyline[]): RoadSegment[] {
  const roads: RoadSegment[] = [];
  for (const poly of polylines) {
    for (let i = 1; i < poly.pts.length; i++) {
      const [ax, az] = poly.pts[i - 1];
      const [bx, bz] = poly.pts[i];
      if (Math.hypot(bx - ax, bz - az) < 0.4) continue;
      roads.push({ ax, az, bx, bz, width: poly.width });
    }
  }
  return roads;
}

export function generateCity(
  world: WorldState,
  sampler: Sampler,
  waterLevel: number,
  size: number,
): CityGenResult {
  if (!world.city.enabled) return { roads: [], polylines: [], junctions: [], buildings: [] };

  const rng = mulberry32(world.seed ^ 0x2c1b3c6d);
  const analysis = world.map.enabled ? world.map.analysis : null;
  const result = analysis
    ? generateFromMap(world, sampler, waterLevel, size, rng)
    : world.city.layout === 'grid'
      ? generateGrid(world, sampler, waterLevel, size, rng)
      : generateRadial(world, sampler, waterLevel, size, rng);
  // Rebuild the raw street polylines into a seamless network: ribbons are
  // split and trimmed at every meeting point, junction polygons fill the
  // gaps exactly. `roads` keeps the untrimmed segments so terrain grading
  // and clearance still cover the full corridors, junctions included.
  const net = buildJunctionNetwork(result.polylines);
  result.polylines = net.ribbons;
  result.junctions = net.junctions;
  // Lots from independent rings/frontages must also clear every crossing street.
  result.buildings = result.buildings.filter(
    (building) => !result.roads.some((road) => roadIntersectsLot(building, road)),
  );
  return result;
}

export function roadIntersectsLot(building: BuildingInstance, road: RoadSegment): boolean {
  const c = Math.cos(building.rotation),
    s = Math.sin(building.rotation);
  const local = (x: number, z: number): [number, number] => [
    c * (x - building.x) - s * (z - building.z),
    s * (x - building.x) + c * (z - building.z),
  ];
  const a = local(road.ax, road.az),
    b = local(road.bx, road.bz);
  const half = [building.w / 2 + road.width / 2 + 0.8, building.d / 2 + road.width / 2 + 0.8];
  let enter = 0,
    exit = 1;
  for (let axis = 0; axis < 2; axis++) {
    const d = b[axis] - a[axis];
    if (Math.abs(d) < 1e-8) {
      if (Math.abs(a[axis]) > half[axis]) return false;
      continue;
    }
    const t0 = (-half[axis] - a[axis]) / d,
      t1 = (half[axis] - a[axis]) / d;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
    if (enter > exit) return false;
  }
  return true;
}

function makeBuilding(
  world: WorldState,
  rng: Rng,
  x: number,
  z: number,
  y: number,
  rotation: number,
  centrality: number, // 1 at city center, 0 at edge
  lotLimit: number,
): BuildingInstance {
  const style = BUILDING_STYLES[world.city.style];
  const w = clamp(
    style.minFootprint + rng() * (style.maxFootprint - style.minFootprint),
    3,
    lotLimit,
  );
  const d = clamp(
    style.minFootprint + rng() * (style.maxFootprint - style.minFootprint),
    3,
    lotLimit,
  );
  const downtownBoost = style.roofType === 'flat' ? 1 + centrality * centrality * 2.2 : 1;
  const floors = Math.max(
    1,
    Math.round(Math.pow(rng(), 1.5) * world.city.maxFloors * style.heightBias * downtownBoost),
  );
  return {
    x,
    z,
    w,
    d,
    h: floors * style.floorHeight,
    rotation,
    y,
    colorIndex: Math.floor(rng() * style.walls.length),
    hasRoof: style.roofType !== 'flat',
  };
}

function suitable(sampler: Sampler, waterLevel: number, x: number, z: number): number | null {
  const y = sampler(x, z);
  if (y < waterLevel + 0.6) return null;
  const s = 3;
  const dy =
    Math.max(
      Math.abs(sampler(x + s, z) - y),
      Math.abs(sampler(x - s, z) - y),
      Math.abs(sampler(x, z + s) - y),
      Math.abs(sampler(x, z - s) - y),
    ) / s;
  if (dy > 1.1) return null;
  return y;
}

/* ------------------------------------------------------------------ */
/* Grid layout                                                         */
/* ------------------------------------------------------------------ */

function generateGrid(
  world: WorldState,
  sampler: Sampler,
  waterLevel: number,
  size: number,
  rng: Rng,
): CityGenResult {
  const polylines: RoadPolyline[] = [];
  const buildings: BuildingInstance[] = [];
  const R = (world.city.extent * size) / 2;
  const roadW = BASE_ROAD_WIDTH * world.roads.widthScale;
  const spacing = lerp(44, 30, world.city.density);

  const lines: number[] = [];
  for (let p = -R; p <= R + 0.01; p += spacing) lines.push(p);

  for (const p of lines) {
    polylines.push({
      pts: [
        [p, -R],
        [p, R],
      ],
      width: roadW,
    });
    polylines.push({
      pts: [
        [-R, p],
        [R, p],
      ],
      width: roadW,
    });
  }

  const margin = roadW / 2 + 2.5;
  const styleDef = BUILDING_STYLES[world.city.style];
  const lotPitch = styleDef.minFootprint + 4;

  for (let bi = 0; bi < lines.length - 1; bi++) {
    for (let bj = 0; bj < lines.length - 1; bj++) {
      const x0 = lines[bi] + margin;
      const z0 = lines[bj] + margin;
      const inner = spacing - margin * 2;
      const nLots = Math.max(1, Math.round(inner / lotPitch));
      const pitch = inner / nLots;
      for (let li = 0; li < nLots; li++) {
        for (let lj = 0; lj < nLots; lj++) {
          const cx = x0 + pitch * (li + 0.5) + (rng() - 0.5) * 1.5;
          const cz = z0 + pitch * (lj + 0.5) + (rng() - 0.5) * 1.5;
          const r = Math.hypot(cx, cz) / R;
          if (r > 1) continue;
          const p = world.city.density * 1.3 * (1.05 - r * r * 0.55);
          if (rng() > p) continue;
          const y = suitable(sampler, waterLevel, cx, cz);
          if (y === null) continue;
          buildings.push(makeBuilding(world, rng, cx, cz, y, 0, 1 - r, pitch - 2));
        }
      }
    }
  }
  return { roads: polylinesToSegments(polylines), polylines, junctions: [], buildings };
}

/* ------------------------------------------------------------------ */
/* Radial / organic layout                                             */
/* ------------------------------------------------------------------ */

function generateRadial(
  world: WorldState,
  sampler: Sampler,
  waterLevel: number,
  size: number,
  rng: Rng,
): CityGenResult {
  const polylines: RoadPolyline[] = [];
  const buildings: BuildingInstance[] = [];
  const organic = world.city.layout === 'organic';
  const R = (world.city.extent * size) / 2;
  const roadW = BASE_ROAD_WIDTH * world.roads.widthScale;
  const ringSpacing = lerp(40, 26, world.city.density);
  const styleDef = BUILDING_STYLES[world.city.style];

  // Spokes
  const spokes = organic ? 5 + Math.floor(rng() * 3) : 8 + Math.floor(rng() * 4);
  const spokeOffset = rng() * Math.PI;
  for (let sIdx = 0; sIdx < spokes; sIdx++) {
    const a = spokeOffset + (sIdx / spokes) * Math.PI * 2 + (organic ? (rng() - 0.5) * 0.4 : 0);
    polylines.push({
      pts: [
        [Math.cos(a) * ringSpacing * 0.35, Math.sin(a) * ringSpacing * 0.35],
        [Math.cos(a) * R, Math.sin(a) * R],
      ],
      width: roadW,
    });
  }

  // Rings (whole loops as one polyline) with lots on both sides
  for (let r = ringSpacing * 0.8; r <= R; r += ringSpacing) {
    const segs = Math.max(12, Math.round((Math.PI * 2 * r) / 16));
    const wobble = organic ? 0.08 : 0.015;
    const phase = rng() * Math.PI * 2;
    const ringPts: [number, number][] = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const rr = r * (1 + Math.sin(a * 3 + phase) * wobble);
      const px = Math.cos(a) * rr;
      const pz = Math.sin(a) * rr;
      ringPts.push([px, pz]);

      // Lots flanking the ring
      if (i < segs && i % 2 === 0) {
        const centrality = 1 - r / R;
        for (const side of [-1, 1]) {
          if (rng() > world.city.density * (1.1 - (r / R) * 0.5)) continue;
          const off = side * (roadW / 2 + 2 + styleDef.maxFootprint * 0.55);
          const bx = Math.cos(a) * (rr + off) + (organic ? (rng() - 0.5) * 4 : 0);
          const bz = Math.sin(a) * (rr + off) + (organic ? (rng() - 0.5) * 4 : 0);
          const y = suitable(sampler, waterLevel, bx, bz);
          if (y === null) continue;
          const rot = a + Math.PI / 2 + (organic ? (rng() - 0.5) * 0.5 : 0);
          buildings.push(
            makeBuilding(world, rng, bx, bz, y, rot, centrality, styleDef.maxFootprint + 2),
          );
        }
      }
    }
    polylines.push({ pts: ringPts, width: roadW });
  }

  // A keep at the heart of medieval towns.
  if (world.city.style === 'medieval') {
    const y = suitable(sampler, waterLevel, 0, 0);
    if (y !== null) {
      buildings.push({
        x: 0,
        z: 0,
        w: 17,
        d: 17,
        h: 26,
        rotation: spokeOffset,
        y,
        colorIndex: 2,
        hasRoof: true,
      });
      for (let t = 0; t < 4; t++) {
        const a = spokeOffset + (t / 4) * Math.PI * 2 + Math.PI / 4;
        buildings.push({
          x: Math.cos(a) * 14,
          z: Math.sin(a) * 14,
          w: 6,
          d: 6,
          h: 32,
          rotation: spokeOffset,
          y,
          colorIndex: 4,
          hasRoof: true,
        });
      }
    }
  }

  return { roads: polylinesToSegments(polylines), polylines, junctions: [], buildings };
}

/* ------------------------------------------------------------------ */
/* Map-guided layout                                                   */
/* ------------------------------------------------------------------ */

function generateFromMap(
  world: WorldState,
  sampler: Sampler,
  waterLevel: number,
  size: number,
  rng: Rng,
): CityGenResult {
  const analysis = world.map.analysis!;
  const buildings: BuildingInstance[] = [];
  const { width: mw, height: mh, cells } = analysis;
  const cellW = size / mw;
  const cellH = size / mh;
  const half = size / 2;
  const roadW = BASE_ROAD_WIDTH * world.roads.widthScale;
  const styleDef = BUILDING_STYLES[world.city.style];

  const at = (x: number, z: number) =>
    x < 0 || z < 0 || x >= mw || z >= mh ? 0 : cells[z * mw + x];
  const toWorldX = (x: number) => -half + (x + 0.5) * cellW;
  const toWorldZ = (z: number) => -half + (z + 0.5) * cellH;
  const toWorld = ([x, z]: [number, number]): [number, number] => [toWorldX(x), toWorldZ(z)];

  // Preserve source connection vertices. Round interior bends only after junction splitting.
  const polylines: RoadPolyline[] = analysis.roadPaths?.length
    ? analysis.roadPaths.map((path) => ({
        pts: path.pts.map(([x, z]): [number, number] => [-half + x * cellW, -half + z * cellH]),
        width: roadW * path.w,
      }))
    : vectorizeRoads(cells, mw, mh).map((line) => ({ pts: line.map(toWorld), width: roadW }));
  const roads = polylinesToSegments(polylines);

  // Buildings: aggregate 2×2 analysis cells into lots so built areas read as
  // city blocks rather than one tower per classified pixel.
  let builtCells = 0;
  for (const c of cells) if (c === 4) builtCells++;
  const globalDensity = builtCells / cells.length;

  // Fraction of building cells in an 11×11 neighborhood around (x, z).
  const localDensity = (x: number, z: number): number => {
    let n = 0;
    let total = 0;
    for (let dz = -5; dz <= 5; dz++)
      for (let dx = -5; dx <= 5; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= mw || cz >= mh) continue;
        total++;
        if (cells[cz * mw + cx] === 4) n++;
      }
    return total > 0 ? n / total : 0;
  };

  // Local density at a world position (for lots that don't sit on the grid).
  const densityAtWorld = (x: number, z: number): number =>
    localDensity(
      clamp(Math.floor((x + half) / cellW), 0, mw - 1),
      clamp(Math.floor((z + half) / cellH), 0, mh - 1),
    );

  interface Lot {
    x: number;
    z: number;
    rotation: number;
    centrality: number;
    weight: number;
    limit: number;
  }
  const lots: Lot[] = [];

  // Street-front rows first: real cities build along their roads. Lots march
  // down each polyline at a regular pitch, sit at a fixed setback on both
  // sides, and share the street's orientation — that's what makes blocks
  // read as rows instead of scattered boxes.
  const pitch = styleDef.maxFootprint * 1.45;
  const frontage = (d01: number) => ({
    centrality: clamp((d01 - globalDensity) * 2 + 0.25, 0, 0.9),
    weight: 0.55 + 0.9 * d01,
  });
  for (const poly of polylines) {
    const setback = poly.width / 2 + 2 + styleDef.maxFootprint * 0.55;
    let acc = pitch * (0.4 + rng() * 0.4);
    for (let i = 1; i < poly.pts.length; i++) {
      const [ax, az] = poly.pts[i - 1];
      const [bx, bz] = poly.pts[i];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      while (acc <= len) {
        const px = ax + tx * acc;
        const pz = az + tz * acc;
        for (const side of [-1, 1]) {
          const cx = px - tz * setback * side;
          const cz = pz + tx * setback * side;
          const d01 = densityAtWorld(cx, cz);
          // Rows appear only where the source map is actually built-up.
          if (d01 < globalDensity * 0.35) continue;
          lots.push({
            x: cx,
            z: cz,
            rotation: Math.atan2(tz, tx),
            limit: pitch - 2.5,
            ...frontage(d01),
          });
        }
        acc += pitch;
      }
      acc -= len;
    }
  }

  // Interior lots fill the courtyards behind the rows, downweighted so the
  // street wall stays the dominant form.
  const lotLimit = Math.min(cellW, cellH) * 1.7;
  for (let bz = 0; bz + 1 < mh; bz += 2) {
    for (let bx = 0; bx + 1 < mw; bx += 2) {
      let filled = 0;
      if (at(bx, bz) === 4) filled++;
      if (at(bx + 1, bz) === 4) filled++;
      if (at(bx, bz + 1) === 4) filled++;
      if (at(bx + 1, bz + 1) === 4) filled++;
      if (filled < 2) continue;
      const d01 = localDensity(bx, bz);
      // A stray classified speck in otherwise open ground is noise, not a
      // building — real lots sit inside genuinely built-up fabric.
      if (d01 < globalDensity * 0.3) continue;
      // Height follows how much denser this block is than the map average,
      // so uniform urban fabric stays mid-rise and only real cores get towers.
      const centrality = clamp((d01 - globalDensity) * 2 + 0.25, 0, 0.9);
      lots.push({
        x: toWorldX(bx + 0.5),
        z: toWorldZ(bz + 0.5),
        rotation: 0,
        centrality,
        weight: (0.25 + 0.75 * d01) * 0.35,
        limit: lotLimit,
      });
    }
  }

  // Streets must stay open: the largest footprint a building at (x, z) can
  // have without touching the pavement of any traced road.
  const clearance = roadW / 2 + 1.4; // half road width + sidewalk margin
  const roomFor = (x: number, z: number): number => {
    let nearest = Infinity;
    for (const r of roads) {
      const dx = r.bx - r.ax;
      const dz = r.bz - r.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - r.ax) * dx + (z - r.az) * dz) / l2, 0, 1);
      const d = Math.hypot(x - (r.ax + dx * t), z - (r.az + dz * t));
      if (d < nearest) nearest = d;
    }
    return (nearest - clearance) * 1.5;
  };

  // The density slider sets an overall building budget, never one per pixel.
  const budget = Math.round(lerp(200, 900, clamp(world.city.density, 0, 1)));
  let totalWeight = 0;
  for (const lot of lots) totalWeight += lot.weight;
  // Spatial hash with neighbor lookup: frontage rows and interior fill must
  // never stack two buildings on the same spot, including across hash-cell
  // boundaries.
  const placed = new Map<string, [number, number][]>();
  const spacing = Math.max(4, styleDef.maxFootprint * 1.05);
  const minSep = spacing * 0.6;
  const hashKey = (gx: number, gz: number) => `${gx},${gz}`;
  const isFree = (x: number, z: number): boolean => {
    const gx = Math.round(x / spacing);
    const gz = Math.round(z / spacing);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = placed.get(hashKey(gx + dx, gz + dz));
        if (!bucket) continue;
        for (const [px, pz] of bucket) if (Math.hypot(px - x, pz - z) < minSep) return false;
      }
    return true;
  };
  const occupy = (x: number, z: number): void => {
    const key = hashKey(Math.round(x / spacing), Math.round(z / spacing));
    const bucket = placed.get(key);
    if (bucket) bucket.push([x, z]);
    else placed.set(key, [[x, z]]);
  };
  for (const lot of lots) {
    // Denser map areas keep more of their lots, so the built structure
    // follows the source image instead of uniform sprinkling.
    if (rng() > (lot.weight * budget) / Math.max(1e-6, totalWeight)) continue;
    // Row lots stay crisp; interior lots keep the organic jitter.
    const jitter = lot.rotation === 0 && lot.limit === lotLimit ? cellW * 0.5 : 1.2;
    const cx = lot.x + (rng() - 0.5) * jitter;
    const cz = lot.z + (rng() - 0.5) * jitter;
    if (!isFree(cx, cz)) continue;
    const room = roomFor(cx, cz);
    if (room < 3.5) continue; // a road runs through this lot — leave it open
    const y = suitable(sampler, waterLevel, cx, cz);
    if (y === null) continue;
    occupy(cx, cz);
    buildings.push(
      makeBuilding(world, rng, cx, cz, y, lot.rotation, lot.centrality, Math.min(lot.limit, room)),
    );
  }

  // Fall back to a small procedural district when the map has no built areas.
  if (buildings.length === 0 && roads.length === 0) {
    return generateGrid(world, sampler, waterLevel, size, rng);
  }
  return { roads, polylines, junctions: [], buildings };
}
