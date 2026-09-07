import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createLoader } from './source-loader.mjs';

const load = createLoader();
const { DEFAULT_WORLD } = load('@/config/constants');
const { generateWorld } = load('@/lib/worldgen');
const { straightenWaterSpans } = load('@/lib/worldgen/bridges');
const { bakeWorldGroup, captureScreenshot } = load('@/services/exporters');
const { AdaptiveQuality, selectDetailInstances } = load('@/lib/render-quality');
const { createSaveQueue } = load('@/services/project-save');
const { useProjectStore } = load('@/stores/project-store');
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('a stale save cannot clear newer world/name/map edits or another project', () => {
  const st = useProjectStore.getState();
  st.newProject('First', { seed: 123 });
  assert.equal(useProjectStore.getState().world.seed, 123);
  const first = st.toRecord(null);
  st.updateWorld({ terrain: { amplitude: 42 } }, 'Terrain');
  st.markSaved(first);
  assert.equal(useProjectStore.getState().dirty, true);
  const second = st.toRecord(null);
  st.setName('Renamed');
  st.markSaved(second);
  assert.equal(useProjectStore.getState().dirty, true);
  const third = st.toRecord(null);
  st.setMapImage('map-data');
  st.markSaved(third);
  assert.equal(useProjectStore.getState().dirty, true);
  const latest = st.toRecord(null);
  st.markSaved(latest);
  assert.equal(useProjectStore.getState().dirty, false);
  st.newProject('Second');
  st.markSaved(latest);
  assert.equal(useProjectStore.getState().dirty, true);
  assert.equal(useProjectStore.getState().lastSavedAt, null);
});

test('loading a project fills nested defaults and clears a previous drag snapshot', () => {
  const st = useProjectStore.getState();
  st.newProject('One');
  st.beginTransient();
  const record = {
    ...st.toRecord(null),
    id: 'loaded',
    world: { seed: 99, terrain: { amplitude: 8 } },
  };
  st.loadProject(record);
  st.endTransient('Old drag');
  const current = useProjectStore.getState();
  assert.equal(current.world.terrain.amplitude, 8);
  assert.equal(current.world.terrain.frequency, DEFAULT_WORLD.terrain.frequency);
  assert.equal(current.past.length, 0);
});

test('save queue preserves write order and recovers after failure', async () => {
  const starts = [];
  let release;
  const save = createSaveQueue(async (record) => {
    starts.push(record.id);
    if (record.id === 'first')
      await new Promise((resolve) => {
        release = resolve;
      });
    if (record.id === 'fail') throw new Error('disk full');
  });
  const first = save({ id: 'first' });
  const second = save({ id: 'second' });
  await Promise.resolve();
  assert.deepEqual(starts, ['first']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ['first', 'second']);
  await assert.rejects(save({ id: 'fail' }), /disk full/);
  await save({ id: 'retry' });
  assert.equal(starts.at(-1), 'retry');
});

