'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
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

/**
 * One draped ribbon mesh for the whole network. Each street renders as a
 * single continuous strip with mitered joints, so curves stay smooth and
 * the dash texture runs unbroken from end to end. Terrain under the roads
 * is pre-graded by the generator, so a fine sampling step hugs the ground.
 */
function buildRoadGeometry(gen: GeneratedWorld): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const step = 3.2;

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

    const half = width / 2;
    // Ribbons are trimmed at junctions so they never overlap — one shared
    // lift keeps every street, dash and junction in the same plane. Only
    // untrimmed legacy worlds still need the anti-z-fight stagger.
    const lift = gen.junctions?.length ? 0.12 : 0.1 + (p % 5) * 0.016;
    const vScale = 1 / (width * 2); // one texture tile per 2×width meters
    const base = positions.length / 3;
    let v = 0;

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
      const y = gen.heightAt(cx, cz) + lift;
      positions.push(cx - nx * w, y, cz - nz * w, cx + nx * w, y, cz + nz * w);
      uvs.push(0, v, 1, v);
    }
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

/**
 * Junction fill: one draped polygon per intersection, fanned from its
 * center to the ring of trimmed ribbon-end corners. It sits a hair below
 * the ribbons and tucks under their ends, so the network reads as one
 * continuous paved surface with lane dashes stopping at the junction.
 */
function buildJunctionGeometry(gen: GeneratedWorld): THREE.BufferGeometry | null {
  const junctions = (gen.junctions ?? []).filter((j) => j.ring && j.ring.length >= 3);
  if (junctions.length === 0) return null;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let ji = 0; ji < junctions.length; ji++) {
    const j = junctions[ji];
    // Just below the ribbons' 0.12, micro-staggered so two junction fills
    // meeting side by side never z-fight.
    const LIFT = 0.098 + (ji % 5) * 0.003;
    const base = positions.length / 3;
    positions.push(j.x, gen.heightAt(j.x, j.z) + LIFT, j.z);
    uvs.push(0.5, 0.5);
    const n = j.ring.length;
    for (const [x, z] of j.ring) {
      positions.push(x, gen.heightAt(x, z) + LIFT, z);
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
  const geometry = useMemo(() => buildRoadGeometry(gen), [gen]);
  const junctionGeometry = useMemo(() => buildJunctionGeometry(gen), [gen]);
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
    },
    [geometry, junctionGeometry],
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
    </group>
  );
}
