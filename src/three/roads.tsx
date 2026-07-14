'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { straightenWaterSpans } from '@/lib/worldgen/bridges';
import type { BuildingStyle, GeneratedWorld, WorldState } from '@/types/world';
import { createRoadTexture, type RoadLook } from './textures';

const ROAD_LOOKS: Record<BuildingStyle, Omit<RoadLook, 'curbs'>> = {
  modern: { base: '#38393d', dirt: false, dashes: true },
  cyberpunk: { base: '#212228', dirt: false, dashes: true },
  industrial: { base: '#403f3e', dirt: false, dashes: false },
  japanese: { base: '#37383c', dirt: false, dashes: false },
  medieval: { base: '#7d6c50', dirt: true, dashes: false },
  nordic: { base: '#71654f', dirt: true, dashes: false },
};

/** Bridge understructure (skirts + piers): concrete, or stone for dirt styles. */
const PIER_COLORS: Record<BuildingStyle, string> = {
  modern: '#8d9196',
  cyberpunk: '#565c68',
  industrial: '#7f7b76',
  japanese: '#8d9196',
  medieval: '#6f6252',
  nordic: '#6e6757',
};

/** Deck height above the water surface for road spans over water. */
const BRIDGE_FREEBOARD = 1.1;
/** Concrete apron hanging below the deck edge along elevated spans. */
const BRIDGE_SKIRT = 1.05;
/** Distance between bridge piers along a span. */
const PIER_SPACING = 13;
/** Parapet wall height above the deck and its thickness. */
const PARAPET = 0.85;
const PARAPET_T = 0.22;

/**
 * One draped ribbon mesh for the whole network. Each street renders as a
 * single continuous strip with mitered joints, so curves stay smooth and
 * the dash texture runs unbroken from end to end. Terrain under the roads
 * is pre-graded by the generator, so a fine sampling step hugs the ground.
 *
 * Where the ground dips below `deckLevel` (water crossings) the deck stays
 * clamped at that level instead of following the lakebed, and the span gets
 * a bridge understructure: side skirts below the deck edges plus piers down
 * to the bed. Pass -Infinity to disable (water off → everything drapes).
 */
