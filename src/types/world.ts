/** Serializable world description. Everything needed to regenerate a scene deterministically. */

export type TerrainStyle = 'flat' | 'plains' | 'rolling' | 'mountains' | 'islands' | 'canyon';
export type BuildingStyle =
  | 'modern'
  | 'medieval'
  | 'japanese'
  | 'cyberpunk'
  | 'nordic'
  | 'industrial';
export type CityLayout = 'grid' | 'organic' | 'radial';
export type VegetationStyle = 'mixed' | 'pine' | 'oak' | 'palm' | 'sparse';
export type LightingPreset =
  | 'day'
  | 'dawn'
  | 'sunset'
  | 'night'
  | 'overcast'
  | 'rain'
  | 'cyberpunk';
export type ParticleMode = 'none' | 'rain' | 'snow' | 'fireflies' | 'embers';
export type MaterialOverride =
  | 'none'
  | 'marble'
  | 'walnut'
  | 'concrete'
  | 'sandstone'
  | 'obsidian'
  | 'copper';

export interface TerrainSettings {
  style: TerrainStyle;
  /** Peak height in world units. */
  amplitude: number;
  /** Base noise frequency multiplier. */
  frequency: number;
  octaves: number;
  /** Water plane height as a 0..1 fraction of amplitude. */
  waterLevel: number;
  rivers: number;
}

export interface CitySettings {
  enabled: boolean;
  style: BuildingStyle;
  layout: CityLayout;
  /** 0..1 how much of buildable land gets built. */
  density: number;
  maxFloors: number;
  /** 0..1 fraction of world radius the city occupies. */
  extent: number;
}

export interface RoadSettings {
  widthScale: number;
  sidewalks: boolean;
}

export interface VegetationSettings {
  enabled: boolean;
  style: VegetationStyle;
  density: number;
}

export interface LightingSettings {
  preset: LightingPreset;
  /** 0..1 extra fog on top of the preset. */
  fog: number;
  exposure: number;
}

export interface EffectsSettings {
  particles: ParticleMode;
}

export interface MaterialSettings {
  override: MaterialOverride;
}

/** Classified cells from an uploaded map. Values: 0 terrain, 1 water, 2 vegetation, 3 road, 4 building. */
export interface MapAnalysis {
  width: number;
  height: number;
  /** Row-major cell classes, length = width * height. */
  cells: number[];
  sourceName: string;
  /** Human-readable place name when the map was auto-located. */
  location?: string;
  /** How the cells were derived: real OpenStreetMap data or pixel classification. */
  source?: 'osm' | 'classifier';
  /**
   * Exact road centerlines in grid coordinates (0..width floats), present
   * when the map came from real OSM data. Generation uses these directly so
   * streets keep their true curves instead of being re-traced from cells.
   * `w` is a width multiplier by road class.
   */
  roadPaths?: { w: number; pts: [number, number][] }[];
  coverage: { water: number; vegetation: number; road: number; building: number };
}

export interface WorldState {
  seed: number;
  terrain: TerrainSettings;
  water: { enabled: boolean };
  city: CitySettings;
  roads: RoadSettings;
  vegetation: VegetationSettings;
  lighting: LightingSettings;
  effects: EffectsSettings;
  materials: MaterialSettings;
  /** When set and enabled, generation is guided by the analyzed map. */
  map: { enabled: boolean; analysis: MapAnalysis | null };
}

/* ------------------------------------------------------------------ */
/* Generated (derived) world — never persisted, always recomputed.     */
/* ------------------------------------------------------------------ */

export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
}

/**
 * A whole street as one world-space polyline. Rendering drapes each as a
 * single continuous mitered ribbon, so curves stay smooth and lane dashes
 * run unbroken; `roads` segments are derived from these for grading,
 * clearance and occupancy.
 */
export interface RoadPolyline {
  pts: [number, number][];
  width: number;
}

/**
 * A paved intersection. `ring` is the junction polygon boundary, built from
 * the trimmed end corners of every ribbon meeting here — the ribbons stop
 * at this boundary, so the network renders seamlessly with no overlaps.
 */
export interface RoadJunction {
  x: number;
  z: number;
  ring: [number, number][];
}

export interface BuildingInstance {
  x: number;
  z: number;
  /** Footprint width/depth in world units. */
  w: number;
  d: number;
  h: number;
  rotation: number;
  /** Ground elevation of the lot. */
  y: number;
  colorIndex: number;
  hasRoof: boolean;
}

export interface TreeInstance {
  x: number;
  z: number;
  y: number;
  scale: number;
  /** 0 = conifer, 1 = broadleaf. */
  kind: 0 | 1;
  tint: number;
}

export interface WorldStats {
  buildings: number;
  tallestBuilding: number;
  trees: number;
  roadLength: number;
  waterCoverage: number;
  greenCoverage: number;
  triangleEstimate: number;
}

export interface GeneratedWorld {
  key: string;
  /** World is a square, size x size units, centered on origin. */
  size: number;
  /** Heightfield resolution (res x res samples). */
  res: number;
  heights: Float32Array;
  waterLevel: number;
  roads: RoadSegment[];
  roadPolylines: RoadPolyline[];
  junctions: RoadJunction[];
  buildings: BuildingInstance[];
  trees: TreeInstance[];
  stats: WorldStats;
  heightAt: (x: number, z: number) => number;
}
