import type { RoadJunction, RoadPolyline } from '@/types/world';

type Point = [number, number];
const EPS = 0.01;
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mix = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
const cross = (a: Point, b: Point, c: Point) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** A convex mouth boundary cannot fold into the star-shaped fans of the old renderer. */
export function junctionHull(points: Point[]): Point[] {
  const sorted = [...points]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, all) => i === 0 || distance(p, all[i - 1]) > EPS);
  const chain = (pts: Point[]) => {
    const out: Point[] = [];
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  // Clockwise in XZ gives upward-facing triangles.
  return chain(sorted)
    .concat(chain([...sorted].reverse()))
    .reverse();
}

/** Round only interior bends, after junctions have been split and anchored. */
export function roundRoadBends(pts: Point[], radius: number): Point[] {
  if (pts.length < 3) return pts.map((p) => [...p]);
  const out: Point[] = [[...pts[0]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1],
      b = pts[i],
      c = pts[i + 1];
    const ab = distance(a, b),
      bc = distance(b, c);
    if (ab < EPS || bc < EPS) continue;
    const inset = Math.min(radius, ab * 0.25, bc * 0.25);
    const enter = mix(b, a, inset / ab),
      exit = mix(b, c, inset / bc);
    out.push(enter);
    for (let step = 1; step <= 4; step++) {
      const t = step / 4;
      out.push(mix(mix(enter, b, t), mix(b, exit, t), t));
    }
  }
  out.push([...pts[pts.length - 1]]);
  return out.filter((p, i) => i === 0 || distance(p, out[i - 1]) > EPS);
}

