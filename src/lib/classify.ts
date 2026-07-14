/**
 * Pixel classification shared by the map-analysis service and its worker.
 * Classes: 0 terrain · 1 water · 2 vegetation · 3 road · 4 building
 *
 * Color alone cannot classify a satellite photo: sunlit streets and rooftops
 * are the same gray, tropical pond water is the same dark green as tree
 * canopy, and cast shadows share their blue-gray tint with open water. So
 * classification runs in two rounds. Per-pixel color rules emit the classes
 * they can prove plus four ambiguous candidates — bright pavement, dark
 * ground, green water, blue shade. After despeckling, a shape pass resolves
 * every candidate region: ribbons that erode away in a cell or two become
 * roads no matter how they bend, compact glassy-smooth blobs become water,
 * textured mass becomes rooftops or canopy, and lone shadow streaks vanish
 * into terrain. Connected-component filtering then drops undersized noise.
 *
 * Thresholds are calibrated against real satellite imagery (Esri World
 * Imagery over Dhaka) and Google map/hybrid screenshots: e.g. real avenues
 * measure luminance-texture (mad) up to ~22 from vehicles and lane marks,
 * so texture never disqualifies a road — shape does.
 */

const TERRAIN = 0;
const WATER = 1;
const VEGETATION = 2;
const ROAD = 3;
const BUILDING = 4;
// Candidates a color rule cannot settle; resolved by shape, never returned.
const PAVE = 5; // bright low-sat gray — street or rooftop/plaza
const DARK = 6; // dark low-sat — asphalt, ink stroke, dark roof or deep shade
const GREENWATER = 7; // dark smooth green — algae pond or manicured lawn
const SHADE = 8; // blue-tinted dark — cast shadow or dark water
const SPLIT = 9; // darker corridors inside a bright built-up field

const CLASS_COUNT = 10;

/** Minimum connected-region size per class; smaller islands revert to terrain. */
const MIN_REGION = [0, 20, 6, 8, 3];

/**
 * `data` is a (width × height) RGBA buffer; the returned grid is
 * (width/factor × height/factor). With factor > 1 each output cell averages a
 * factor² pixel block and measures its luminance texture — the key signal
 * separating glassy water from photographed canopy and rooftops (noisy).
 */
