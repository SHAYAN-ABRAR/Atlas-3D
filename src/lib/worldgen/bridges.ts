/**
 * Bridge span geometry: real bridges cross water in a straight line between
 * their abutments, with a level (or evenly graded) deck — they don't follow
 * the drowned road's curve or dip toward the middle of the lake.
 */

/**
 * Finds contiguous runs of samples whose ground lies under water, snaps each
 * run onto the straight chord between the dry anchor samples on either side,
 * and returns a per-sample deck height for the run: linear between the two
 * anchors' deck heights and never below `waterLevel + freeboard`. Samples
 * outside water runs get null (the deck follows terrain there).
 *
 * `samples` is modified in place; call before computing ribbon offsets.
 */
export function straightenWaterSpans(
  samples: [number, number][],
  heightAt: (x: number, z: number) => number,
  waterLevel: number,
  freeboard: number,
): (number | null)[] {
  const n = samples.length;
  const deck: (number | null)[] = new Array(n).fill(null);
  const floor = waterLevel + freeboard;
  const wet = samples.map(([x, z]) => heightAt(x, z) < waterLevel - 0.2);
  let i = 0;
  while (i < n) {
    if (!wet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && wet[j]) j++;
    // Anchors: the dry sample on each side — or the polyline's own endpoint
    // when the span reaches it (a ribbon ending at a mid-water junction).
    // That endpoint is pinned by the road network, so it anchors the chord
    // just as well as a shore would.
    const a = i - 1 >= 0 ? i - 1 : i;
    const b = j < n ? j : j - 1;
    if (b > a) {
      const da = Math.max(heightAt(samples[a][0], samples[a][1]), floor);
      const db = Math.max(heightAt(samples[b][0], samples[b][1]), floor);
      for (let k = i; k < j; k++) {
        const t = (k - a) / (b - a);
        samples[k][0] = samples[a][0] + (samples[b][0] - samples[a][0]) * t;
        samples[k][1] = samples[a][1] + (samples[b][1] - samples[a][1]) * t;
        deck[k] = Math.max(da + (db - da) * t, floor);
      }
    } else {
      for (let k = i; k < j; k++) deck[k] = floor;
    }
    i = j;
  }
  return deck;
}
