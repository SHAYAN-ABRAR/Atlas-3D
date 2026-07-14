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
import { simplifyPath, vectorizeRoads } from './roads';

export interface CityGenResult {
  roads: RoadSegment[];
  polylines: RoadPolyline[];
  junctions: RoadJunction[];
  buildings: BuildingInstance[];
}

type Sampler = (x: number, z: number) => number;

const BASE_ROAD_WIDTH = 3.4;

/**
 * Chaikin corner-cutting: each pass replaces every interior corner with two
 * points at ¼ and ¾ of its adjoining segments, converging on a smooth
 * curve while endpoints stay pinned. Straight runs are unaffected.
 */
function chaikin(pts: [number, number][], rounds: number): [number, number][] {
  let cur = pts;
  for (let r = 0; r < rounds; r++) {
    if (cur.length < 3) return cur;
    const out: [number, number][] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const [ax, az] = cur[i];
      const [bx, bz] = cur[i + 1];
      out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      out.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/**
 * Splits a polyline wherever the direction snaps by more than `maxDeg` —
 * a genuine street corner should be two ribbons meeting crisply, not one
 * ribbon folded into a bowtie miter.
 */
function splitSharp(pts: [number, number][], maxDeg: number): [number, number][][] {
  const limit = (maxDeg * Math.PI) / 180;
  const out: [number, number][][] = [];
  let cur: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i]);
    if (i + 1 >= pts.length) break;
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > limit) {
      out.push(cur);
      cur = [pts[i]];
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

function polylineLength(pts: [number, number][]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++)
    l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/**
 * Drops streets that ride on top of another street for most of their
 * length. OSM maps many avenues as one way per driving direction; at world
 * scale those twins are nearly coincident, which would z-fight and blow up
 * every junction they touch. True dual carriageways (well separated) stay.
 */
function dropCoincident(polylines: RoadPolyline[]): RoadPolyline[] {
  const lens = polylines.map((p) => polylineLength(p.pts));
  const keep = polylines.map(() => true);
  const order = polylines.map((_, i) => i).sort((a, b) => lens[b] - lens[a]);
  const distTo = (q: [number, number], poly: RoadPolyline): number => {
    let best = Infinity;
    for (let i = 1; i < poly.pts.length; i++) {
      const [ax, az] = poly.pts[i - 1];
      const [bx, bz] = poly.pts[i];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = clamp(((q[0] - ax) * dx + (q[1] - az) * dz) / l2, 0, 1);
      best = Math.min(best, Math.hypot(q[0] - (ax + dx * t), q[1] - (az + dz * t)));
    }
    return best;
  };
  for (const i of order) {
    if (!keep[i]) continue;
    for (const j of order) {
      if (j === i || !keep[j] || lens[j] > lens[i]) continue;
      const tol = Math.max(polylines[i].width, polylines[j].width) * 0.75;
      let inside = 0;
      let total = 0;
      const pts = polylines[j].pts;
      for (let k = 1; k < pts.length; k++) {
        const steps = Math.max(1, Math.ceil(Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) / 2));
        for (let st = 0; st < steps; st++) {
          const t = st / steps;
          total++;
          if (
            distTo(
              [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t],
              polylines[i],
            ) < tol
          )
            inside++;
        }
      }
      if (total > 0 && inside / total >= 0.8) keep[j] = false;
    }
  }
  return polylines.filter((_, i) => keep[i]);
}

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
  return result;
}

/**
 * Turns overlapping street centerlines into a real road network, the way a
 * road engine does it: detect every meeting point (crossings, T-junctions,
 * touching ends), split the polylines into edges there, trim each edge back
 * with the miter formula so no two ribbons overlap, and emit a junction
 * polygon whose boundary is exactly the trimmed ribbon ends.
 */
