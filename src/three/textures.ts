import * as THREE from 'three';
import { mulberry32 } from '@/lib/rng';

/**
 * All surface detail in Atlas 3D is painted procedurally onto canvases —
 * no downloaded assets, deterministic per seed.
 */

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Terrain grain — near-white noise that modulates vertex colors.      */
/* ------------------------------------------------------------------ */

export function createDetailTexture(seed = 101): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(seed);

  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 226 + rng() * 29;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Broad variation comes from world-space terrain colors, not repeated blobs.
  return canvasTexture(canvas);
}

/* ------------------------------------------------------------------ */
/* Roads — asphalt or packed dirt, optional curbs and lane dashes.     */
/* One tile maps to (width × 2·width) world units along the ribbon.    */
/* ------------------------------------------------------------------ */

export interface RoadLook {
  base: string;
  dirt: boolean;
  dashes: boolean;
  curbs: boolean;
}

export function createRoadTexture(seed: number, look: RoadLook): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(seed);

  ctx.fillStyle = look.base;
  ctx.fillRect(0, 0, W, H);

  // Speckle grain
  for (let i = 0; i < 2600; i++) {
    const l = rng();
    ctx.fillStyle =
      l > 0.5 ? `rgba(255,255,255,${0.02 + rng() * 0.05})` : `rgba(0,0,0,${0.03 + rng() * 0.07})`;
    ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 2, 1 + rng() * 2);
  }

  if (look.dirt) {
    // Wheel ruts and scattered stones
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.fillRect(W * 0.24, 0, W * 0.1, H);
    ctx.fillRect(W * 0.66, 0, W * 0.1, H);
    for (let i = 0; i < 46; i++) {
      ctx.fillStyle = `rgba(${180 + rng() * 40},${170 + rng() * 35},${150 + rng() * 30},${0.14 + rng() * 0.2})`;
      ctx.beginPath();
      ctx.arc(rng() * W, rng() * H, 1 + rng() * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Grassy verge bleed at the edges
    ctx.fillStyle = 'rgba(52,66,36,0.35)';
    ctx.fillRect(0, 0, 5, H);
    ctx.fillRect(W - 5, 0, 5, H);
  } else {
    // Subtle tar seams
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) {
      const y = rng() * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(W * 0.3, y + rng() * 16 - 8, W * 0.7, y + rng() * 16 - 8, W, y);
      ctx.stroke();
    }
  }

  if (look.curbs) {
    const cw = 9;
    const curb = look.dirt ? '#8f8874' : '#93938e';
    const curbDark = look.dirt ? '#77705e' : '#77776f';
    for (const x of [0, W - cw]) {
      ctx.fillStyle = curb;
      ctx.fillRect(x, 0, cw, H);
      // Paver joints
      ctx.fillStyle = curbDark;
      for (let y = 0; y < H; y += 18) ctx.fillRect(x, y + (rng() * 4 - 2), cw, 1.6);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(cw, 0, 1.6, H);
    ctx.fillRect(W - cw - 1.6, 0, 1.6, H);
  }

  if (look.dashes && !look.dirt) {
    ctx.fillStyle = 'rgba(230,226,204,0.78)';
    // At a typical 6.2 m road width these are approximately 3 m dashes / 3 m gaps.
    for (let y = 12; y < H; y += 128) ctx.fillRect(W / 2 - 1.2, y, 2.4, 62);
  }

  return canvasTexture(canvas);
}

/* ------------------------------------------------------------------ */
/* Building facades — daytime glass + aligned night emissive windows.  */
/* ------------------------------------------------------------------ */

export interface FacadeTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

export function createFacadeTextures(
  kind: 'tower' | 'cottage',
  seed = 913,
  surface: 'plaster' | 'timber' | 'masonry' = 'plaster',
): FacadeTextures {
  const W = 256;
  const H = 128;
  const mapCanvas = document.createElement('canvas');
  const emiCanvas = document.createElement('canvas');
  mapCanvas.width = emiCanvas.width = W;
  mapCanvas.height = emiCanvas.height = H;
  const mctx = mapCanvas.getContext('2d')!;
  const ectx = emiCanvas.getContext('2d')!;
  const rng = mulberry32(seed + (kind === 'tower' ? 0 : 7));

  // Wall base: near-white so per-instance palette colors dominate.
  mctx.fillStyle = '#efedea';
  mctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 1600; i++) {
    mctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(60,55,48,0.04)';
    mctx.fillRect(rng() * W, rng() * H, 2, 2);
  }
  // Keep construction joints subtle and at the same scale as the window bays.
  mctx.fillStyle = 'rgba(70,64,54,0.13)';
  if (surface === 'timber') {
    for (let x = 0; x < W; x += 10) {
      mctx.fillRect(x, 0, 1, H);
      mctx.fillStyle = 'rgba(70,64,54,0.06)';
      mctx.fillRect(x + 3, rng() * 16, 1, H);
      mctx.fillStyle = 'rgba(70,64,54,0.13)';
    }
  } else if (surface === 'masonry') {
    for (let y = 0; y < H; y += 8) {
      mctx.fillRect(0, y, W, 0.8);
      for (let x = y % 16 ? 8 : 0; x < W; x += 16) mctx.fillRect(x, y, 0.8, 8);
    }
  }
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, W, H);

  // One tile is two window bays and one storey; geometry supplies metric UVs.
  const cols = 2;
  const rows = 1;
  const cw = W / cols;
  const ch = H / rows;
  const inset = kind === 'tower' ? 22 : 34;

  for (let r = 0; r < rows; r++) {
    // Floor slab shadow line (towers only)
    if (kind === 'tower') {
      mctx.fillStyle = 'rgba(50,46,40,0.18)';
      mctx.fillRect(0, r * ch, W, 2);
    }
    for (let c = 0; c < cols; c++) {
      const x = c * cw + inset;
      const y = r * ch + inset;
      const w = cw - inset * 2;
      const h = ch - inset * 2;

      // Day glass: sky-reflecting, light at the top, cooler below.
      const glassL = kind === 'tower' ? 96 + rng() * 52 : 62 + rng() * 34;
      const grad = mctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, `rgb(${glassL + 58},${glassL + 66},${glassL + 74})`);
      grad.addColorStop(0.4, `rgb(${glassL},${glassL + 10},${glassL + 20})`);
      grad.addColorStop(1, `rgb(${glassL - 22},${glassL - 14},${glassL - 4})`);
      mctx.fillStyle = grad;
      mctx.fillRect(x, y, w, h);
      // Frame
      mctx.strokeStyle = 'rgba(35,32,28,0.55)';
      mctx.lineWidth = 1.4;
      mctx.strokeRect(x + 0.7, y + 0.7, w - 1.4, h - 1.4);
      mctx.fillStyle = 'rgba(30,28,25,0.25)';
      mctx.fillRect(x - 3, y + h + 3, w + 6, 4);
      mctx.fillStyle = '#dedbd2';
      mctx.fillRect(x - 3, y + h, w + 6, 3);
      if (kind === 'cottage') {
        // Muntin cross
        mctx.fillStyle = 'rgba(240,238,232,0.9)';
        mctx.fillRect(x + w / 2 - 1.2, y, 2.4, h);
        mctx.fillRect(x, y + h / 2 - 1.2, w, 2.4);
      }

      // Night: a subset of windows glow warm.
      if (rng() < (kind === 'tower' ? 0.46 : 0.68)) {
        ectx.fillStyle = `rgba(255,255,255,${0.4 + rng() * 0.6})`;
        ectx.fillRect(x + 1, y + 1, w - 2, h - 2);
      }
    }
  }

  const map = canvasTexture(mapCanvas);
  const emissive = canvasTexture(emiCanvas);
  const bumpCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  bumpCanvas.width = roughCanvas.width = W;
  bumpCanvas.height = roughCanvas.height = H;
  const bctx = bumpCanvas.getContext('2d')!;
  const rctx = roughCanvas.getContext('2d')!;
  bctx.fillStyle = '#a0a0a0';
  bctx.fillRect(0, 0, W, H);
  rctx.fillStyle = '#eeeeee';
  rctx.fillRect(0, 0, W, H);
  for (let c = 0; c < cols; c++) {
    bctx.fillStyle = '#404040';
    bctx.fillRect(c * cw + inset, inset, cw - inset * 2, ch - inset * 2);
    rctx.fillStyle = '#484848';
    rctx.fillRect(c * cw + inset, inset, cw - inset * 2, ch - inset * 2);
  }
  const bump = canvasTexture(bumpCanvas);
  const roughness = canvasTexture(roughCanvas);
  bump.colorSpace = roughness.colorSpace = THREE.NoColorSpace;
  return { map, emissive, bump, roughness };
}

/** Tileable mineral grain, roof courses, or longitudinal bark relief. */
export function createSurfaceTexture(kind: 'roof' | 'bark', seed = 617): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(seed);
  ctx.fillStyle = '#c8c5bf';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4500; i++) {
    const v = 140 + rng() * 110;
    ctx.fillStyle = `rgba(${v},${v},${v},0.32)`;
    ctx.fillRect(
      rng() * 256,
      rng() * 256,
      kind === 'bark' ? 1 : 2,
      kind === 'bark' ? 8 + rng() * 35 : 2,
    );
  }
  ctx.strokeStyle = 'rgba(45,42,37,0.28)';
  ctx.lineWidth = 1.5;
  if (kind === 'roof') {
    for (let y = 0; y < 256; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
      for (let x = (y % 64) / 2; x < 256; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 32);
        ctx.stroke();
      }
    }
  } else {
    for (let x = 0; x < 256; x += 9) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 16; y <= 256; y += 16) ctx.lineTo(x + Math.sin(y * 0.05 + x) * 2, y);
      ctx.stroke();
    }
  }
  return canvasTexture(canvas);
}