export function classifyPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  factor = 1,
): number[] {
  const ow = Math.max(1, Math.floor(width / factor));
  const oh = Math.max(1, Math.floor(height / factor));
  const n = factor * factor;
  const cells = new Array<number>(ow * oh);
  const mads = new Float32Array(ow * oh);
  const greens = new Float32Array(ow * oh);
  const cellLums = new Float32Array(ow * oh);
  const warms = new Float32Array(ow * oh);
  const lums = new Float32Array(n);

  // Auto-levels: providers render the same city at wildly different tone —
  // Esri imagery is punchy while Google satellite is hazy with lifted
  // blacks. Stretch the 2nd–98th luminance percentile span to a canonical
  // range so one set of color thresholds serves both.
  const hist = new Uint32Array(256);
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const j = i * 4;
    hist[(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) | 0]++;
  }
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let k = 0; k < 256; k++) {
    acc += hist[k];
    if (acc >= total * 0.02) {
      lo = k;
      break;
    }
  }
  acc = 0;
  for (let k = 255; k >= 0; k--) {
    acc += hist[k];
    if (acc >= total * 0.02) {
      hi = k;
      break;
    }
  }
  // Gain is capped so a near-flat image (blank paper, solid fills) is not
  // blown up into noise.
  const gain = hi - lo >= 40 ? Math.min(235 / (hi - lo), 2.4) : 1;
  const off = 10 - lo * gain;
  const tone = (v: number): number => {
    const t = v * gain + off;
    return t < 0 ? 0 : t > 255 ? 255 : t;
  };

  for (let oz = 0; oz < oh; oz++) {
    for (let ox = 0; ox < ow; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dz = 0; dz < factor; dz++)
        for (let dx = 0; dx < factor; dx++) {
          const i = ((oz * factor + dz) * width + ox * factor + dx) * 4;
          const pr = tone(data[i]);
          const pg = tone(data[i + 1]);
          const pb = tone(data[i + 2]);
          r += pr;
          g += pg;
          b += pb;
          lums[dz * factor + dx] = 0.299 * pr + 0.587 * pg + 0.114 * pb;
        }
      r /= n;
      g /= n;
      b /= n;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // Mean absolute luminance deviation inside the block: ~0 for flat map
      // art, open water and asphalt, high for photographed rooftops/canopy.
      let mad = 0;
      for (let k = 0; k < n; k++) mad += Math.abs(lums[k] - lum);
      mad /= n;
      const oi = oz * ow + ox;
      mads[oi] = mad;
      greens[oi] = g - (r + b) / 2;
      cellLums[oi] = lum;
      warms[oi] = r - b;

      let cls = TERRAIN;
      if (g > 120 && b > r + 30 && g > b + 12) cls = ROAD; // teal traffic/route overlays
      else if (sat > 90 && r > 200 && g > 140 && b < g - 60 && b < 110)
        cls = ROAD; // amber highways (b-cap keeps bright dirt out)
      else if (r > 170 && g < 90 && b < 90) cls = ROAD; // red congestion overlays
      else if (r > 230 && g > 215 && Math.abs(r - g) < 18 && b < g - 55 && mad < 8)
        cls = ROAD; // pale-yellow hybrid ribbons: r≈g yellow, unlike red-leaning dirt
      else if (b > r + 20 && b > g + 8 && b > 64 && lum >= 85 && mad < 15)
        cls = WATER; // unmistakably blue and smooth
      else if (b > r + 10 && b >= g - 2 && lum < 85 && mad < 24)
        cls = SHADE; // blue-gray dark: cast shadow or dark water
      else if (g > r + 2 && g >= b + 4 && lum < 72 && mad < 10)
        cls = GREENWATER; // dark glassy green: algae pond or flat lawn
      else if (g > r + 10 && g > b + 10 && g > 60) cls = VEGETATION; // bright greens
      else if (g > r + 4 && g > b + 6 && sat >= 10 && lum < 110)
        cls = VEGETATION; // darker canopy (g-margin spares olive-gray streets)
      else if (g - (r + b) / 2 >= 25 && lum < 165) cls = VEGETATION; // dry-season olive canopy
      else if (r - b > 40 && lum > 170) cls = TERRAIN; // warm bright: dirt, sand, dry field
      else if (sat < 60 && lum < 92) cls = DARK; // asphalt / ink stroke / dark roof / shade
      else if (sat < 75 && lum >= 92 && lum < 253) cls = PAVE; // concrete: street or roof
      else if (r > 130 && r > g + 28 && r > b + 45) cls = BUILDING; // brick / roof reds
      else if (mad > 30 && lum >= 60 && lum < 200) cls = BUILDING; // textured urban fabric
      cells[oi] = cls;
    }
  }

  despeckle(cells, ow, oh);
  despeckle(cells, ow, oh);
  resolveShapes(cells, { mads, greens, lums: cellLums, warms }, ow, oh);
  despeckle(cells, ow, oh);
  dropSmallRegions(cells, ow, oh);
  return cells;
}

interface BlobStats {
  area: number;
  /** Longest bounding-box side, in cells. */
  longSpan: number;
  /** Max erosion rounds until the region vanishes ≈ half its widest point. */
  depth: number;
  /** Mean erosion depth over the region ≈ half its *typical* width. */
  meanDepth: number;
  avgMad: number;
  avgGreen: number;
  meanLum: number;
  avgWarm: number;
}

/**
 * A blob is street-shaped when it is long but typically erodes away in
 * under two rounds. The mean matters, not the max: junctions locally
 * thicken a road network, but they barely move its average width.
 */
const ribbon = (s: BlobStats) => s.meanDepth <= 1.8 && s.longSpan >= 16;

/** Per-cell measurement planes consulted by the shape pass. */
interface CellStats {
  mads: Float32Array;
  greens: Float32Array;
  lums: Float32Array;
  warms: Float32Array;
}

