'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VEGETATION_STYLES } from '@/config/constants';
import { mulberry32 } from '@/lib/rng';
import { createSurfaceTexture } from './textures';
import type { GeneratedWorld, WorldState } from '@/types/world';

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const yAxis = new THREE.Vector3(0, 1, 0);

/** Uneven branch whorls taper into a narrow conifer leader. */
function buildConiferGeometry(): THREE.BufferGeometry {
  const tiers: THREE.BufferGeometry[] = [];
  for (let tier = 0; tier < 7; tier++) {
    const radius = 0.56 * (1 - tier / 8);
    const g = new THREE.ConeGeometry(radius, 0.48, 13, 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const angle = Math.atan2(p.getZ(i), p.getX(i));
      const uneven = 1 + Math.sin(angle * 5 + tier * 2) * 0.13 + Math.cos(angle * 9) * 0.05;
      p.setXYZ(
        i,
        p.getX(i) * uneven,
        p.getY(i) + Math.sin(angle * 5 + tier) * 0.025,
        p.getZ(i) * uneven,
      );
    }
    g.rotateY(tier * 2.4);
    g.translate(Math.sin(tier * 2) * 0.025, 0.42 + tier * 0.17, 0);
    g.computeVertexNormals();
    tiers.push(g);
  }
  const merged = mergeGeometries(tiers)!;
  tiers.forEach((t) => t.dispose());
  return canopyTones(merged);
}

/** Overlapping, irregular leaf clusters leave a broken crown outline. */
function buildBroadleafGeometry(): THREE.BufferGeometry {
  const rng = mulberry32(479);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 15; i++) {
    const angle = i * 2.39996;
    const radial = i < 10 ? 0.36 + rng() * 0.19 : 0.18;
    const g = new THREE.IcosahedronGeometry(0.27 + rng() * 0.13, 1);
    const p = g.attributes.position;
    for (let j = 0; j < p.count; j++) {
      const x = p.getX(j),
        y = p.getY(j),
        z = p.getZ(j);
      const r = 1 + 0.09 * Math.sin(x * 37 + z * 23) * Math.cos(y * 31);
      p.setXYZ(j, x * r, y * r * 0.88, z * r);
    }
    g.translate(
      Math.cos(angle) * radial,
      0.67 + (i / 15) * 0.4 + rng() * 0.12,
      Math.sin(angle) * radial,
    );
    parts.push(g);
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return canopyTones(merged);
}

