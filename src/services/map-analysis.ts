import { MAP_ANALYSIS_RES } from '@/config/constants';
import { classifyPixels } from '@/lib/classify';
import type { MapAnalysis } from '@/types/world';

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

function classifyInWorker(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  factor: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    try {
      const worker = new Worker(new URL('../workers/map-analysis.worker.ts', import.meta.url));
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('worker timeout'));
      }, 4000);
      worker.onmessage = (e: MessageEvent<{ cells: number[] }>) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(e.data.cells);
      };
      worker.onerror = () => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error('worker failed'));
      };
      worker.postMessage({ data, width, height, factor });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Analyzes an uploaded map into terrain / water / vegetation / road /
 * building cells. First tries to auto-locate the map from the place labels
 * in the image and build the grid from real OpenStreetMap data; when the
 * map can't be confidently located (no labels, offline, ambiguous hits) it
 * falls back to on-device pixel classification.
 */
export async function analyzeMapImage(
  dataUrl: string,
  sourceName: string,
  onStatus?: (status: string) => void,
): Promise<MapAnalysis> {
  try {
    const { locateMap } = await import('./geolocate');
    const located = await locateMap(dataUrl, sourceName, onStatus);
    if (located) return located.analysis;
  } catch {
    // any geolocation failure falls through to pixel classification
  }
  onStatus?.('Classifying map pixels…');
  return classifyMapImage(dataUrl, sourceName);
}

/** Pure on-device pixel classification (the offline path). */
export async function classifyMapImage(dataUrl: string, sourceName: string): Promise<MapAnalysis> {
  const img = await loadImage(dataUrl);
  const res = MAP_ANALYSIS_RES;
  // Classify from oversampled pixels so per-cell texture can tell smooth
  // water apart from photographed rooftops.
  const OVERSAMPLE = 4;
  const px = res * OVERSAMPLE;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D unavailable');

  // Cover-fit so aspect ratio doesn't skew classification.
  const scale = Math.max(px / img.width, px / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (px - dw) / 2, (px - dh) / 2, dw, dh);
  const { data } = ctx.getImageData(0, 0, px, px);

  let cells: number[];
  try {
    cells = await classifyInWorker(data, px, px, OVERSAMPLE);
  } catch {
    cells = classifyPixels(data, px, px, OVERSAMPLE); // main-thread fallback
  }

  const counts = [0, 0, 0, 0, 0];
  for (const c of cells) counts[c]++;
  const total = cells.length;

  return {
    width: res,
    height: res,
    cells,
    sourceName,
    source: 'classifier',
    coverage: {
      water: counts[1] / total,
      vegetation: counts[2] / total,
      road: counts[3] / total,
      building: counts[4] / total,
    },
  };
}