function buildJunctionNetwork(rawPolylines: RoadPolyline[]): {
  ribbons: RoadPolyline[];
  junctions: RoadJunction[];
} {
  const polylines = dropCoincident(rawPolylines);
  interface Seg {
    poly: number;
    seg: number;
    ax: number;
    az: number;
    bx: number;
    bz: number;
    width: number;
  }
  const segs: Seg[] = [];
  for (let p = 0; p < polylines.length; p++) {
    const { pts, width } = polylines[p];
    for (let i = 1; i < pts.length; i++)
      segs.push({
        poly: p,
        seg: i - 1,
        ax: pts[i - 1][0],
        az: pts[i - 1][1],
        bx: pts[i][0],
        bz: pts[i][1],
        width,
      });
  }

  // --- nodes (merged meeting points) --------------------------------
  interface Node {
    x: number;
    z: number;
    r: number;
  }
  const nodes: Node[] = [];
  const addNode = (x: number, z: number, wa: number, wb: number): number => {
    // Merge only genuinely coincident meeting points. A median U-turn
    // connector must keep one T-junction per carriageway, and a
    // dual-carriageway crossing stays four clean X-junctions, not a blob.
    const r = (wa + wb) * 0.45;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (Math.hypot(n.x - x, n.z - z) < Math.max(n.r, r)) {
        n.x = (n.x + x) / 2;
        n.z = (n.z + z) / 2;
        return i;
      }
    }
    nodes.push({ x, z, r });
    return nodes.length - 1;
  };

  const cuts: { seg: number; t: number; node: number }[][] = polylines.map(() => []);
  const endNode: [number, number][] = polylines.map(() => [-1, -1]);

  // Mid-segment crossings (coarse bbox prefilter keeps the pair scan cheap).
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let k = i + 1; k < segs.length; k++) {
      const t = segs[k];
      if (t.poly === s.poly) continue;
      if (
        Math.min(s.ax, s.bx) > Math.max(t.ax, t.bx) + 1 ||
        Math.min(t.ax, t.bx) > Math.max(s.ax, s.bx) + 1 ||
        Math.min(s.az, s.bz) > Math.max(t.az, t.bz) + 1 ||
        Math.min(t.az, t.bz) > Math.max(s.az, s.bz) + 1
      )
        continue;
      const d1x = s.bx - s.ax;
      const d1z = s.bz - s.az;
      const d2x = t.bx - t.ax;
      const d2z = t.bz - t.az;
      const denom = d1x * d2z - d1z * d2x;
      if (Math.abs(denom) < 1e-9) continue;
      const u = ((t.ax - s.ax) * d2z - (t.az - s.az) * d2x) / denom;
      const v = ((t.ax - s.ax) * d1z - (t.az - s.az) * d1x) / denom;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const id = addNode(s.ax + d1x * u, s.az + d1z * u, s.width, t.width);
      cuts[s.poly].push({ seg: s.seg, t: u, node: id });
      cuts[t.poly].push({ seg: t.seg, t: v, node: id });
    }
  }

  // Street ends touching another street (T-junctions, corner splits).
  for (let p = 0; p < polylines.length; p++) {
    const { pts, width } = polylines[p];
    for (const head of [true, false]) {
      const [ex, ez] = head ? pts[0] : pts[pts.length - 1];
      let bestD = Infinity;
      let best: Seg | null = null;
      let bestT = 0;
      for (const s of segs) {
        if (s.poly === p) continue;
        const dx = s.bx - s.ax;
        const dz = s.bz - s.az;
        const l2 = dx * dx + dz * dz || 1;
        const t = clamp(((ex - s.ax) * dx + (ez - s.az) * dz) / l2, 0, 1);
        const d = Math.hypot(ex - (s.ax + dx * t), ez - (s.az + dz * t));
        if (d < bestD) {
          bestD = d;
          best = s;
          bestT = t;
        }
      }
      if (!best || bestD >= (width + best.width) / 2 + 0.6) continue;
      const px = best.ax + (best.bx - best.ax) * bestT;
      const pz = best.az + (best.bz - best.az) * bestT;
      const id = addNode(px, pz, width, best.width);
      endNode[p][head ? 0 : 1] = id;
      cuts[best.poly].push({ seg: best.seg, t: bestT, node: id });
    }
  }

  // --- split polylines into edges at their cut points ----------------
  const ribbons: RoadPolyline[] = [];
  const ribbonSrc: number[] = []; // originating polyline, to spot through-pairs
  const ribbonEnds: [number, number][] = []; // node id at [start, end], -1 = open
  for (let p = 0; p < polylines.length; p++) {
    const { pts, width } = polylines[p];
    const sorted = cuts[p].sort((a, b) => a.seg - b.seg || a.t - b.t);
    // Adjacent segments crossing the same street near a shared vertex
    // produce duplicate cuts — keep only the first per node run.
    const evs = sorted.filter((ev, i) => i === 0 || ev.node !== sorted[i - 1].node);
    let cur: [number, number][] = [pts[0]];
    let startNode = endNode[p][0];
    let e = 0;
    for (let i = 1; i < pts.length; i++) {
      while (e < evs.length && evs[e].seg === i - 1) {
        const ev = evs[e++];
        const cx = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * ev.t;
        const cz = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * ev.t;
        const last = cur[cur.length - 1];
        if (Math.hypot(cx - last[0], cz - last[1]) > 0.05) cur.push([cx, cz]);
        if (cur.length >= 2) {
          ribbons.push({ pts: cur, width });
          ribbonSrc.push(p);
          ribbonEnds.push([startNode, ev.node]);
        }
        cur = [[cx, cz]];
        startNode = ev.node;
      }
      cur.push(pts[i]);
    }
    if (cur.length >= 2) {
      ribbons.push({ pts: cur, width });
      ribbonSrc.push(p);
      ribbonEnds.push([startNode, endNode[p][1]]);
    }
  }

  // --- per node: trim incident ribbons, emit the junction polygon ----
  const incident: { ribbon: number; head: boolean }[][] = nodes.map(() => []);
  ribbonEnds.forEach(([a, b], ri) => {
    if (a >= 0) incident[a].push({ ribbon: ri, head: true });
    if (b >= 0) incident[b].push({ ribbon: ri, head: false });
  });

  /** Cuts `dist` off one end, interpolating the new endpoint. */
  const trimEnd = (pts: [number, number][], head: boolean, dist: number): [number, number][] => {
    const src = head ? pts : [...pts].reverse();
    let remaining = Math.min(dist, polylineLength(src) * 0.45);
    let i = 1;
    while (i < src.length) {
      const step = Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]);
      if (step >= remaining) break;
      remaining -= step;
      i++;
    }
    if (i >= src.length) return head ? pts : [...pts];
    const [ax, az] = src[i - 1];
    const [bx, bz] = src[i];
    const step = Math.hypot(bx - ax, bz - az) || 1;
    const t = remaining / step;
    const out: [number, number][] = [[ax + (bx - ax) * t, az + (bz - az) * t], ...src.slice(i)];
    return head ? out : out.reverse();
  };

  const junctions: RoadJunction[] = [];
  for (let n = 0; n < nodes.length; n++) {
    const inc = incident[n];
    if (inc.length < 2) continue;

    // Direction of each incident ribbon pointing away from the node.
    const info = inc.map(({ ribbon, head }) => {
      const r = ribbons[ribbon];
      const p0 = head ? r.pts[0] : r.pts[r.pts.length - 1];
      const p1 = head ? r.pts[1] : r.pts[r.pts.length - 2];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      return {
        ribbon,
        head,
        src: ribbonSrc[ribbon],
        dx: (p1[0] - p0[0]) / len,
        dz: (p1[1] - p0[1]) / len,
        h: r.width / 2,
      };
    });

    // Miter trim: two ribbons at angle θ stop overlapping at
    // (hᵢ·cosθ + hⱼ)/sinθ from the node — take the worst neighbor.
    // The two halves of the *same street* continuing across the node are
    // a through-pair: they abut instead of overlapping, so they demand no
    // trim — a side-street tee never cuts a hole into the road it joins.
    // Different streets crossing at any angle always trim.
    for (const a of info) {
      let trim = a.h * 0.8; // minimum apron so the polygon has body
      for (const b of info) {
        if (b === a) continue;
        const cos = clamp(a.dx * b.dx + a.dz * b.dz, -1, 1);
        if (a.src === b.src && cos < -0.5) continue; // through pair
        const sin = Math.sqrt(1 - cos * cos);
        const d =
          sin > 0.2
            ? (a.h * cos + b.h) / sin
            : (a.h + b.h) * 1.5; // near-parallel overlap: fixed apron
        trim = Math.max(trim, Math.min(Math.max(d, 0), (a.h + b.h) * 1.8));
      }
      const r = ribbons[a.ribbon];
      r.pts = trimEnd(r.pts, a.head, trim + 0.3);
    }

    // Junction polygon: the trimmed ribbon end corners, tucked slightly
    // into the ribbons so the shared boundary can never show a hairline.
    // The fill fans out from the corner centroid, so the ring must be
    // star-shaped around it: sort every corner by its own azimuth about
    // that center. Grouping corners per end instead (right-then-left) makes
    // the ring self-intersect whenever one end's corners straddle another's.
    // Descending angle = clockwise in the XZ plane = upward-facing fan
    // triangles; ascending would get the whole patch back-face culled.
    const raw: [number, number][] = [];
    let cx = 0;
    let cz = 0;
    for (const a of info) {
      const r = ribbons[a.ribbon];
      const q0 = a.head ? r.pts[0] : r.pts[r.pts.length - 1];
      const q1 = a.head ? r.pts[1] : r.pts[r.pts.length - 2];
      const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
      const dx = (q1[0] - q0[0]) / len;
      const dz = (q1[1] - q0[1]) / len;
      const bx = q0[0] + dx * 0.45;
      const bz = q0[1] + dz * 0.45;
      raw.push([bx + dz * a.h, bz - dx * a.h], [bx - dz * a.h, bz + dx * a.h]);
      cx += q0[0];
      cz += q0[1];
    }
    cx /= info.length;
    cz /= info.length;
    const corners = raw
      .map((pt): { angle: number; pt: [number, number] } => ({
        angle: Math.atan2(pt[1] - cz, pt[0] - cx),
        pt,
      }))
      .sort((a, b) => b.angle - a.angle)
      .map((c) => c.pt);
    junctions.push({ x: cx, z: cz, ring: corners });
  }

  // Even sub-meter stubs stay: dropping them would leave a hole between
  // two adjacent junction polygons.
  return { ribbons: ribbons.filter((r) => polylineLength(r.pts) > 0.05), junctions };
}

