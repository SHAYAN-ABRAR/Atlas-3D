'use client';

import { GizmoHelper, GizmoViewport, Grid } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useControls } from 'leva';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { QUALITY_LEVELS } from '@/config/constants';
import { on, viewportRuntime } from '@/lib/bus';
import { AdaptiveQuality } from '@/lib/render-quality';
import { generateWorld } from '@/lib/worldgen';
import { captureScreenshot, exportGLTF, exportOBJ } from '@/services/exporters';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { Atmosphere } from './atmosphere';
import { Buildings } from './buildings';
import { CameraRig } from './camera-rig';
import { Particles } from './particles';
import { Roads } from './roads';
import { Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { Water } from './water';

function PerfTracker() {
  const gl = useThree((s) => s.gl);
  const adaptive = useRef(new AdaptiveQuality());

  // Accumulate render info across the whole frame (main pass + gizmo pass),
  // reading it at the start of the next one.
  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);

  useFrame((_, delta) => {
    const fps = 1 / Math.max(delta, 1e-4);
    viewportRuntime.fps = viewportRuntime.fps * 0.92 + fps * 0.08;
    viewportRuntime.frameMs = viewportRuntime.frameMs * 0.92 + delta * 1000 * 0.08;
    viewportRuntime.drawCalls = gl.info.render.calls;
    viewportRuntime.triangles = gl.info.render.triangles;
    gl.info.reset();

    const { autoQuality, quality, set } = useUIStore.getState();
    const next = adaptive.current.sample(
      delta,
      viewportRuntime.fps,
      quality,
      autoQuality,
      !document.hidden,
    );
    if (next) {
      set({ quality: next });
      useProjectStore
        .getState()
        .log('warn', `Sustained low FPS — auto quality stepped down to “${next}”`);
    }
  });
  return null;
}

/** Imperative requests (screenshot, exports) that need gl/scene access. */
function ViewportBus({ worldRef }: { worldRef: React.RefObject<THREE.Group> }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const log = (level: 'info' | 'success' | 'error', msg: string) =>
      useProjectStore.getState().log(level, msg);
    const name = () =>
      useProjectStore
        .getState()
        .name.replace(/[^\w\- ]+/g, '')
        .trim() || 'world';
    const offs = [
      on('viewport:screenshot', async () => {
        try {
          await captureScreenshot(gl.domElement, `${name()}.png`);
          log('success', 'Screenshot saved');
        } catch (err) {
          log('error', `Screenshot failed: ${String(err)}`);
        }
      }),
      on('export:gltf', async () => {
        if (!worldRef.current) return;
        log('info', 'Baking scene to GLB…');
        try {
          await exportGLTF(worldRef.current, `${name()}.glb`);
          log('success', 'Exported GLB');
        } catch (err) {
          log('error', `GLB export failed: ${String(err)}`);
        }
      }),
      on('export:obj', () => {
        if (!worldRef.current) return;
        log('info', 'Baking scene to OBJ…');
        try {
          exportOBJ(worldRef.current, `${name()}.obj`);
          log('success', 'Exported OBJ');
        } catch (err) {
          log('error', `OBJ export failed: ${String(err)}`);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [gl, worldRef]);
  return null;
}

/** Leva-driven advanced tuning (hidden unless enabled in the command palette). */
function ViewportTuning() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const { fieldOfView } = useControls('Camera', {
    fieldOfView: { value: 50, min: 28, max: 95, step: 1 },
  });
  useEffect(() => {
    camera.fov = fieldOfView;
    camera.updateProjectionMatrix();
  }, [fieldOfView, camera]);
  return null;
}

export default function Viewport() {
  const world = useProjectStore((s) => s.world);
  const showGrid = useUIStore((s) => s.showGrid);
  const showGizmo = useUIStore((s) => s.showGizmo);
  const quality = useUIStore((s) => s.quality);
  const layers = useUIStore((s) => s.layers);
  const q = QUALITY_LEVELS[quality];
  const worldRef = useRef<THREE.Group>(null);

  const gen = useMemo(() => generateWorld(world), [world]);

  return (
    <div id="viewport-canvas-wrap" className="absolute inset-0">
      <Canvas
        shadows
        dpr={[1, q.dpr]}
        gl={{
          antialias: true,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
        }}
        camera={{ fov: 50, near: 0.5, far: 4000, position: [190, 150, 190] }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
        }}
      >
        <Atmosphere world={world} />
        <group ref={worldRef} name="atlas-world">
          {layers.terrain && <Terrain gen={gen} world={world} />}
          {layers.water && world.water.enabled && <Water gen={gen} world={world} />}
          {layers.roads && <Roads gen={gen} world={world} />}
          {layers.buildings && <Buildings gen={gen} world={world} />}
          {layers.vegetation && <Vegetation gen={gen} world={world} />}
        </group>
        {layers.effects && <Particles mode={world.effects.particles} />}
        {showGrid && (
          <Grid
            position={[0, gen.waterLevel + 0.3, 0]}
            args={[10, 10]}
            infiniteGrid
            cellSize={10}
            cellThickness={0.55}
            cellColor="#5a5f66"
            sectionSize={50}
            sectionThickness={1}
            sectionColor="#767c85"
            fadeDistance={620}
            fadeStrength={1.6}
            userData={{ helper: true }}
          />
        )}
        <CameraRig gen={gen} waterEnabled={world.water.enabled && layers.water} />
        {showGizmo && (
          <GizmoHelper alignment="top-right" margin={[52, 52]}>
            <GizmoViewport
              axisColors={['#c26e5a', '#7d9b6a', '#6a84a8']}
              labelColor="#c9ccd1"
              hideNegativeAxes
            />
          </GizmoHelper>
        )}
        <PerfTracker />
        <ViewportBus worldRef={worldRef} />
        <ViewportTuning />
      </Canvas>
    </div>
  );
}