/** Small spatial variations read as foliage, with darker sheltered undersides. */
function canopyTones(g: THREE.BufferGeometry) {
  const p = g.attributes.position;
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const grain = Math.sin(p.getX(i) * 41 + p.getZ(i) * 29) * Math.cos(p.getY(i) * 37);
    const light = 0.72 + Math.min(1, Math.max(0, p.getY(i))) * 0.23 + grain * 0.065;
    colors.set([light * 0.96, light, light * 0.9], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function buildPalmGeometry() {
  const points: number[] = [];
  // Arched fronds with paired, tapered leaflets and open sky between them.
  for (let f = 0; f < 10; f++) {
    const angle = f * 2.39996;
    const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (let j = 1; j < 13; j++) {
      const t = j / 13;
      const center = dir.clone().multiplyScalar(t * 1.25);
      center.y = Math.sin(t * Math.PI) * 0.27 - t * t * 0.26;
      for (const sign of [-1, 1]) {
        const tip = center
          .clone()
          .addScaledVector(side, sign * Math.sin(t * Math.PI) * 0.31)
          .addScaledVector(dir, 0.14);
        tip.y -= 0.08;
        const base = center.clone().addScaledVector(dir, 0.085);
        points.push(...center.toArray(), ...tip.toArray(), ...base.toArray());
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.computeVertexNormals();
  return canopyTones(g);
}

export function Vegetation({ gen, world }: { gen: GeneratedWorld; world: WorldState }) {
  const styleDef = VEGETATION_STYLES[world.vegetation.style];
  const palm = world.vegetation.style === 'palm';
  const bark = useMemo(() => createSurfaceTexture('bark'), []);
  useEffect(() => () => bark.dispose(), [bark]);
  const conifers = useMemo(() => gen.trees.filter((t) => t.kind === 0), [gen]);
  const broadleaf = useMemo(() => gen.trees.filter((t) => t.kind === 1), [gen]);

  const trunkGeo = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.075, 0.15, 1, 9, 3);
    g.translate(0, 0.5, 0);
    if (palm) return g;
    const parts: THREE.BufferGeometry[] = [g];
    for (let i = 0; i < 5; i++) {
      const angle = i * 2.39996;
      const start = new THREE.Vector3(0, 0.45 + i * 0.07, 0);
      const end = new THREE.Vector3(
        Math.cos(angle) * 0.42,
        0.83 + i * 0.025,
        Math.sin(angle) * 0.42,
      );
      const axis = end.clone().sub(start);
      const branch = new THREE.CylinderGeometry(0.02, 0.06, axis.length(), 6);
      branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(yAxis, axis.normalize()));
      branch.translate(...start.add(end).multiplyScalar(0.5).toArray());
      parts.push(branch);
    }
    const merged = mergeGeometries(parts)!;
    parts.forEach((part) => part.dispose());
    return merged;
  }, [palm]);
  const coniferGeo = useMemo(buildConiferGeometry, []);
  const broadGeo = useMemo(() => (palm ? buildPalmGeometry() : buildBroadleafGeometry()), [palm]);

  useEffect(
    () => () => {
      trunkGeo.dispose();
      coniferGeo.dispose();
      broadGeo.dispose();
    },
    [trunkGeo, coniferGeo, broadGeo],
  );

  const trunksRef = useRef<THREE.InstancedMesh>(null);
  const conesRef = useRef<THREE.InstancedMesh>(null);
  const blobsRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const trunks = trunksRef.current;
    if (trunks) {
      for (let i = 0; i < gen.trees.length; i++) {
        const t = gen.trees[i];
        tmpQuat.setFromAxisAngle(yAxis, t.tint * Math.PI * 2);
        tmpPos.set(t.x, t.y - 0.15, t.z);
        const trunkH = (palm ? 4.8 : t.kind === 0 ? 2.8 : 2.6) * t.scale;
        tmpScale.set(t.scale, trunkH, t.scale);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
        trunks.setMatrixAt(i, tmpMatrix);
      }
      trunks.instanceMatrix.needsUpdate = true;
      trunks.computeBoundingSphere();
    }

    const fill = (
      mesh: THREE.InstancedMesh | null,
      trees: typeof gen.trees,
      place: (t: (typeof gen.trees)[number]) => void,
    ) => {
      if (!mesh) return;
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        place(t);
        mesh.setMatrixAt(i, tmpMatrix);
        tmpColor.set(
          styleDef.canopy[Math.floor(t.tint * styleDef.canopy.length) % styleDef.canopy.length],
        );
        tmpColor.multiplyScalar(0.91 + t.tint * 0.16);
        mesh.setColorAt(i, tmpColor);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    };

    fill(conesRef.current, conifers, (t) => {
      tmpQuat.setFromAxisAngle(yAxis, t.tint * Math.PI * 2);
      tmpPos.set(t.x, t.y - 0.1, t.z);
      tmpScale.set((2.5 + t.tint * 0.4) * t.scale, (3.8 + t.tint * 0.7) * t.scale, 2.6 * t.scale);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    });
    fill(blobsRef.current, broadleaf, (t) => {
      tmpQuat.setFromAxisAngle(yAxis, t.tint * Math.PI * 2);
      tmpPos.set(t.x, t.y + (palm ? 4.65 : 0.9) * t.scale, t.z);
      tmpScale.set(
        (2.3 + t.tint * 0.4) * t.scale,
        (palm ? 2 : 2.6) * t.scale * (0.9 + t.tint * 0.25),
        2.4 * t.scale,
      );
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    });
  }, [gen, conifers, broadleaf, styleDef, palm]);

  if (gen.trees.length === 0) return null;

  return (
    <group name="vegetation">
      <instancedMesh
        key={`t-${gen.key}`}
        ref={trunksRef}
        args={[trunkGeo, undefined, gen.trees.length]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color={styleDef.trunk}
          map={bark}
          bumpMap={bark}
          bumpScale={0.045}
          roughness={0.97}
        />
      </instancedMesh>
      {conifers.length > 0 && (
        <instancedMesh
          key={`c-${gen.key}-${world.vegetation.style}`}
          ref={conesRef}
          args={[coniferGeo, undefined, conifers.length]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial vertexColors roughness={0.91} />
        </instancedMesh>
      )}
      {broadleaf.length > 0 && (
        <instancedMesh
          key={`b-${gen.key}-${world.vegetation.style}`}
          ref={blobsRef}
          args={[broadGeo, undefined, broadleaf.length]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial
            vertexColors
            roughness={0.91}
            side={palm ? THREE.DoubleSide : THREE.FrontSide}
          />
        </instancedMesh>
      )}
    </group>
  );
}
