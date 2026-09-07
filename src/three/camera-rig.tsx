'use client';

import { OrbitControls, PointerLockControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { on, viewportRuntime } from '@/lib/bus';
import { useUIStore } from '@/stores/ui-store';
import type { GeneratedWorld } from '@/types/world';

const EYE_HEIGHT = 1.75;
const GRAVITY = 26;
const FLY_DURATION = 55; // seconds per loop

function isTyping(e: KeyboardEvent | Event): boolean {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  );
}

export function CameraRig({
  gen,
  waterEnabled = true,
}: {
  gen: GeneratedWorld;
  waterEnabled?: boolean;
}) {
  const mode = useUIStore((s) => s.cameraMode);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const orbitRef = useRef<OrbitControlsImpl>(null);
  const keys = useRef<Set<string>>(new Set());
  const inputActive = useRef(false);
  const velY = useRef(0);
  const [flying, setFlying] = useState(false);
  const flyT = useRef(0);
  const surfaceAt = useMemo(
    () => (x: number, z: number) =>
      Math.max(gen.heightAt(x, z), waterEnabled ? gen.waterLevel : -Infinity),
    [gen, waterEnabled],
  );

  const maxHeight = useMemo(() => {
    let m = 0;
    for (let i = 0; i < gen.heights.length; i += 7) m = Math.max(m, gen.heights[i]);
    return m;
  }, [gen]);

  const flyCurve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = gen.size * (i % 2 === 0 ? 0.4 : 0.26);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = surfaceAt(x, z) + 26 + (i % 3) * 14 + maxHeight * 0.35;
      pts.push(new THREE.Vector3(x, y, z));
    }
    return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.6);
  }, [gen, maxHeight, surfaceAt]);

  // Keyboard movement follows viewport focus. Pointer lock is only for mouse look.
  useEffect(() => {
    const canvas = gl.domElement;
    const previousTabIndex = canvas.tabIndex;
    canvas.tabIndex = 0;
    const activate = () => {
      inputActive.current = true;
      canvas.focus({ preventScroll: true });
    };
    const deactivate = () => {
      inputActive.current = false;
      keys.current.clear();
    };
    const outside = (e: Event) => {
      if (e.target !== canvas) deactivate();
    };
    const down = (e: KeyboardEvent) => {
      if (
        isTyping(e) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (!inputActive.current && !document.pointerLockElement)
      )
        return;
      if (e.code === 'Escape') {
        deactivate();
        return;
      }
      if (
        [
          'Space',
          'KeyW',
          'KeyA',
          'KeyS',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
        ].includes(e.code)
      )
        e.preventDefault();
      keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const lockChanged = () => {
      keys.current.clear();
    };
    canvas.addEventListener('pointerdown', activate);
    canvas.addEventListener('focus', activate);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', deactivate);
    document.addEventListener('pointerlockchange', lockChanged);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', deactivate);
      document.removeEventListener('pointerlockchange', lockChanged);
      canvas.removeEventListener('pointerdown', activate);
      canvas.removeEventListener('focus', activate);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      canvas.tabIndex = previousTabIndex;
    };
  }, [gl]);

  // Imperative camera events.
  useEffect(() => {
    const offs = [
      on('camera:pose', ({ position, target }) => {
        camera.position.set(...position);
        camera.lookAt(...target);
        velY.current = 0;
        orbitRef.current?.target.set(...target);
        orbitRef.current?.update();
      }),
      on('camera:frame', () => {
        const d = gen.size * 0.52;
        camera.position.set(d, Math.max(80, maxHeight * 1.9), d);
        camera.lookAt(0, Math.max(6, maxHeight * 0.2), 0);
        velY.current = 0;
        orbitRef.current?.target.set(0, Math.max(6, maxHeight * 0.2), 0);
        orbitRef.current?.update();
      }),
      on('minimap:teleport', ({ x, z }) => {
        const ground = surfaceAt(x, z);
        velY.current = 0;
        if (useUIStore.getState().cameraMode === 'orbit' && orbitRef.current) {
          const offset = camera.position.clone().sub(orbitRef.current.target);
          orbitRef.current.target.set(x, ground, z);
          camera.position.copy(orbitRef.current.target).add(offset);
          orbitRef.current.update();
        } else {
          camera.position.set(x, ground + EYE_HEIGHT, z);
        }
      }),
      on('camera:flythrough', () => {
        flyT.current = 0;
        setFlying(true);
        viewportRuntime.flythrough = true;
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [camera, gen, maxHeight, surfaceAt]);

  // Any deliberate input ends the cinematic.
  useEffect(() => {
    if (!flying) return;
    const stop = () => {
      setFlying(false);
      viewportRuntime.flythrough = false;
    };
    const key = (e: KeyboardEvent) => {
      if (!isTyping(e)) stop();
    };
    const dom = gl.domElement;
    dom.addEventListener('pointerdown', stop);
    dom.addEventListener('wheel', stop);
    window.addEventListener('keydown', key);
    return () => {
      dom.removeEventListener('pointerdown', stop);
      dom.removeEventListener('wheel', stop);
      window.removeEventListener('keydown', key);
    };
  }, [flying, gl]);

  // Ground the camera when entering walk mode.
  useEffect(() => {
    keys.current.clear();
    if (mode === 'walk') {
      const g = surfaceAt(camera.position.x, camera.position.z);
      camera.position.y = g + EYE_HEIGHT;
      velY.current = 0;
    }
  }, [mode, camera, surfaceAt]);

  const fwd = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const UP = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const move = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);

    if (flying) {
      flyT.current += delta / FLY_DURATION;
      const t = flyT.current % 1;
      const pos = flyCurve.getPointAt(t);
      camera.position.lerp(pos, Math.min(1, delta * 4 + 0.02));
      const ahead = flyCurve.getPointAt((t + 0.025) % 1);
      ahead.lerp(new THREE.Vector3(0, maxHeight * 0.3, 0), 0.35);
      camera.lookAt(ahead);
    } else if (inputActive.current || document.pointerLockElement === gl.domElement) {
      const k = keys.current;
      camera.getWorldDirection(fwd);
      if (mode !== 'fly') {
        fwd.y = 0;
        fwd.normalize();
      }
      right.crossVectors(fwd, UP).normalize();
      const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
      const speed = (mode === 'orbit' ? 38 : mode === 'fly' ? 46 : 12) * (sprint ? 2.4 : 1);
      move.set(0, 0, 0);
      if (k.has('KeyW') || k.has('ArrowUp')) move.add(fwd);
      if (k.has('KeyS') || k.has('ArrowDown')) move.sub(fwd);
      if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * delta);
      if (mode === 'orbit') {
        const limit = gen.size * 0.75;
        move.x =
          THREE.MathUtils.clamp(camera.position.x + move.x, -limit, limit) - camera.position.x;
        move.z =
          THREE.MathUtils.clamp(camera.position.z + move.z, -limit, limit) - camera.position.z;
      }
      camera.position.add(move);
      if (mode === 'orbit') {
        orbitRef.current?.target.add(move);
        orbitRef.current?.update();
      }

      if (mode === 'walk') {
        const ground = surfaceAt(camera.position.x, camera.position.z) + EYE_HEIGHT;
        const grounded = camera.position.y <= ground + 0.02;
        if (k.has('Space') && grounded) velY.current = 9.5;
        velY.current -= GRAVITY * delta;
        camera.position.y += velY.current * delta;
        if (camera.position.y < ground) {
          camera.position.y = ground;
          velY.current = 0;
        }
      } else if (mode === 'fly') {
        if (k.has('Space') || k.has('KeyE')) camera.position.y += speed * delta;
        if (k.has('KeyQ') || k.has('KeyC')) camera.position.y -= speed * delta;
      }
      // Keep inside the world bounds.
      const limit = gen.size * 0.75;
      camera.position.x = THREE.MathUtils.clamp(camera.position.x, -limit, limit);
      camera.position.z = THREE.MathUtils.clamp(camera.position.z, -limit, limit);
    }

    // Publish live pose for the minimap / status bar.
    camera.getWorldDirection(fwd);
    viewportRuntime.cameraPosition = [camera.position.x, camera.position.y, camera.position.z];
    viewportRuntime.cameraHeading = Math.atan2(fwd.x, fwd.z);
  });

  if (mode === 'orbit') {
    return (
      <OrbitControls
        ref={orbitRef}
        makeDefault
        enabled={!flying}
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2 - 0.01}
        minDistance={4}
        maxDistance={900}
        target={[0, 8, 0]}
      />
    );
  }
  return (
    <PointerLockControls
      makeDefault
      domElement={gl.domElement}
      selector="#viewport-canvas-wrap canvas"
    />
  );
}