/** Resolves the ambiguous candidate classes by region shape. */
function resolveShapes(cells: number[], cs: CellStats, width: number, height: number): void {
  const total = width * height;
  // Bright pavement: ribbons are avenues (texture from vehicles and lane
  // marks never disqualifies them). Big blobs get split: their darker or
  // grayer corridors are candidate streets, re-tested for ribbon shape on
  // their own; the remaining mass is bare warm ground or flat paper when
  // it looks like either, and rooftop/plaza otherwise.
  resolveShape(cells, cs, width, height, PAVE, 1, ROAD, (s, region) => {
    if (ribbon(s)) return ROAD;
    if (s.area >= 150 || s.area > total * 0.25) {
      const ground = (s.avgWarm > 45 && s.avgMad < 12) || s.avgMad < 2.5;
      const mass = ground ? TERRAIN : BUILDING;
      for (const i of region)
        cells[i] =
          cs.lums[i] < s.meanLum - 8 || cs.warms[i] < s.avgWarm - 15 ? SPLIT : mass;
      return -1;
    }
    return BUILDING;
  });
  resolveShape(cells, cs, width, height, SPLIT, 1, ROAD, (s) =>
    ribbon(s) ? ROAD : BUILDING,
  );
  // Dark ground: ribbons are asphalt or drawn strokes; greenish mass is
  // canopy; glassy compact mass is a pond; heavily textured mass is dense
  // dark urban fabric; the faint smooth rest is bare shaded ground.
  resolveShape(cells, cs, width, height, DARK, 1, ROAD, (s) => {
    if (ribbon(s)) return ROAD;
    if (s.avgGreen >= 10) return VEGETATION;
    if (s.avgMad < 4 && s.area >= 40 && s.depth >= 3) return WATER;
    if (s.avgMad >= 16) return BUILDING;
    return TERRAIN;
  });
  // Dark green: only broad glassy strongly-green regions are ponds — canopy,
  // lawns and dark tree-shaded roofs are textured or barely green.
  resolveShape(cells, cs, width, height, GREENWATER, 1, VEGETATION, (s) =>
    s.area >= 25 && s.avgMad < 6 && s.depth >= 2 && s.avgGreen >= 18 ? WATER : VEGETATION,
  );
  // Blue shade: only broad compact pools are really water — the streaks
  // that towers and trees cast melt back into the ground.
  resolveShape(cells, cs, width, height, SHADE, 2, TERRAIN, (s) =>
    s.area >= 32 && s.depth >= 3 ? WATER : TERRAIN,
  );
}

/**
 * Splits one candidate class into mass and ribbon with a morphological
 * opening: erode `radius` times, then grow back inside the original mask.
 * What survives is blob mass, handed to `blobClass` region by region with
 * its shape stats; what eroded away is at most ~2·radius cells wide and
 * becomes `thinClass`. `blobClass` may assign region cells itself and
 * return -1 to signal it has done so.
 */
function resolveShape(
  cells: number[],
  cs: CellStats,
  width: number,
  height: number,
  cls: number,
  radius: number,
  thinClass: number,
  blobClass: (s: BlobStats, region: readonly number[]) => number,
): void {
  const n = width * height;
  const mask = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++)
    if (cells[i] === cls) {
      mask[i] = 1;
      any = true;
    }
  if (!any) return;

  const blob = mask.slice();
  for (let k = 0; k < radius; k++) erode(blob, width, height);
  for (let k = 0; k < radius; k++) dilateWithin(blob, mask, width, height);

  // Erosion depth per blob cell: the round in which erosion removes it.
  // A region's max depth ≈ half its typical width — robust against bends
  // and junctions, unlike bounding-box aspect ratios.
  const depth = new Float32Array(n);
  const scratch = blob.slice();
  for (let round = 1; ; round++) {
    let alive = false;
    const before = scratch.slice();
    erode(scratch, width, height);
    for (let i = 0; i < n; i++) {
      if (before[i] && !scratch[i]) depth[i] = round;
      alive = alive || scratch[i] === 1;
    }
    if (!alive) break;
  }

  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const region: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!blob[start] || seen[start]) continue;
    stack.length = 0;
    region.length = 0;
    stack.push(start);
    seen[start] = 1;
    let x0 = width;
    let x1 = 0;
    let z0 = height;
    let z1 = 0;
    let madSum = 0;
    let greenSum = 0;
    let lumSum = 0;
    let warmSum = 0;
    let depthSum = 0;
    let maxDepth = 0;
    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      madSum += cs.mads[i];
      greenSum += cs.greens[i];
      lumSum += cs.lums[i];
      warmSum += cs.warms[i];
      depthSum += depth[i];
      if (depth[i] > maxDepth) maxDepth = depth[i];
      const x = i % width;
      const z = (i / width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      if (x > 0 && !seen[i - 1] && blob[i - 1]) {
        seen[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < width - 1 && !seen[i + 1] && blob[i + 1]) {
        seen[i + 1] = 1;
        stack.push(i + 1);
      }
      if (z > 0 && !seen[i - width] && blob[i - width]) {
        seen[i - width] = 1;
        stack.push(i - width);
      }
      if (z < height - 1 && !seen[i + width] && blob[i + width]) {
        seen[i + width] = 1;
        stack.push(i + width);
      }
    }
    const out = blobClass(
      {
        area: region.length,
        longSpan: Math.max(x1 - x0, z1 - z0) + 1,
        depth: maxDepth,
        meanDepth: depthSum / region.length,
        avgMad: madSum / region.length,
        avgGreen: greenSum / region.length,
        meanLum: lumSum / region.length,
        avgWarm: warmSum / region.length,
      },
      region,
    );
    if (out >= 0) for (const i of region) cells[i] = out;
  }

  for (let i = 0; i < n; i++) if (mask[i] && !blob[i]) cells[i] = thinClass;
}

