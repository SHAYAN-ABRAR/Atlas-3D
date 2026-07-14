/**
 * Vectorizes the road cells of a map analysis into simplified polylines.
 *
 * The classifier emits a bitmap; naively turning horizontal/vertical runs
 * into segments shreds diagonal and curved streets into staircase stubs.
 * Instead: thin the mask to a 1-cell skeleton (Zhang–Suen), trace it into
 * paths with directional momentum, then simplify each path (Douglas–Peucker)
 * so a straight street becomes one long segment at any angle.
 */

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

export type CellPoint = [number, number];

export function vectorizeRoads(cells: number[], width: number, height: number): CellPoint[][] {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < cells.length; i++) if (cells[i] === 3) mask[i] = 1;
  dilate(mask, width, height); // close 1–2 cell classification breaks
  const preThin = mask.slice();
  thin(mask, width, height);

  const out: CellPoint[][] = [];
  for (const path of trace(mask, width, height)) {
    if (path.length < 3) continue;
    const line = simplify(path, 0.8);
    let length = 0;
    for (let i = 1; i < line.length; i++)
      length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (length >= 3) out.push(line);
  }
  extendTips(out, preThin, width, height);
  stitchGaps(out, 6);
  return out;
}

/**
 * Thinning erodes the open end of a line by up to half its width, making
 * streets stop short of where the map shows them. Push every tip back out
 * along its own direction while the pre-thinning mask still has road there.
 */
function extendTips(lines: CellPoint[][], mask: Uint8Array, width: number, height: number): void {
  for (const line of lines) {
    if (line.length < 2) continue;
    for (const head of [true, false]) {
      const p = head ? line[0] : line[line.length - 1];
      const q = head ? line[1] : line[line.length - 2];
      const len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      const dx = (p[0] - q[0]) / len;
      const dz = (p[1] - q[1]) / len;
      let tip: CellPoint | null = null;
      for (let k = 1; k <= 3; k++) {
        const x = Math.round(p[0] + dx * k);
        const z = Math.round(p[1] + dz * k);
        if (x < 0 || z < 0 || x >= width || z >= height || !mask[z * width + x]) break;
        tip = [p[0] + dx * k, p[1] + dz * k];
      }
      if (tip) {
        if (head) line.unshift(tip);
        else line.push(tip);
      }
    }
  }
}

/** Grows the mask by one cell so hairline breaks fuse before thinning. */
function dilate(mask: Uint8Array, width: number, height: number): void {
  const src = mask.slice();
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      if (src[i]) continue;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < width && nz < height && src[nz * width + nx]) {
          mask[i] = 1;
          break;
        }
      }
    }
}

/**
 * Heals the breaks the classifier leaves where trees, shadows or flyovers
 * cross a street: a dangling road end reaches out to a nearby road point
 * that roughly continues its direction, so streets stay connected and
 * building clearance sees the full corridor.
 */
function stitchGaps(lines: CellPoint[][], maxGap: number): void {
  interface End {
    li: number;
    head: boolean;
    x: number;
    z: number;
    dx: number;
    dz: number;
  }
  const ends: End[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < 2) continue;
    for (const head of [true, false]) {
      const p = head ? line[0] : line[line.length - 1];
      const q = head ? line[1] : line[line.length - 2];
      const len = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      ends.push({ li, head, x: p[0], z: p[1], dx: (p[0] - q[0]) / len, dz: (p[1] - q[1]) / len });
    }
  }

  const attach = (end: End, pt: CellPoint) => {
    if (end.head) lines[end.li].unshift(pt);
    else lines[end.li].push(pt);
  };

  const used = new Set<number>();
  for (let a = 0; a < ends.length; a++) {
    if (used.has(a)) continue;
    const A = ends[a];

    // Best mutually facing dangling end of another path.
    let best = -1;
    let bestScore = 0.3;
    for (let b = 0; b < ends.length; b++) {
      if (b === a || used.has(b) || ends[b].li === A.li) continue;
      const B = ends[b];
      const gx = B.x - A.x;
      const gz = B.z - A.z;
      const d = Math.hypot(gx, gz);
      if (d < 0.5 || d > maxGap) continue;
      const align = Math.min(
        (A.dx * gx + A.dz * gz) / d,
        (-B.dx * gx - B.dz * gz) / d,
      );
      const score = align * (1 - d / (maxGap * 2));
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best >= 0) {
      attach(A, [ends[best].x, ends[best].z]);
      used.add(a);
      used.add(best);
      continue;
    }

    // Fallback: reach the nearest aligned point on a crossing road (T gaps).
    let bestPt: CellPoint | null = null;
    let bestD = maxGap;
    for (let li = 0; li < lines.length; li++) {
      if (li === A.li) continue;
      const line = lines[li];
      for (let i = 1; i < line.length; i++) {
        const [ax, az] = line[i - 1];
        const [bx, bz] = line[i];
        const sx = bx - ax;
        const sz = bz - az;
        const l2 = sx * sx + sz * sz || 1;
        let t = ((A.x - ax) * sx + (A.z - az) * sz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const gx = ax + sx * t - A.x;
        const gz = az + sz * t - A.z;
        const d = Math.hypot(gx, gz);
        if (d < 0.5 || d >= bestD) continue;
        if ((A.dx * gx + A.dz * gz) / d < 0.5) continue;
        bestD = d;
        bestPt = [ax + sx * t, az + sz * t];
      }
    }
    if (bestPt) {
      attach(A, bestPt);
      used.add(a);
    }
  }
}

