'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDING_STYLES, LIGHTING_PRESETS, MATERIAL_OVERRIDES } from '@/config/constants';
import type { BuildingInstance, GeneratedWorld, WorldState } from '@/types/world';
import { createFacadeTextures, createSurfaceTexture } from './textures';

function merge(parts: THREE.BufferGeometry[]) {
  if (!parts.length) return new THREE.BufferGeometry();
  const geometry = mergeGeometries(parts)!;
  parts.forEach((part) => part.dispose());
  return geometry;
}

/** Batch architecture with ordinary UVs so its detail also survives scene export. */
function place(geo: THREE.BufferGeometry, b: BuildingInstance, color: string) {
  geo.rotateY(b.rotation);
  geo.translate(b.x, b.y, b.z);
  const c = new THREE.Color(color);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

export function Buildings({ gen, world }: { gen: GeneratedWorld; world: WorldState }) {
  const style = BUILDING_STYLES[world.city.style];
  const override =
    world.materials.override !== 'none' ? MATERIAL_OVERRIDES[world.materials.override] : null;
  const facade = useMemo(
    () =>
      createFacadeTextures(
        style.roofType === 'flat' ? 'tower' : 'cottage',
        913,
        world.city.style === 'nordic'
          ? 'timber'
          : world.city.style === 'medieval' || world.city.style === 'industrial'
            ? 'masonry'
            : 'plaster',
      ),
    [style.roofType, world.city.style],
  );
  const roofMap = useMemo(() => createSurfaceTexture('roof'), []);
  useEffect(() => () => Object.values(facade).forEach((tex) => tex.dispose()), [facade]);
  useEffect(() => () => roofMap.dispose(), [roofMap]);

  const geometry = useMemo(() => {
    const walls: THREE.BufferGeometry[] = [];
    const roofs: THREE.BufferGeometry[] = [];
    const trim: THREE.BufferGeometry[] = [];
    const doors: THREE.BufferGeometry[] = [];
    const wallColors = override?.walls ?? style.walls;
    const roofColors = override?.roofs ?? style.roofs;
    for (const b of gen.buildings) {
      const wall = wallColors[b.colorIndex % wallColors.length];
      const roof = roofColors[b.colorIndex % roofColors.length];
      const box = (
        w: number,
        h: number,
        d: number,
        x: number,
        y: number,
        z: number,
        color: string,
        target: THREE.BufferGeometry[],
      ) => {
        // Non-indexed geometry permits batching with extruded pitched roofs.
        const g = new THREE.BoxGeometry(w, h, d);
        const part = g.toNonIndexed();
        g.dispose();
        if (target === roofs) {
          const uv = part.attributes.uv;
          for (let face = 0; face < 6; face++) {
            const width = face < 2 ? d : w;
            const height = face === 2 || face === 3 ? d : h;
            for (let j = 0; j < 6; j++) {
              const i = face * 6 + j;
              uv.setXY(i, (uv.getX(i) * width) / 3, (uv.getY(i) * height) / 3);
            }
          }
        }
        part.translate(x, y, z);
        target.push(place(part, b, color));
      };
      const body = new THREE.BoxGeometry(b.w, b.h, b.d);
      const uv = body.attributes.uv;
      // Complete window bays per face and one row per real floor.
      for (let face = 0; face < 6; face++) {
        const bays = Math.max(1, Math.round((face < 2 ? b.d : b.w) / 3));
        for (let j = 0; j < 4; j++) {
          const i = face * 4 + j;
          uv.setXY(
            i,
            (uv.getX(i) * bays) / 2,
            uv.getY(i) * Math.max(1, Math.round(b.h / style.floorHeight)),
          );
        }
      }
      body.translate(0, b.h / 2, 0);
      walls.push(place(body, b, wall));
      // A plinth grounds the walls; cornices and entrance lintels cast real shadows.
      box(b.w + 0.12, 0.5, b.d + 0.12, 0, 0.06, 0, '#827c70', trim);
      box(b.w + 0.25, 0.18, b.d + 0.25, 0, b.h - 0.04, 0, wall, trim);
      box(1.1, 2.1, 0.08, 0, 1.22, b.d / 2 + 0.055, '#45433d', doors);
      box(1.45, 0.16, 0.75, 0, 0.19, b.d / 2 + 0.27, '#a29c8f', trim);
      box(1.35, 0.13, 0.45, 0, 2.34, b.d / 2 + 0.16, wall, trim);

      if (style.roofType === 'flat') {
        box(b.w, 0.16, b.d, 0, b.h + 0.04, 0, roof, roofs);
        for (const side of [-1, 1]) {
          box(b.w + 0.12, 0.48, 0.18, 0, b.h + 0.24, (side * b.d) / 2, wall, trim);
          box(0.18, 0.48, b.d, (side * b.w) / 2, b.h + 0.24, 0, wall, trim);
        }
        if (b.w > 5 && b.d > 5) {
          box(
            Math.min(2.2, b.w * 0.22),
            0.65,
            Math.min(2.7, b.d * 0.25),
            b.w * 0.16,
            b.h + 0.45,
            -b.d * 0.16,
            '#828681',
            trim,
          );
        }
      } else {
        const roofH = Math.min(b.w, b.d) * (style.roofType === 'pagoda' ? 0.28 : 0.36);
        if (style.roofType === 'pagoda') {
          const cone = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 4);
          // Slightly flared lower courses give traditional hips a restrained eave curve.
          const p = cone.attributes.position;
          for (let i = 0; i < p.count; i++) {
            const t = p.getY(i) + 0.5;
            const flare = 0.86 + 0.14 * Math.pow(1 - t, 3);
            p.setXYZ(i, p.getX(i) * flare, p.getY(i), p.getZ(i) * flare);
          }
          cone.computeVertexNormals();
          const g = cone.toNonIndexed();
          cone.dispose();
          g.rotateY(Math.PI / 4);
          g.scale(b.w + 1.2, roofH, b.d + 1.2);
          g.translate(0, b.h + roofH / 2, 0);
          roofs.push(place(g, b, roof));
        } else {
          const w = b.w / 2;
          const d = b.d / 2;
          const shape = new THREE.Shape();
          shape.moveTo(-w, 0);
          shape.lineTo(w, 0);
          shape.lineTo(0, roofH);
          shape.closePath();
          const g = new THREE.ExtrudeGeometry(shape, {
            depth: d * 2,
            bevelEnabled: false,
            steps: 1,
          });
          const roofUV = g.attributes.uv;
          for (let i = 0; i < roofUV.count; i++)
            roofUV.setXY(i, roofUV.getX(i) / 3, roofUV.getY(i) / 3);
          g.translate(0, b.h, -d);
          // The gable end is wall construction; tiles sit on the two pitched surfaces.
          trim.push(place(g, b, wall));
          const pitch = Math.atan2(roofH, w);
          for (const side of [-1, 1]) {
            const panel = new THREE.BoxGeometry(Math.hypot(w, roofH) + 0.45, 0.14, b.d + 0.7);
            const uv = panel.attributes.uv;
            for (let i = 0; i < uv.count; i++)
              uv.setXY(i, (uv.getX(i) * Math.hypot(w, roofH)) / 3, (uv.getY(i) * (b.d + 0.7)) / 3);
            panel.rotateZ(-side * pitch);
            panel.translate((side * w) / 2, b.h + roofH / 2 + 0.07, 0);
            const part = panel.toNonIndexed();
            panel.dispose();
            roofs.push(place(part, b, roof));
          }
          box(
            0.65,
            roofH * 0.65 + 0.65,
            0.7,
            b.w * 0.23,
            b.h + roofH * 0.68,
            -b.d * 0.2,
            '#898174',
            trim,
          );
        }
      }
    }
    return { walls: merge(walls), roofs: merge(roofs), trim: merge(trim), doors: merge(doors) };
  }, [gen, style, override]);
  useEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);
  if (!gen.buildings.length) return null;

  return (
    <group name="buildings">
      <mesh name="facades" geometry={geometry.walls} castShadow receiveShadow>
        <meshStandardMaterial
          vertexColors
          map={facade.map}
          bumpMap={facade.bump}
          bumpScale={0.055}
          roughnessMap={facade.roughness}
          roughness={override?.roughness ?? 0.88}
          metalness={override?.metalness ?? style.metalness}
          emissiveMap={facade.emissive}
          emissive={style.windowColor}
          emissiveIntensity={LIGHTING_PRESETS[world.lighting.preset].windowGlow}
        />
      </mesh>
      <mesh name="roofs" geometry={geometry.roofs} castShadow receiveShadow>
        <meshStandardMaterial
          vertexColors
          map={roofMap}
          bumpMap={roofMap}
          bumpScale={0.07}
          roughness={override?.roughness ?? 0.88}
          metalness={override?.metalness ?? 0.04}
        />
      </mesh>
      <mesh name="architectural-details" geometry={geometry.trim} castShadow receiveShadow>
        <meshStandardMaterial
          vertexColors
          roughness={override?.roughness ?? 0.85}
          metalness={override?.metalness ?? 0.02}
        />
      </mesh>
      <mesh name="entrances" geometry={geometry.doors} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.58} />
      </mesh>
    </group>
  );
}