test('autosave flushes outgoing projects and unmounted edits instead of losing them', async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  let setup, scheduled;
  const writes = [];
  const loader = createLoader({
    react: {
      useEffect: (effect) => {
        setup = effect;
      },
    },
    '@/stores/project-store': { useProjectStore },
    '@/lib/worldgen': { generateWorld: () => ({}) },
    '@/lib/minimap-draw': { renderThumbnail: () => null },
    '@/services/project-save': {
      saveProjectSnapshot: async (record) => {
        writes.push(record);
      },
    },
    '@/lib/utils': {
      debounce: (fn) => {
        const debounced = () => {
          scheduled = fn;
        };
        debounced.cancel = () => {
          scheduled = undefined;
        };
        return debounced;
      },
    },
  });
  let cleanup;
  try {
    useProjectStore.getState().newProject('Outgoing');
    loader('@/hooks/use-autosave').useAutosave();
    cleanup = setup();
    assert.equal(typeof scheduled, 'function', 'initial dirty project must schedule a save');
    useProjectStore.getState().setName('Outgoing edit');
    useProjectStore.getState().newProject('Incoming');
    assert.equal(writes[0].name, 'Outgoing edit');
    await Promise.resolve();
    assert.equal(useProjectStore.getState().dirty, true);
    useProjectStore.getState().setName('Incoming edit');
    cleanup();
    cleanup = null;
    assert.equal(writes.at(-1).name, 'Incoming edit');
    assert.equal(scheduled, undefined);
    await Promise.resolve();
    assert.equal(useProjectStore.getState().dirty, false);
  } finally {
    cleanup?.();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test('IndexedDB save waits for commit and rejects a late abort', async () => {
  let transaction, request;
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      request = { result: 'project-id' };
      transaction = { objectStore: () => ({ put: () => request }) };
      return transaction;
    },
  };
  const original = globalThis.indexedDB;
  globalThis.indexedDB = {
    open: () => {
      const req = { result: db };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  };
  try {
    const { putProject } = createLoader()('@/services/db');
    let settled = false;
    const save = putProject({ id: 'project-id' }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    request.onsuccess?.();
    await Promise.resolve();
    assert.equal(settled, false);
    transaction.oncomplete();
    await save;
    assert.equal(settled, true);
    const failed = putProject({ id: 'project-id' });
    const rejection = assert.rejects(failed, /quota/);
    await Promise.resolve();
    request.onsuccess?.();
    transaction.error = new Error('quota');
    transaction.onabort();
    await rejection;
  } finally {
    globalThis.indexedDB = original;
  }
});

test('world cache distinguishes map dimensions and traced road paths, but reuses cosmetic changes', () => {
  const world = structuredClone(DEFAULT_WORLD);
  world.city.density = 0.1;
  world.map = {
    enabled: true,
    analysis: {
      width: 8,
      height: 8,
      cells: Array(64).fill(0),
      sourceName: 'map',
      source: 'osm',
      coverage: { water: 0, vegetation: 0, road: 0, building: 0 },
      roadPaths: [
        {
          w: 1,
          pts: [
            [1, 2],
            [7, 2],
          ],
        },
      ],
    },
  };
  const first = generateWorld(world);
  const edited = structuredClone(world);
  edited.map.analysis.roadPaths[0].pts = [
    [1, 6],
    [7, 6],
  ];
  const second = generateWorld(edited);
  assert.notEqual(first, second);
  assert.notDeepEqual(first.roads, second.roads);
  const resized = structuredClone(world);
  resized.map.analysis.width = 16;
  resized.map.analysis.height = 4;
  assert.notEqual(generateWorld(resized), first);
  const cosmetic = structuredClone(edited);
  cosmetic.lighting.preset = 'night';
  assert.equal(generateWorld(cosmetic), second);
});

test('bridge grade and projection follow distance instead of sample indices', () => {
  const samples = [
    [0, 0],
    [1, 1],
    [2, 1],
    [10, 0],
  ];
  const heights = (x) => (x === 0 ? 2 : x === 10 ? 4 : -3);
  const original = structuredClone(samples);
  const total = Math.SQRT2 + 1 + Math.sqrt(65);
  const deck = straightenWaterSpans(samples, heights, 0, 1.1);
  near(samples[1][0], (10 * Math.SQRT2) / total);
  near(samples[2][0], (10 * (Math.SQRT2 + 1)) / total);
  near(deck[1], 2 + (2 * Math.SQRT2) / total);
  assert.deepEqual(samples[0], original[0]);
  assert.deepEqual(samples[3], original[3]);
  assert.equal(deck[0], null);
  assert.equal(deck[3], null);
  const submerged = [
    [0, 0],
    [2, 1],
    [6, 0],
  ];
  const levels = straightenWaterSpans(submerged, () => -4, 0, 1.1);
  assert.ok(levels.every((y) => y === 1.1));
  assert.deepEqual(submerged[0], [0, 0]);
  assert.deepEqual(submerged[2], [6, 0]);
});

test('instance export multiplies tint and vertex colors, preserves transforms, and leaves source untouched', () => {
  const root = new THREE.Group();
  root.position.x = 10;
  const geometry = new THREE.BoxGeometry();
  const colors = new Float32Array(geometry.attributes.position.count * 3).fill(0.5);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(2, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(5, 0, 0));
  mesh.setColorAt(0, new THREE.Color().setRGB(0.2, 0.4, 0.6));
  mesh.setColorAt(1, new THREE.Color().setRGB(0.8, 0.6, 0.4));
  root.add(mesh);
  const baked = bakeWorldGroup(root).children[0];
  near(baked.geometry.attributes.color.getX(0), 0.1);
  near(baked.geometry.attributes.color.getZ(24), 0.2);
  baked.geometry.computeBoundingBox();
  near(baked.geometry.boundingBox.min.x, 11.5);
  assert.notEqual(baked.material, material);
  assert.equal(baked.material.vertexColors, true);
  near(geometry.attributes.color.getX(0), 0.5);
});

test('export respects hidden/helper ancestors and preserves multiple material groups', () => {
  const root = new THREE.Group();
  for (const property of ['hidden', 'helper']) {
    const group = new THREE.Group();
    if (property === 'hidden') group.visible = false;
    else group.userData.helper = true;
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    root.add(group);
  }
  assert.equal(bakeWorldGroup(root).children.length, 0);
  const geometry = new THREE.BoxGeometry();
  geometry.groups.forEach((g) => {
    g.materialIndex %= 2;
  });
  const materials = [
    new THREE.MeshStandardMaterial({ color: 'red' }),
    new THREE.MeshStandardMaterial({ color: 'blue' }),
  ];
  const mesh = new THREE.InstancedMesh(geometry, materials, 2);
  mesh.setColorAt(0, new THREE.Color('white'));
  mesh.setColorAt(1, new THREE.Color('white'));
  root.add(mesh);
  const baked = bakeWorldGroup(root).children[0];
  assert.equal(baked.material.length, 2);
  assert.equal(baked.geometry.groups.length, 12);
  assert.equal(baked.geometry.groups[6].start, 36);
  assert.notEqual(baked.material[0], materials[0]);
  root.visible = false;
  assert.equal(bakeWorldGroup(root).children.length, 0);
});

test('failed screenshot rejects instead of reporting a saved image', async () => {
  await assert.rejects(
    captureScreenshot({ toBlob: (callback) => callback(null) }, 'test.png'),
    /capture/,
  );
});

test('adaptive quality can step down twice; background time and disabled mode cannot downgrade', () => {
  const adaptive = new AdaptiveQuality();
  let quality = 'quality';
  const changes = [];
  for (let i = 0; i < 500; i++) {
    const next = adaptive.sample(0.05, 20, quality, true, true);
    if (next) {
      changes.push(next);
      quality = next;
    }
  }
  assert.deepEqual(changes, ['balanced', 'mobile']);
  const paused = new AdaptiveQuality();
  for (let i = 0; i < 500; i++) {
    assert.equal(paused.sample(0.05, 10, 'quality', true, false), null);
    assert.equal(paused.sample(0.05, 10, 'quality', false, true), null);
  }
  assert.equal(paused.sample(10, 1, 'quality', true, true), null);
  for (let i = 0; i < 60; i++) assert.equal(paused.sample(0.05, 10, 'quality', true, true), null);
});

test('mobile vegetation selection is stable, bounded, and does not modify the world', () => {
  const trees = Array.from({ length: 9000 }, (_, id) => ({ id }));
  const mobile = selectDetailInstances(trees, 0.4);
  assert.ok(mobile.length > 3300 && mobile.length < 3900);
  assert.deepEqual(selectDetailInstances(trees, 0.4), mobile);
  assert.equal(selectDetailInstances(trees, 1), trees);
  assert.equal(trees.length, 9000);
  assert.deepEqual(selectDetailInstances(trees, 0), []);
});

test('road normals follow sloping terrain and rainy pavement remains nonmetallic', () => {
  const loader = createLoader({
    react: { useMemo: (fn) => fn(), useEffect: () => {} },
    './textures': { createRoadTexture: () => new THREE.Texture() },
  });
  const world = structuredClone(DEFAULT_WORLD);
  world.water.enabled = false;
  const gen = {
    waterLevel: 0,
    heightAt: (x) => x * 0.2,
    junctions: [],
    roadPolylines: [
      {
        pts: [
          [0, 0],
          [12, 0],
        ],
        width: 3.4,
      },
    ],
  };
  const { Roads } = loader('@/three/roads');
  const dry = Roads({ gen, world }).props.children[0];
  const normal = dry.props.geometry.attributes.normal;
  assert.ok(normal.getX(0) < -0.1);
  assert.ok(normal.getY(0) > 0.9);
  world.lighting.preset = 'rain';
  const wet = Roads({ gen, world }).props.children[0];
  assert.ok(wet.props.children.props.roughness < dry.props.children.props.roughness);
  assert.ok(wet.props.children.props.metalness < 0.05);
});

test('camera moves with viewport focus or pointer lock, ignores shortcuts, and releases input on outside focus', () => {
  const oldWindow = globalThis.window,
    oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const canvas = new EventTarget();
  canvas.focus = () => {};
  const camera = new THREE.PerspectiveCamera();
  const effects = [];
  let frame;
  const cleanups = [];
  const state = { cameraMode: 'walk' };
  const ui = (select) => select(state);
  ui.getState = () => state;
  const loader = createLoader({
    react: {
      useMemo: (fn) => fn(),
      useEffect: (fn) => effects.push(fn),
      useRef: (value) => ({ current: value }),
      useState: (value) => [value, () => {}],
    },
    '@react-three/drei': { OrbitControls: () => null, PointerLockControls: () => null },
    '@react-three/fiber': {
      useThree: (select) => select({ camera, gl: { domElement: canvas } }),
      useFrame: (fn) => {
        frame = fn;
      },
    },
    '@/stores/ui-store': { useUIStore: ui },
  });
  const key = (code, modifiers = {}) => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { code, ...modifiers });
    window.dispatchEvent(event);
    return event;
  };
  try {
    const gen = { size: 100, heights: [0], heightAt: () => 0, waterLevel: 10 };
    loader('@/three/camera-rig').CameraRig({ gen, waterEnabled: false });
    effects.forEach((effect) => {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    });
    near(camera.position.y, 1.75);
    key('KeyW');
    frame({}, 0.05);
    near(camera.position.z, 0);
    canvas.dispatchEvent(new Event('pointerdown'));
    key('KeyW');
    frame({}, 0.05);
    assert.ok(camera.position.z < 0, 'click-to-focus must work without pointer lock');
    const focusedZ = camera.position.z;
    document.dispatchEvent(new Event('focusin'));
    frame({}, 0.05);
    near(camera.position.z, focusedZ);
    camera.position.z = 0;
    document.pointerLockElement = canvas;
    document.dispatchEvent(new Event('pointerlockchange'));
    key('KeyS', { ctrlKey: true });
    frame({}, 0.05);
    near(camera.position.z, 0);
    key('KeyW');
    frame({}, 0.05);
    assert.ok(camera.position.z < 0);
    const z = camera.position.z;
    document.pointerLockElement = null;
    document.dispatchEvent(new Event('pointerlockchange'));
    frame({}, 0.05);
    near(camera.position.z, z);
    const bus = loader('@/lib/bus');
    bus.emit('camera:pose', { position: [0, 2, 0], target: [10, 2, 0] });
    const direction = camera.getWorldDirection(new THREE.Vector3());
    near(direction.x, 1);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test('road junctions are convex, retain nearby connections, and do not mutate source centerlines', () => {
  const { buildJunctionNetwork } = load('@/lib/worldgen/road-network');
  const lines = [
    {
      pts: [
        [-30, 0],
        [30, 0],
      ],
      width: 6.2,
    },
    {
      pts: [
        [0, -20],
        [0, 20],
      ],
      width: 6.2,
    },
    {
      pts: [
        [3, 0],
        [3, -20],
      ],
      width: 3.2,
    },
  ];
  const source = structuredClone(lines);
  const net = buildJunctionNetwork(lines);
  assert.deepEqual(lines, source);
  assert.equal(net.junctions.length, 2, 'nearby junctions must not collapse into one star');
  for (const { ring } of net.junctions) {
    assert.ok(ring.length >= 3);
    for (let i = 0; i < ring.length; i++) {
      const [a, b, c] = [ring[i], ring[(i + 1) % ring.length], ring[(i + 2) % ring.length]];
      const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      assert.ok(turn < 1e-6, 'junction boundary must not fold inward');
      assert.ok(a.every(Number.isFinite));
    }
  }
  assert.ok(net.ribbons.every((r) => r.pts.length >= 2));
});

test('closed roads and parallel streets survive network cleanup; exact duplicates do not', () => {
  const { buildJunctionNetwork, roundRoadBends } = load('@/lib/worldgen/road-network');
  const loop = {
    width: 3,
    pts: [
      [0, 0],
      [15, 0],
      [15, 15],
      [0, 15],
      [0, 0],
    ],
  };
  const net = buildJunctionNetwork([loop]);
  assert.equal(net.ribbons.length, 1);
  assert.ok(net.ribbons[0].pts.length >= 5);
  assert.equal(net.junctions.length, 1, 'closed seam must be joined');
  const pair = buildJunctionNetwork([
    {
      width: 2,
      pts: [
        [-20, 0],
        [20, 0],
      ],
    },
    {
      width: 2,
      pts: [
        [-20, 3],
        [20, 3],
      ],
    },
    {
      width: 2,
      pts: [
        [20, 0],
        [-20, 0],
      ],
    },
  ]);
  assert.equal(pair.ribbons.length, 2, 'nearby parallel streets must not be deleted');
  const path = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const curved = roundRoadBends(path, 2);
  assert.deepEqual(curved[0], path[0]);
  assert.deepEqual(curved.at(-1), path.at(-1));
  assert.ok(curved.length > path.length);
  const nearMiss = buildJunctionNetwork([
    {
      width: 6.2,
      pts: [
        [-20, 0],
        [0, 0],
      ],
    },
    {
      width: 6.2,
      pts: [
        [0.2, 0],
        [20, 10],
      ],
    },
  ]);
  assert.equal(
    nearMiss.junctions.length,
    1,
    'snapped tips must share one anchor rather than swap anchors',
  );
});

test('lots are excluded from crossing roads including rotated footprints', () => {
  const { roadIntersectsLot, generateCity } = load('@/lib/worldgen/city');
  const building = { x: 0, z: 0, w: 10, d: 6, rotation: Math.PI / 4 };
  assert.equal(roadIntersectsLot(building, { ax: -30, az: 0, bx: 30, bz: 0, width: 6.2 }), true);
  assert.equal(roadIntersectsLot(building, { ax: -30, az: 25, bx: 30, bz: 25, width: 6.2 }), false);
  const world = structuredClone(DEFAULT_WORLD);
  world.city.layout = 'radial';
  const generated = generateCity(world, () => 10, 0, 420);
  assert.ok(generated.buildings.length > 0);
  for (const b of generated.buildings)
    assert.ok(!generated.roads.some((r) => roadIntersectsLot(b, r)));
});

test('orbit mode supports WASD panning after a viewport click', () => {
  const oldWindow = globalThis.window,
    oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const canvas = new EventTarget();
  canvas.focus = () => {};
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 20, 20);
  camera.lookAt(0, 0, 0);
  const target = new THREE.Vector3();
  const effects = [],
    cleanups = [];
  let frame;
  let refs = 0;
  const ui = (select) => select({ cameraMode: 'orbit' });
  ui.getState = () => ({ cameraMode: 'orbit' });
  const loader = createLoader({
    react: {
      useMemo: (fn) => fn(),
      useEffect: (fn) => effects.push(fn),
      useRef: (value) => ({ current: refs++ === 0 ? { target, update() {} } : value }),
      useState: (value) => [value, () => {}],
    },
    '@react-three/drei': { OrbitControls: () => null, PointerLockControls: () => null },
    '@react-three/fiber': {
      useThree: (select) => select({ camera, gl: { domElement: canvas } }),
      useFrame: (fn) => {
        frame = fn;
      },
    },
    '@/stores/ui-store': { useUIStore: ui },
  });
  try {
    loader('@/three/camera-rig').CameraRig({
      gen: { size: 100, heights: [0], heightAt: () => 0, waterLevel: 0 },
    });
    effects.forEach((fn) => {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    });
    canvas.dispatchEvent(new Event('pointerdown'));
    const event = new Event('keydown');
    Object.assign(event, { code: 'KeyW' });
    window.dispatchEvent(event);
    frame({}, 0.05);
    assert.ok(camera.position.z < 20);
    near(camera.position.y, 20);
    near(camera.position.z - target.z, 20);
  } finally {
    cleanups.forEach((fn) => fn());
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