/** Zhang–Suen morphological thinning down to a 1-cell-wide skeleton. */
function thin(mask: Uint8Array, width: number, height: number): void {
  const idx = (x: number, z: number) => z * width + x;
  let changed = true;
  while (changed) {
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const toClear: number[] = [];
      for (let z = 1; z < height - 1; z++) {
        for (let x = 1; x < width - 1; x++) {
          const i = idx(x, z);
          if (!mask[i]) continue;
          // p2..p9 clockwise starting north
          const p = [
            mask[idx(x, z - 1)], mask[idx(x + 1, z - 1)], mask[idx(x + 1, z)],
            mask[idx(x + 1, z + 1)], mask[idx(x, z + 1)], mask[idx(x - 1, z + 1)],
            mask[idx(x - 1, z)], mask[idx(x - 1, z - 1)],
          ];
          let bn = 0;
          for (let k = 0; k < 8; k++) bn += p[k];
          if (bn < 2 || bn > 6) continue;
          let transitions = 0;
          for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) transitions++;
          if (transitions !== 1) continue;
          if (phase === 0) {
            if (p[0] * p[2] * p[4] !== 0 || p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0 || p[0] * p[4] * p[6] !== 0) continue;
          }
          toClear.push(i);
        }
      }
      if (toClear.length) changed = true;
      for (const i of toClear) mask[i] = 0;
    }
  }
}

/**
 * Traces the skeleton into paths. Endpoints and junctions are used as
 * starting points first so streets are followed end-to-end; the walk keeps
 * directional momentum so it doesn't wander at staircase pixels. Paths that
 * begin or end beside an already-traced cell attach to it, keeping junctions
 * connected.
 */
function trace(mask: Uint8Array, width: number, height: number): CellPoint[][] {
  const visited = new Uint8Array(mask.length);
  const deg = new Uint8Array(mask.length);
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      if (!mask[i]) continue;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < width && nz < height && mask[nz * width + nx]) deg[i]++;
      }
    }

  const paths: CellPoint[][] = [];

  const grow = (sx: number, sz: number): void => {
    // Anchor the start to a previously traced neighbor (junction continuity).
    let startAnchor: CellPoint | null = null;
    for (const [dx, dz] of DIRS) {
      const nx = sx + dx;
      const nz = sz + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      if (visited[nz * width + nx]) {
        startAnchor = [nx, nz];
        break;
      }
    }

    const path: CellPoint[] = [[sx, sz]];
    const own = new Set<number>([sz * width + sx]);
    visited[sz * width + sx] = 1;
    let cx = sx;
    let cz = sz;
    let hx = 0;
    let hz = 0;
    for (;;) {
      let best = -1;
      let bestScore = -Infinity;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0];
        const nz = cz + DIRS[d][1];
        if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
        const ni = nz * width + nx;
        if (!mask[ni] || visited[ni]) continue;
        // Prefer the current heading; diagonals cost a hair as a tiebreak.
        const score = hx * DIRS[d][0] + hz * DIRS[d][1] - (d % 2) * 0.25;
        if (score > bestScore) {
          bestScore = score;
          best = d;
        }
      }
      if (best < 0) break;
      hx = DIRS[best][0];
      hz = DIRS[best][1];
      cx += hx;
      cz += hz;
      const ci = cz * width + cx;
      visited[ci] = 1;
      own.add(ci);
      path.push([cx, cz]);
    }

    // Anchor the end to a traced cell outside this path (T-junctions, loops).
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      const ni = nz * width + nx;
      if (visited[ni] && !own.has(ni)) {
        path.push([nx, nz]);
        break;
      }
    }
    if (startAnchor) path.unshift(startAnchor);
    if (path.length > 1) paths.push(path);
  };

  // Endpoints first, then junctions, then whatever remains (pure cycles).
  for (const wanted of [1, 3, 0] as const) {
    for (let z = 0; z < height; z++)
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        if (!mask[i] || visited[i]) continue;
        if (wanted === 1 && deg[i] !== 1) continue;
        if (wanted === 3 && deg[i] < 3) continue;
        grow(x, z);
      }
  }
  return paths;
}

/** Light Douglas–Peucker for externally supplied vector paths. */
export function simplifyPath(path: CellPoint[], epsilon: number): CellPoint[] {
  return simplify(path, epsilon);
}

/** Douglas–Peucker; closed loops are split in half so they don't collapse. */
function simplify(path: CellPoint[], epsilon: number): CellPoint[] {
  const first = path[0];
  const last = path[path.length - 1];
  if (path.length > 4 && Math.hypot(last[0] - first[0], last[1] - first[1]) <= 1.5) {
    const mid = Math.floor(path.length / 2);
    const a = simplifyOpen(path.slice(0, mid + 1), epsilon);
    const b = simplifyOpen(path.slice(mid), epsilon);
    return a.concat(b.slice(1));
  }
  return simplifyOpen(path, epsilon);
}

function simplifyOpen(path: CellPoint[], epsilon: number): CellPoint[] {
  if (path.length <= 2) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, az] = path[a];
    const [bx, bz] = path[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    let worst = -1;
    let worstD = epsilon;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((path[i][0] - ax) * dz - (path[i][1] - az) * dx) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return path.filter((_, i) => keep[i] === 1);
}