/** 4-neighbor erosion; the image border counts as outside. */
function erode(mask: Uint8Array, width: number, height: number): void {
  const src = mask.slice();
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      if (!src[i]) continue;
      if (
        x === 0 ||
        z === 0 ||
        x === width - 1 ||
        z === height - 1 ||
        !src[i - 1] ||
        !src[i + 1] ||
        !src[i - width] ||
        !src[i + width]
      )
        mask[i] = 0;
    }
}

/** Grows `blob` by one cell, but only into cells of `mask` (geodesic dilation). */
function dilateWithin(blob: Uint8Array, mask: Uint8Array, width: number, height: number): void {
  const src = blob.slice();
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++) {
      const i = z * width + x;
      if (src[i] || !mask[i]) continue;
      if (
        (x > 0 && src[i - 1]) ||
        (x < width - 1 && src[i + 1]) ||
        (z > 0 && src[i - width]) ||
        (z < height - 1 && src[i + width])
      )
        blob[i] = 1;
    }
}

/**
 * Cells with at most one same-class neighbor adopt the local majority.
 * Thin lines (roads) have two same-class neighbors, so they survive.
 */
function despeckle(cells: number[], width: number, height: number): void {
  const src = cells.slice();
  const counts = new Array<number>(CLASS_COUNT);
  for (let z = 1; z < height - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      const i = z * width + x;
      counts.fill(0);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          counts[src[(z + dz) * width + (x + dx)]]++;
        }
      if (counts[src[i]] > 1) continue;
      let bestCls = src[i];
      let bestCount = 3; // adopt only a clear majority (≥4 of 8)
      for (let k = 0; k < CLASS_COUNT; k++)
        if (counts[k] > bestCount) {
          bestCount = counts[k];
          bestCls = k;
        }
      cells[i] = bestCls;
    }
  }
}

/**
 * Flood-fills each non-terrain region (8-connected, so thin diagonal roads
 * hold together) and reverts undersized ones to terrain. Road regions must
 * also span a minimum distance — a compact road-colored blob is a map icon
 * or overlay glyph, not a street.
 */
function dropSmallRegions(cells: number[], width: number, height: number): void {
  const seen = new Uint8Array(cells.length);
  const stack: number[] = [];
  const region: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    const cls = cells[start];
    if (cls === TERRAIN || seen[start]) continue;
    stack.length = 0;
    region.length = 0;
    stack.push(start);
    seen[start] = 1;
    let x0 = width;
    let x1 = 0;
    let z0 = height;
    let z1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      const x = i % width;
      const z = (i / width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
          const ni = nz * width + nx;
          if (!seen[ni] && cells[ni] === cls) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
    }
    const longSpan = Math.max(x1 - x0, z1 - z0) + 1;
    if (region.length < MIN_REGION[cls] || (cls === ROAD && longSpan < 8))
      for (const i of region) cells[i] = TERRAIN;
  }
}
