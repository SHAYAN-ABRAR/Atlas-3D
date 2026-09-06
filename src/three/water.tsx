'use client';

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GeneratedWorld, WorldState } from '@/types/world';

const WATER_COLORS: Record<string, string> = {
  cyberpunk: '#0d1b2e',
  night: '#0c1a2a',
  rain: '#22333d',
  overcast: '#31424d',
};

export function Water({ gen, world }: { gen: GeneratedWorld; world: WorldState }) {
  const color = WATER_COLORS[world.lighting.preset] ?? '#426c70';
  const time = useMemo(() => ({ value: 0 }), []);
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(gen.size * 1.35, gen.size * 1.35, gen.res - 1, gen.res - 1);
    geo.rotateX(-Math.PI / 2);
    const positions = geo.attributes.position;
    const depths = new Float32Array(positions.count);
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      depths[i] =
        Math.abs(x) > gen.size / 2 || Math.abs(z) > gen.size / 2
          ? 12
          : gen.waterLevel - gen.heightAt(x, z);
    }
    geo.setAttribute('waterDepth', new THREE.BufferAttribute(depths, 1));
    return geo;
  }, [gen]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(() => {
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      roughness: 0.24,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
      depthWrite: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.waterTime = time;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nattribute float waterDepth; varying float vWaterDepth; varying vec2 vWaterPosition;',
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWaterDepth = waterDepth; vWaterPosition = position.xz;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform float waterTime; varying float vWaterDepth; varying vec2 vWaterPosition;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (vWaterDepth < 0.015) discard;
        float depthBlend = 1.0 - exp(-max(vWaterDepth, 0.0) * 0.3);
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(1.28, 1.19, 0.92), diffuseColor.rgb * 0.72, depthBlend);
        diffuseColor.a *= mix(0.24, 0.97, depthBlend);
        `,
      );
      // Advect intersecting capillary ripples continuously; amplitudes fade at the bank.
      // The physical material supplies Fresnel response, sunlight and sky reflections.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec2 p = vWaterPosition;
        float t = waterTime;
        float a = dot(p, vec2(0.72, 0.36)) - t * 0.65;
        float b = dot(p, vec2(-0.48, 1.16)) - t * 0.42;
        float c = dot(p, vec2(2.8, 1.7)) - t * 1.05 + sin(a) * 0.45;
        vec2 ripple = vec2(0.72, 0.36) * cos(a) * 0.035
          + vec2(-0.48, 1.16) * cos(b) * 0.024
          + vec2(2.8, 1.7) * cos(c) * 0.009;
        ripple *= smoothstep(0.0, 1.4, vWaterDepth);
        normal = normalize(normal + mat3(viewMatrix) * vec3(-ripple.x, 0.0, -ripple.y));
        `,
      );
    };
    mat.customProgramCacheKey = () => 'atlas-water-ripples-v1';
    return mat;
  }, [color, time]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame((_, delta) => {
    time.value += Math.min(delta, 0.05);
  });

  return (
    <mesh
      name="water"
      position={[0, gen.waterLevel, 0]}
      geometry={geometry}
      material={material}
      receiveShadow
    />
  );
}
