'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { TERRAIN_PALETTES } from '@/config/constants';
import { SimplexNoise } from '@/lib/noise';
import type { GeneratedWorld, WorldState } from '@/types/world';
import { createDetailTexture } from './textures';

const hexToColor = (hex: string) => new THREE.Color(hex);

export function Terrain({ gen, world }: { gen: GeneratedWorld; world: WorldState }) {
  const detail = useMemo(() => {
    const tex = createDetailTexture(2027);
    tex.repeat.set(140, 140);
    return tex;
  }, []);
  useEffect(() => () => detail.dispose(), [detail]);

  const geometry = useMemo(() => {
    const { size, res, heights, waterLevel } = gen;
    const geo = new THREE.PlaneGeometry(size, size, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i]);
    geo.computeVertexNormals();

    const stops = TERRAIN_PALETTES[world.terrain.style].stops.map(hexToColor);
    const rock = stops[3];
    const dry = hexToColor('#a89a68');
    const amp = Math.max(1, world.terrain.amplitude);
    const normals = geo.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const patches = new SimplexNoise(world.seed ^ 0x5eed);

    for (let i = 0; i < pos.count; i++) {
      const h = heights[i];
      const gx = i % res;
      const gz = Math.floor(i / res);
      if (h < waterLevel) {
        // Underwater bed — darkened sand.
        c.copy(stops[0]).multiplyScalar(0.78);
      } else {
        const t = Math.min(0.999, Math.max(0, (h - waterLevel) / Math.max(1, amp - waterLevel)));
        const seg = t * (stops.length - 1);
        const i0 = Math.floor(seg);
        c.copy(stops[i0]).lerp(stops[Math.min(stops.length - 1, i0 + 1)], seg - i0);
        // Broad moisture patches keep the grass from reading as one flat sheet.
        const m = patches.fbm((gx / res) * 5.2, (gz / res) * 5.2, 3);
        if (t < 0.6 && m < 0.05) c.lerp(dry, Math.min(1, (0.05 - m) * 1.6) * 0.4);
        // Steep faces read as rock.
        const slope = 1 - normals.getY(i);
        if (slope > 0.25) c.lerp(rock, Math.min(1, (slope - 0.25) * 2.4));
        // Fine per-vertex tonal jitter.
        const jitter = 0.95 + ((gx * 7 + gz * 13) % 11) * 0.009;
        c.multiplyScalar(jitter);
        // Damp sediment softens the transition from the river bed to dry vegetation.
        const bank = Math.max(0, 1 - (h - waterLevel) / 1.25);
        if (world.water.enabled && bank > 0)
          c.lerp(stops[0].clone().multiplyScalar(0.72), bank * 0.7);
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [gen, world.terrain.style, world.terrain.amplitude, world.seed, world.water.enabled]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} name="terrain" receiveShadow>
      <meshStandardMaterial
        vertexColors
        map={detail}
        bumpMap={detail}
        bumpScale={0.018}
        roughness={0.96}
        metalness={0}
      />
    </mesh>
  );
}