function buildRoadGeometries(
  gen: GeneratedWorld,
  deckLevel: number,
): { road: THREE.BufferGeometry | null; bridge: THREE.BufferGeometry | null } {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const bPos: number[] = [];
  const bNrm: number[] = [];
  const bIdx: number[] = [];
  const step = 3.2;

  type V3 = [number, number, number];
  // Understructure faces render double-sided (the standard material flips
  // normals for back faces), so winding can never cull a bridge wall.
  const quad = (a: V3, b: V3, c: V3, d: V3, nx: number, ny: number, nz: number) => {
    const base = bPos.length / 3;
    bPos.push(...a, ...b, ...c, ...d);
    for (let k = 0; k < 4; k++) bNrm.push(nx, ny, nz);
    bIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Older cached worlds may predate polylines — degrade to per-segment strips.
  const polys =
    gen.roadPolylines ??
    gen.roads.map((seg) => ({
      pts: [
        [seg.ax, seg.az],
        [seg.bx, seg.bz],
      ] as [number, number][],
      width: seg.width,
    }));

  for (let p = 0; p < polys.length; p++) {
    const { pts, width } = polys[p];
    // Resample: subdivide long segments so the ribbon follows the terrain.
    const samples: [number, number][] = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1];
      const [bx, bz] = pts[i];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / step));
      for (let s = i === 1 ? 0 : 1; s <= steps; s++)
        samples.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
    }
    if (samples.length < 2) continue;

    // Water crossings become straight, evenly graded bridge spans: the run
    // of underwater samples snaps onto the chord between its two shore
    // anchors and gets a level deck height (never below the bridge floor).
    const deckOverride =
      deckLevel > -Infinity
        ? straightenWaterSpans(samples, gen.heightAt, gen.waterLevel, BRIDGE_FREEBOARD)
        : null;

    const half = width / 2;
    // Ribbons are trimmed at junctions, but trims are capped (a ribbon never
    // loses more than 45% of its length per end), so short blocks between
    // close junctions can still overlap a neighbor — a micro-stagger keeps
    // those from z-fighting while staying visually coplanar. Untrimmed
    // legacy worlds get the original coarser stagger.
    const lift = gen.junctions?.length ? 0.105 + (p % 6) * 0.004 : 0.1 + (p % 5) * 0.016;
    const vScale = 1 / (width * 2); // one texture tile per 2×width meters
    const base = positions.length / 3;
    let v = 0;

    // Per-sample record for the bridge pass: center, terrain height, deck
    // height (with lift) and the two ribbon edge points.
    const sx: number[] = [];
    const sz: number[] = [];
    const sty: number[] = [];
    const sy: number[] = [];
    const slx: number[] = [];
    const slz: number[] = [];
    const srx: number[] = [];
    const srz: number[] = [];

    for (let i = 0; i < samples.length; i++) {
      const [cx, cz] = samples[i];
      const [qx, qz] = samples[Math.max(0, i - 1)];
      const [rx, rz] = samples[Math.min(samples.length - 1, i + 1)];
      let dinx = cx - qx;
      let dinz = cz - qz;
      let doutx = rx - cx;
      let doutz = rz - cz;
      const linLen = Math.hypot(dinx, dinz) || 1;
      const loutLen = Math.hypot(doutx, doutz) || 1;
      dinx /= linLen;
      dinz /= linLen;
      doutx /= loutLen;
      doutz /= loutLen;
      // Endpoints have no incoming/outgoing neighbor — their direction is a
      // zero vector, which would drive the miter denominator to its clamp
      // and flare the ribbon end to double width. Use the one real tangent.
      if (i === 0) {
        dinx = doutx;
        dinz = doutz;
      } else if (i === samples.length - 1) {
        doutx = dinx;
        doutz = dinz;
      }
      // Miter direction: perpendicular of the averaged tangent, scaled so
      // the ribbon keeps its width through the bend (capped for hairpins).
      let mx = dinx + doutx;
      let mz = dinz + doutz;
      const mLen = Math.hypot(mx, mz);
      if (mLen < 1e-4) {
        mx = dinx;
        mz = dinz;
      } else {
        mx /= mLen;
        mz /= mLen;
      }
      const nx = -mz;
      const nz = mx;
      const denom = Math.max(0.5, nx * -doutz + nz * doutx);
      const w = half / denom;
      if (i > 0) v += Math.hypot(cx - qx, cz - qz) * vScale;
      const ty = gen.heightAt(cx, cz);
      const y = (deckOverride?.[i] ?? Math.max(ty, deckLevel)) + lift;
      positions.push(cx - nx * w, y, cz - nz * w, cx + nx * w, y, cz + nz * w);
      uvs.push(0, v, 1, v);
      sx.push(cx);
      sz.push(cz);
      sty.push(ty);
      sy.push(y);
      slx.push(cx - nx * w);
      slz.push(cz - nz * w);
      srx.push(cx + nx * w);
      srz.push(cz + nz * w);
    }
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }

    // Bridge understructure wherever the deck rides above the ground.
    let acc = PIER_SPACING * 0.5; // first pier lands mid-span, not at the shore
    for (let i = 0; i + 1 < samples.length; i++) {
      const elevA = sy[i] - lift - sty[i] > 0.3;
      const elevB = sy[i + 1] - lift - sty[i + 1] > 0.3;
      if (!elevA || !elevB) {
        acc = PIER_SPACING * 0.5;
        continue;
      }
      // Each deck edge gets a parapet wall plus the girder skirt below:
      // outer face from parapet top down past the deck, a top cap for
      // solidity, and an inner face back down to the deck surface.
      for (const [ex, ez] of [
        [slx, slz],
        [srx, srz],
      ] as const) {
        let onx = ex[i] - sx[i];
        let onz = ez[i] - sz[i];
        const oLen = Math.hypot(onx, onz) || 1;
        onx /= oLen;
        onz /= oLen;
        const ixA = ex[i] - onx * PARAPET_T;
        const izA = ez[i] - onz * PARAPET_T;
        const ixB = ex[i + 1] - onx * PARAPET_T;
        const izB = ez[i + 1] - onz * PARAPET_T;
        quad(
          [ex[i], sy[i] + PARAPET, ez[i]],
          [ex[i + 1], sy[i + 1] + PARAPET, ez[i + 1]],
          [ex[i + 1], sy[i + 1] - BRIDGE_SKIRT, ez[i + 1]],
          [ex[i], sy[i] - BRIDGE_SKIRT, ez[i]],
          onx, 0, onz,
        );
        quad(
          [ex[i], sy[i] + PARAPET, ez[i]],
          [ex[i + 1], sy[i + 1] + PARAPET, ez[i + 1]],
          [ixB, sy[i + 1] + PARAPET, izB],
          [ixA, sy[i] + PARAPET, izA],
          0, 1, 0,
        );
        quad(
          [ixA, sy[i] + PARAPET, izA],
          [ixB, sy[i + 1] + PARAPET, izB],
          [ixB, sy[i + 1], izB],
          [ixA, sy[i], izA],
          -onx, 0, -onz,
        );
      }
      // Piers march down the span, but only where there is real depth —
      // shallow shore hops keep just the skirt.
      acc += Math.hypot(sx[i + 1] - sx[i], sz[i + 1] - sz[i]);
      if (acc >= PIER_SPACING && sy[i] - lift - sty[i] > 1.0) {
        acc = 0;
        let tx = sx[i + 1] - sx[i];
        let tz = sz[i + 1] - sz[i];
        const tLen = Math.hypot(tx, tz) || 1;
        tx /= tLen;
        tz /= tLen;
        const pnx = -tz;
        const pnz = tx;
        const halfN = Math.min(1.6, Math.max(0.7, width * 0.3)); // across the road
        const halfT = 0.55; // along the road
        const yTop = sy[i] - 0.5; // tucked behind the skirt
        const yBot = sty[i] - 0.5; // rooted into the bed
        const corner = (sN: number, sT: number): [number, number] => [
          sx[i] + pnx * halfN * sN + tx * halfT * sT,
          sz[i] + pnz * halfN * sN + tz * halfT * sT,
        ];
        const c1 = corner(-1, -1);
        const c2 = corner(1, -1);
        const c3 = corner(1, 1);
        const c4 = corner(-1, 1);
        quad([c1[0], yTop, c1[1]], [c2[0], yTop, c2[1]], [c2[0], yBot, c2[1]], [c1[0], yBot, c1[1]], -tx, 0, -tz);
        quad([c3[0], yTop, c3[1]], [c4[0], yTop, c4[1]], [c4[0], yBot, c4[1]], [c3[0], yBot, c3[1]], tx, 0, tz);
        quad([c2[0], yTop, c2[1]], [c3[0], yTop, c3[1]], [c3[0], yBot, c3[1]], [c2[0], yBot, c2[1]], pnx, 0, pnz);
        quad([c4[0], yTop, c4[1]], [c1[0], yTop, c1[1]], [c1[0], yBot, c1[1]], [c4[0], yBot, c4[1]], -pnx, 0, -pnz);
      }
    }
  }

  if (positions.length === 0) return { road: null, bridge: null };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

  let bridge: THREE.BufferGeometry | null = null;
  if (bIdx.length > 0) {
    bridge = new THREE.BufferGeometry();
    bridge.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
    bridge.setAttribute('normal', new THREE.Float32BufferAttribute(bNrm, 3));
    bridge.setIndex(bIdx);
  }
  return { road: geo, bridge };
}

