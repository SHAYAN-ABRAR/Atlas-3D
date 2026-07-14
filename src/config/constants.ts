import type {
  BuildingStyle,
  LightingPreset,
  MaterialOverride,
  TerrainStyle,
  VegetationStyle,
  WorldState,
} from '@/types/world';

export const APP_NAME = 'Atlas 3D';
export const APP_TAGLINE = 'Transform any 2D map into an explorable 3D world.';

/** World is a square WORLD_SIZE x WORLD_SIZE units, centered on origin. */
export const WORLD_SIZE = 420;
/** Heightfield samples per side. */
export const HEIGHTFIELD_RES = 176;
/** Resolution maps are downsampled to for classification. */
export const MAP_ANALYSIS_RES = 96;

export const STORAGE_PREFIX = 'atlas3d:';
export const DB_NAME = 'atlas3d';
export const DB_VERSION = 1;

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'gemma4:31b-cloud';

export const DEFAULT_WORLD: WorldState = {
  seed: 20260707,
  terrain: { style: 'rolling', amplitude: 26, frequency: 1, octaves: 5, waterLevel: 0.18, rivers: 1 },
  water: { enabled: true },
  city: { enabled: true, style: 'modern', layout: 'grid', density: 0.55, maxFloors: 14, extent: 0.55 },
  roads: { widthScale: 1, sidewalks: true },
  vegetation: { enabled: true, style: 'mixed', density: 0.5 },
  lighting: { preset: 'day', fog: 0.25, exposure: 1 },
  effects: { particles: 'none' },
  materials: { override: 'none' },
  map: { enabled: false, analysis: null },
};

/* ------------------------------------------------------------------ */
/* Lighting                                                            */
/* ------------------------------------------------------------------ */

export interface LightingPresetDef {
  label: string;
  /** Sun spherical coords in degrees. */
  elevation: number;
  azimuth: number;
  sunIntensity: number;
  sunColor: string;
  ambient: number;
  sky: { turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number } | null;
  background: string;
  fogColor: string;
  fogBase: number;
  stars: boolean;
  /** Emissive intensity of building windows. */
  windowGlow: number;
  exposure: number;
}

export const LIGHTING_PRESETS: Record<LightingPreset, LightingPresetDef> = {
  day: {
    label: 'Midday',
    elevation: 55, azimuth: 130, sunIntensity: 2.6, sunColor: '#fff4e0',
    ambient: 0.62,
    sky: { turbidity: 6, rayleigh: 1.2, mieCoefficient: 0.004, mieDirectionalG: 0.75 },
    background: '#b9cfe0', fogColor: '#c6d5e0', fogBase: 0.0012, stars: false, windowGlow: 0, exposure: 1.0,
  },
  dawn: {
    label: 'Dawn',
    elevation: 8, azimuth: 85, sunIntensity: 1.8, sunColor: '#ffd9b0',
    ambient: 0.5,
    sky: { turbidity: 8, rayleigh: 2.6, mieCoefficient: 0.006, mieDirectionalG: 0.8 },
    background: '#d8c2c9', fogColor: '#d9c6c2', fogBase: 0.0022, stars: false, windowGlow: 0.5, exposure: 0.92,
  },
  sunset: {
    label: 'Sunset',
    elevation: 4, azimuth: 255, sunIntensity: 2.2, sunColor: '#ff9e5e',
    ambient: 0.46,
    sky: { turbidity: 10, rayleigh: 3.2, mieCoefficient: 0.009, mieDirectionalG: 0.82 },
    background: '#e0a380', fogColor: '#d9a184', fogBase: 0.0018, stars: false, windowGlow: 0.9, exposure: 0.9,
  },
  night: {
    label: 'Night',
    elevation: -12, azimuth: 200, sunIntensity: 0.12, sunColor: '#8fa8ff',
    ambient: 0.2,
    sky: null,
    background: '#0a0e18', fogColor: '#0a0e18', fogBase: 0.0016, stars: true, windowGlow: 1.6, exposure: 0.95,
  },
  overcast: {
    label: 'Overcast',
    elevation: 40, azimuth: 150, sunIntensity: 0.9, sunColor: '#dfe4ea',
    ambient: 0.85,
    sky: null,
    background: '#9aa4ad', fogColor: '#9aa4ad', fogBase: 0.003, stars: false, windowGlow: 0.25, exposure: 0.95,
  },
  rain: {
    label: 'Rainy evening',
    elevation: 18, azimuth: 210, sunIntensity: 0.5, sunColor: '#aebdd0',
    ambient: 0.58,
    sky: null,
    background: '#5c6874', fogColor: '#5a6570', fogBase: 0.0045, stars: false, windowGlow: 1.1, exposure: 0.88,
  },
  cyberpunk: {
    label: 'Cyberpunk night',
    elevation: -8, azimuth: 0, sunIntensity: 0.1, sunColor: '#7f7fff',
    ambient: 0.26,
    sky: null,
    background: '#0b0714', fogColor: '#170d26', fogBase: 0.0032, stars: true, windowGlow: 2.2, exposure: 1.05,
  },
};