/* ------------------------------------------------------------------ */

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
    polylines.push({ pts: [[p, -R], [p, R]], width: roadW });
    polylines.push({ pts: [[-R, p], [R, p]], width: roadW });
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
        x: 0, z: 0, w: 17, d: 17, h: 26, rotation: spokeOffset, y,
        colorIndex: 2, hasRoof: true,
      });
      for (let t = 0; t < 4; t++) {
        const a = spokeOffset + (t / 4) * Math.PI * 2 + Math.PI / 4;
        buildings.push({
          x: Math.cos(a) * 14, z: Math.sin(a) * 14, w: 6, d: 6, h: 32,
          rotation: spokeOffset, y, colorIndex: 4, hasRoof: true,
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

  const at = (x: number, z: number) => (x < 0 || z < 0 || x >= mw || z >= mh ? 0 : cells[z * mw + x]);
  const toWorldX = (x: number) => -half + (x + 0.5) * cellW;
  const toWorldZ = (z: number) => -half + (z + 0.5) * cellH;
  const toWorld = ([x, z]: [number, number]): [number, number] => [toWorldX(x), toWorldZ(z)];

  // Streets as smooth world-space polylines. Chaikin corner-cutting rounds
  // every bend so curves read as curves, not chains of angled sticks.
  const polylines: RoadPolyline[] = [];
  if (analysis.roadPaths?.length) {
    // The analysis carries exact vector centerlines (real OSM geometry) —
    // lay streets directly from them so curves stay smooth and parallel
    // carriageways stay parallel. Light simplification merges the nearly
    // collinear nodes OSM uses along gentle curves.
    for (const path of analysis.roadPaths) {
      const line = simplifyPath(
        path.pts.map(([x, z]): [number, number] => [x - 0.5, z - 0.5]),
        0.12,
      );
      for (const run of splitSharp(chaikin(line.map(toWorld), 2), 55)) {
        polylines.push({ pts: run, width: roadW * path.w });
      }
    }
  } else {
    // Traced from classified cells: skeletonize + trace + simplify, then
    // smooth — raster traces carry staircase corners the smoothing rounds.
    for (const line of vectorizeRoads(cells, mw, mh)) {
      for (const run of splitSharp(chaikin(line.map(toWorld), 2), 55)) {
        polylines.push({ pts: run, width: roadW });
      }
    }
  }
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