/**
 * Junction fill: one draped polygon per intersection, fanned from its
 * center to the ring of trimmed ribbon-end corners. It sits a hair below
 * the ribbons and tucks under their ends, so the network reads as one
 * continuous paved surface with lane dashes stopping at the junction.
 */
function buildJunctionGeometry(gen: GeneratedWorld, deckLevel: number): THREE.BufferGeometry | null {
  const junctions = (gen.junctions ?? []).filter((j) => j.ring && j.ring.length >= 3);
  if (junctions.length === 0) return null;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let ji = 0; ji < junctions.length; ji++) {
    const j = junctions[ji];
    // Strictly below the ribbons' 0.105+ band, micro-staggered so two
    // junction fills meeting side by side never z-fight.
    const LIFT = 0.088 + (ji % 5) * 0.003;
    const base = positions.length / 3;
    positions.push(j.x, Math.max(gen.heightAt(j.x, j.z), deckLevel) + LIFT, j.z);
    uvs.push(0.5, 0.5);
    const n = j.ring.length;
    for (const [x, z] of j.ring) {
      positions.push(x, Math.max(gen.heightAt(x, z), deckLevel) + LIFT, z);
      // Planar asphalt mapping in world units, matching the ribbon grain.
      uvs.push(0.5 + (x - j.x) / 14, 0.5 + (z - j.z) / 14);
    }
    for (let s = 0; s < n; s++) {
      indices.push(base, base + 1 + s, base + 1 + ((s + 1) % n));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

export function Roads({ gen, world }: { gen: GeneratedWorld; world: WorldState }) {
  // With water off there is nothing to bridge — every road drapes on terrain.
  const deckLevel = world.water.enabled ? gen.waterLevel + BRIDGE_FREEBOARD : -Infinity;
  const { road: geometry, bridge: bridgeGeometry } = useMemo(
    () => buildRoadGeometries(gen, deckLevel),
    [gen, deckLevel],
  );
  const junctionGeometry = useMemo(() => buildJunctionGeometry(gen, deckLevel), [gen, deckLevel]);
  const look = ROAD_LOOKS[world.city.style];
  const texture = useMemo(
    () => createRoadTexture(world.seed & 0xffff, { ...look, curbs: world.roads.sidewalks }),
    [look, world.roads.sidewalks, world.seed],
  );
  // Junction patches: same asphalt, no dashes, no curbs.
  const plainTexture = useMemo(
    () => createRoadTexture(world.seed & 0xffff, { ...look, dashes: false, curbs: false }),
    [look, world.seed],
  );

  useEffect(
    () => () => {
      geometry?.dispose();
      junctionGeometry?.dispose();
      bridgeGeometry?.dispose();
    },
    [geometry, junctionGeometry, bridgeGeometry],
  );
  useEffect(
    () => () => {
      texture.dispose();
      plainTexture.dispose();
    },
    [texture, plainTexture],
  );

  if (!geometry) return null;

  return (
    <group name="roads">
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial
          map={texture}
          roughness={look.dirt ? 0.98 : 0.92}
          metalness={0.02}
        />
      </mesh>
      {junctionGeometry && (
        <mesh geometry={junctionGeometry} receiveShadow>
          <meshStandardMaterial
            map={plainTexture}
            roughness={look.dirt ? 0.98 : 0.92}
            metalness={0.02}
          />
        </mesh>
      )}
      {bridgeGeometry && (
        <mesh geometry={bridgeGeometry} castShadow receiveShadow>
          <meshStandardMaterial
            color={PIER_COLORS[world.city.style]}
            roughness={0.94}
            metalness={0.04}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}