/* ------------------------------------------------------------------ */
/* Architecture                                                        */
/* ------------------------------------------------------------------ */

export interface BuildingStyleDef {
  label: string;
  walls: string[];
  roofs: string[];
  roofType: 'flat' | 'pyramid' | 'pagoda';
  floorHeight: number;
  minFootprint: number;
  maxFootprint: number;
  roughness: number;
  metalness: number;
  windowColor: string;
  /** Multiplier applied to city.maxFloors — medieval towns stay low. */
  heightBias: number;
}

export const BUILDING_STYLES: Record<BuildingStyle, BuildingStyleDef> = {
  modern: {
    label: 'Modern',
    walls: ['#b9bec4', '#a7adb4', '#8f959c', '#c9cdd1', '#7d838a', '#adb8c0'],
    roofs: ['#6b7076', '#5d6268'],
    roofType: 'flat', floorHeight: 3.1, minFootprint: 8, maxFootprint: 15,
    roughness: 0.5, metalness: 0.12, windowColor: '#ffd98a', heightBias: 1,
  },
  medieval: {
    label: 'Medieval',
    walls: ['#c8b59a', '#bfa886', '#a89070', '#d3c3ab', '#9c8a70', '#b59d7e'],
    roofs: ['#7a4a32', '#6d4530', '#83543a', '#5f3d2a'],
    roofType: 'pyramid', floorHeight: 2.9, minFootprint: 6, maxFootprint: 12,
    roughness: 0.92, metalness: 0.02, windowColor: '#ffbf66', heightBias: 0.28,
  },
  japanese: {
    label: 'Japanese',
    walls: ['#e8e0d0', '#ddd2bd', '#cfc3ab', '#b7a284', '#8c7860'],
    roofs: ['#3d4148', '#33373d', '#4a4e55', '#5b4636'],
    roofType: 'pagoda', floorHeight: 2.8, minFootprint: 7, maxFootprint: 13,
    roughness: 0.85, metalness: 0.05, windowColor: '#ffd9a0', heightBias: 0.22,
  },
  cyberpunk: {
    label: 'Cyberpunk',
    walls: ['#23262e', '#1d2027', '#2b2f3a', '#171a20', '#30343f'],
    roofs: ['#14161c', '#1b1e26'],
    roofType: 'flat', floorHeight: 3.2, minFootprint: 8, maxFootprint: 17,
    roughness: 0.32, metalness: 0.3, windowColor: '#59f0ff', heightBias: 1.6,
  },
  nordic: {
    label: 'Nordic',
    walls: ['#8f3b2e', '#7d5136', '#3f4a52', '#c8beac', '#5d6b5a', '#a3502f'],
    roofs: ['#2e3338', '#3a4046', '#443d33'],
    roofType: 'pyramid', floorHeight: 2.9, minFootprint: 6, maxFootprint: 11,
    roughness: 0.88, metalness: 0.03, windowColor: '#ffcf7d', heightBias: 0.24,
  },
  industrial: {
    label: 'Industrial',
    walls: ['#8a8078', '#75706a', '#9b9288', '#6a655f', '#b0473a'],
    roofs: ['#4c4844', '#57534e'],
    roofType: 'flat', floorHeight: 4.2, minFootprint: 12, maxFootprint: 22,
    roughness: 0.68, metalness: 0.15, windowColor: '#cfe3ff', heightBias: 0.45,
  },
};

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

export interface MaterialOverrideDef {
  label: string;
  walls: string[];
  roofs: string[];
  roughness: number;
  metalness: number;
}