/** Build a planar street graph before smoothing; every junction uses one exact anchor. */
export function buildJunctionNetwork(raw: RoadPolyline[]): {
  ribbons: RoadPolyline[];
  junctions: RoadJunction[];
} {
  const lines = raw
    .map((road) => ({
      ...road,
      pts: road.pts
        .filter((p) => p.every(Number.isFinite))
        .filter((p, i, pts) => i === 0 || distance(p, pts[i - 1]) > EPS)
        .map((p): Point => [...p]),
    }))
    .filter((road) => road.pts.length > 1 && road.width > 0 && Number.isFinite(road.width));
  const nodes: Point[] = [];
  const parents: number[] = [];
  const canonical = (node: number): number => {
    if (parents[node] !== node) parents[node] = canonical(parents[node]);
    return parents[node];
  };
  const nodeAt = (p: Point) => {
    const found = nodes.findIndex((n) => distance(n, p) < EPS);
    if (found >= 0) return found;
    nodes.push([...p]);
    parents.push(nodes.length - 1);
    return nodes.length - 1;
  };
  type Cut = { at: number; node: number };
  type Segment = { line: number; index: number; a: Point; b: Point; at: number; length: number };
  const segments: Segment[] = [];
  const lengths = lines.map((line, li) => {
    const cumulative = [0];
    for (let i = 1; i < line.pts.length; i++) {
      const length = distance(line.pts[i - 1], line.pts[i]);
      segments.push({
        line: li,
        index: i,
        a: line.pts[i - 1],
        b: line.pts[i],
        at: cumulative[i - 1],
        length,
      });
      cumulative.push(cumulative[i - 1] + length);
    }
    return cumulative;
  });
  const cuts: Cut[][] = lines.map((line, i) => [
    { at: 0, node: nodeAt(line.pts[0]) },
    { at: lengths[i].at(-1)!, node: nodeAt(line.pts.at(-1)!) },
  ]);

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j];
      if (s.line === t.line && Math.abs(s.index - t.index) <= 1) continue;
      if (
        Math.min(s.a[0], s.b[0]) > Math.max(t.a[0], t.b[0]) + EPS ||
        Math.min(t.a[0], t.b[0]) > Math.max(s.a[0], s.b[0]) + EPS ||
        Math.min(s.a[1], s.b[1]) > Math.max(t.a[1], t.b[1]) + EPS ||
        Math.min(t.a[1], t.b[1]) > Math.max(s.a[1], s.b[1]) + EPS
      )
        continue;
      const dx = s.b[0] - s.a[0],
        dz = s.b[1] - s.a[1];
      const ex = t.b[0] - t.a[0],
        ez = t.b[1] - t.a[1];
      const determinant = dx * ez - dz * ex;
      if (Math.abs(determinant) < 1e-8) continue;
      const u = ((t.a[0] - s.a[0]) * ez - (t.a[1] - s.a[1]) * ex) / determinant;
      const v = ((t.a[0] - s.a[0]) * dz - (t.a[1] - s.a[1]) * dx) / determinant;
      if (u < -1e-8 || u > 1 + 1e-8 || v < -1e-8 || v > 1 + 1e-8) continue;
      const node = nodeAt(mix(s.a, s.b, u));
      cuts[s.line].push({ at: s.at + u * s.length, node });
      cuts[t.line].push({ at: t.at + v * t.length, node });
    }
  }

  // Heal only numerical/classification near-misses, never merge a whole road-width area.
  for (let li = 0; li < lines.length; li++) {
    for (const head of [true, false]) {
      const p = head ? lines[li].pts[0] : lines[li].pts.at(-1)!;
      let nearest = Math.min(0.6, lines[li].width * 0.12);
      let hit: { segment: Segment; t: number; p: Point } | null = null;
      for (const segment of segments) {
        if (segment.line === li) continue;
        const dx = segment.b[0] - segment.a[0],
          dz = segment.b[1] - segment.a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p[0] - segment.a[0]) * dx + (p[1] - segment.a[1]) * dz) / segment.length ** 2,
          ),
        );
        const projection = mix(segment.a, segment.b, t);
        const d = distance(p, projection);
        if (d <= nearest) {
          nearest = d;
          hit = { segment, t, p: projection };
        }
      }
      if (!hit) continue;
      const node = nodeAt(hit.p);
      parents[canonical(cuts[li][head ? 0 : 1].node)] = canonical(node);
      cuts[li][head ? 0 : 1].node = node;
      cuts[hit.segment.line].push({ at: hit.segment.at + hit.t * hit.segment.length, node });
    }
  }

  const ribbons: RoadPolyline[] = [];
  const ends: [number, number][] = [];
  const seen = new Set<string>();
  for (let li = 0; li < lines.length; li++) {
    const sorted = cuts[li]
      .map((cut) => ({ ...cut, node: canonical(cut.node) }))
      .sort((a, b) => a.at - b.at)
      .filter((cut, i, all) => i === 0 || cut.at - all[i - 1].at > EPS);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1],
        b = sorted[i];
      if (b.at - a.at <= EPS) continue;
      const pts: Point[] = [[...nodes[a.node]]];
      for (let k = 1; k < lines[li].pts.length - 1; k++) {
        if (lengths[li][k] > a.at + EPS && lengths[li][k] < b.at - EPS)
          pts.push([...lines[li].pts[k]]);
      }
      pts.push([...nodes[b.node]]);
      const clean = pts.filter((p, j) => j === 0 || distance(p, pts[j - 1]) > EPS);
      if (clean.length < 2) continue;
      const signature = (p: Point[]) =>
        p.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`).join(';');
      const key = [signature(clean), signature([...clean].reverse())].sort()[0];
      if (seen.has(key)) continue;
      seen.add(key);
      ribbons.push({ width: lines[li].width, pts: clean });
      ends.push([a.node, b.node]);
    }
  }

  const incident: { ribbon: number; head: boolean }[][] = nodes.map(() => []);
  ends.forEach(([a, b], ribbon) => {
    incident[a].push({ ribbon, head: true });
    incident[b].push({ ribbon, head: false });
  });
  const trim = (pts: Point[], amount: number): Point[] => {
    let remaining = amount;
    for (let i = 1; i < pts.length; i++) {
      const d = distance(pts[i - 1], pts[i]);
      if (d > remaining) return [mix(pts[i - 1], pts[i], remaining / d), ...pts.slice(i)];
      remaining -= d;
    }
    return pts;
  };
  const junctions: RoadJunction[] = [];
  incident.forEach((arms) => {
    if (arms.length < 2) return;
    const widest = Math.max(...arms.map((a) => ribbons[a.ribbon].width));
    const corners: Point[] = [];
    for (const arm of arms) {
      const road = ribbons[arm.ribbon];
      const path = arm.head ? road.pts : [...road.pts].reverse();
      let length = 0;
      for (let i = 1; i < path.length; i++) length += distance(path[i - 1], path[i]);
      const clipped = trim(path, Math.min(widest * 0.65, length * 0.3));
      road.pts = arm.head ? clipped : [...clipped].reverse();
      const d = distance(clipped[0], clipped[1]);
      const dx = (clipped[1][0] - clipped[0][0]) / d,
        dz = (clipped[1][1] - clipped[0][1]) / d;
      // Tiny overlap hides raster precision cracks without extending the pavement into spikes.
      const x = clipped[0][0] + dx * 0.025,
        z = clipped[0][1] + dz * 0.025;
      corners.push(
        [x - (dz * road.width) / 2, z + (dx * road.width) / 2],
        [x + (dz * road.width) / 2, z - (dx * road.width) / 2],
      );
    }
    const ring = junctionHull(corners);
    if (ring.length >= 3)
      junctions.push({
        x: ring.reduce((s, p) => s + p[0], 0) / ring.length,
        z: ring.reduce((s, p) => s + p[1], 0) / ring.length,
        ring,
      });
  });
  return { ribbons, junctions };
}