export const MATERIAL_OVERRIDES: Record<Exclude<MaterialOverride, 'none'>, MaterialOverrideDef> = {
  marble: { label: 'Marble', walls: ['#e8e6e1', '#dcd9d2', '#f0eee9', '#cfccc5'], roofs: ['#d5d2cb'], roughness: 0.18, metalness: 0.02 },
  walnut: { label: 'Dark walnut', walls: ['#4a3527', '#3d2c20', '#57402f', '#332419'], roofs: ['#2b1f16'], roughness: 0.6, metalness: 0.0 },
  concrete: { label: 'Concrete', walls: ['#9d9d99', '#8f8f8b', '#a8a8a4', '#83837f'], roofs: ['#787874'], roughness: 0.95, metalness: 0.0 },
  sandstone: { label: 'Sandstone', walls: ['#d9bd93', '#cfb083', '#e3caa2', '#c2a273'], roofs: ['#b39468'], roughness: 0.9, metalness: 0.0 },
  obsidian: { label: 'Obsidian', walls: ['#17181c', '#101114', '#1e2026', '#0b0c0f'], roofs: ['#0e0f12'], roughness: 0.12, metalness: 0.35 },
  copper: { label: 'Copper', walls: ['#a5673f', '#96582f', '#b3764c', '#8a4f2a'], roofs: ['#5e8f74'], roughness: 0.35, metalness: 0.85 },
};

/* ------------------------------------------------------------------ */
/* Vegetation                                                          */
/* ------------------------------------------------------------------ */

export interface VegetationStyleDef {
  label: string;
  canopy: string[];
  trunk: string;
  /** Probability a given tree is a conifer (kind 0). */
  coniferBias: number;
  scale: [number, number];
}

export const VEGETATION_STYLES: Record<VegetationStyle, VegetationStyleDef> = {
  mixed: { label: 'Mixed forest', canopy: ['#5e7c47', '#6d8e52', '#516d3e', '#7fa05f'], trunk: '#5a4632', coniferBias: 0.45, scale: [0.8, 1.5] },
  pine: { label: 'Pine', canopy: ['#42603c', '#385433', '#4d6b45', '#324b2d'], trunk: '#4c3f2f', coniferBias: 0.95, scale: [0.9, 1.7] },
  oak: { label: 'Oak', canopy: ['#6a8c4a', '#77995c', '#5c7c41', '#84a66a'], trunk: '#5e4a33', coniferBias: 0.05, scale: [0.9, 1.6] },
  palm: { label: 'Palm', canopy: ['#6c9c50', '#7cad5e', '#618c47'], trunk: '#87704f', coniferBias: 0.0, scale: [0.8, 1.3] },
  sparse: { label: 'Sparse scrub', canopy: ['#8d8d5b', '#9c9468', '#7c7c4f'], trunk: '#6a5940', coniferBias: 0.3, scale: [0.5, 0.9] },
};

/* ------------------------------------------------------------------ */
/* Terrain palettes                                                    */
/* ------------------------------------------------------------------ */

export interface TerrainPalette {
  /** [sand, low grass, high grass, rock, peak] as hex. */
  stops: [string, string, string, string, string];
}

export const TERRAIN_PALETTES: Record<TerrainStyle, TerrainPalette> = {
  flat: { stops: ['#c9b78f', '#7d8f56', '#6e8250', '#8a8574', '#b5b3a8'] },
  plains: { stops: ['#c9b78f', '#82945a', '#6f8750', '#8d8977', '#c2c0b5'] },
  rolling: { stops: ['#c4b189', '#7c8f55', '#63784a', '#87826f', '#cfcdc2'] },
  mountains: { stops: ['#b7a482', '#6f8250', '#5c7045', '#7d7466', '#e8e8e4'] },
  islands: { stops: ['#e0cfa5', '#8fa060', '#729052', '#8a8570', '#d5d3c8'] },
  canyon: { stops: ['#d9a06a', '#c08050', '#a06844', '#8a5638', '#c9915f'] },
};

/** Presets the "Optimize" command and quality settings map to. */
export const QUALITY_LEVELS = {
  mobile: { label: 'Mobile', dpr: 1, shadows: false, shadowMap: 1024, vegetationScale: 0.4 },
  balanced: { label: 'Balanced', dpr: 1.5, shadows: true, shadowMap: 2048, vegetationScale: 1 },
  quality: { label: 'Quality', dpr: 2, shadows: true, shadowMap: 4096, vegetationScale: 1 },
} as const;

export type QualityLevel = keyof typeof QUALITY_LEVELS;
