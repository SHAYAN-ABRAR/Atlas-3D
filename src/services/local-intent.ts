import { findTemplate } from '@/config/world-templates';
import type { SceneCommand } from '@/types/commands';
import type {
  BuildingStyle,
  LightingPreset,
  MaterialOverride,
  ParticleMode,
  TerrainStyle,
  VegetationStyle,
  WorldState,
} from '@/types/world';

/**
 * Offline interpreter. When Ollama isn't running, common requests still work —
 * the app maps natural language onto scene commands with plain keyword rules.
 */
export function interpretLocally(
  prompt: string,
  world: WorldState,
): { reply: string; commands: SceneCommand[] } {
  const q = prompt.toLowerCase();
  const commands: SceneCommand[] = [];
  const notes: string[] = [];
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  // Whole-world templates
  const wantsWorld = has('create', 'generate', 'make', 'build', 'turn this');
  const template = findTemplate(q);
  if (template && wantsWorld) {
    commands.push({ action: 'generate_world', template: template.id });
    notes.push(`generated the ${template.name} template`);
  }

  // Stats questions answer directly.
  if (
    has('how many', 'how much', 'tallest', 'what is the', "what's the", 'statistics', 'stats') &&
    has('building', 'structure', 'tree', 'green', 'water', 'road', 'park', 'stat')
  ) {
    return { reply: '', commands: [{ action: 'stats' }] };
  }

  // Lighting
  const lightMap: [string[], LightingPreset][] = [
    [['sunset', 'dusk', 'golden hour'], 'sunset'],
    [['sunrise', 'dawn', 'morning'], 'dawn'],
    [['cyberpunk', 'neon'], 'cyberpunk'],
    [['night', 'midnight', 'stars'], 'night'],
    [['overcast', 'cloudy', 'grey sky', 'gray sky'], 'overcast'],
    [['rainy', 'rain', 'storm', 'drizzle'], 'rain'],
    [['midday', 'daylight', 'sunny', 'clear day', 'noon'], 'day'],
  ];
  for (const [words, preset] of lightMap) {
    if (has(...words)) {
      commands.push({ action: 'set_lighting', preset });
      notes.push(`switched lighting to ${preset}`);
      if (preset === 'rain') {
        commands.push({ action: 'set_weather', particles: 'rain' });
        notes.push('added rain');
      }
      if (preset === 'cyberpunk' && has('rain')) {
        commands.push({ action: 'set_weather', particles: 'rain' });
      }
      break;
    }
  }

  // Weather particles
  if (has('rain', 'drizzle') && !commands.some((c) => c.action === 'set_weather')) {
    commands.push({ action: 'set_weather', particles: 'rain' });
    notes.push('added rain');
  }
  if (has('snow')) {
    commands.push({ action: 'set_weather', particles: 'snow' });
    notes.push('let it snow');
  } else if (has('fireflies', 'firefly')) {
    commands.push({ action: 'set_weather', particles: 'fireflies' });
    notes.push('released fireflies');
  } else if (has('embers', 'ash')) {
    commands.push({ action: 'set_weather', particles: 'embers' });
    notes.push('embers drifting');
  } else if (has('clear weather', 'stop rain', 'no rain', 'stop the rain', 'stop snow')) {
    commands.push({ action: 'set_weather', particles: 'none' });
    notes.push('cleared the weather');
  }

  // Materials
  const matMap: [string[], MaterialOverride][] = [
    [['marble'], 'marble'],
    [['walnut', 'dark wood', 'wood'], 'walnut'],
    [['concrete', 'brutalist'], 'concrete'],
    [['sandstone', 'stone'], 'sandstone'],
    [['obsidian', 'black glass'], 'obsidian'],
    [['copper', 'bronze'], 'copper'],
  ];
  for (const [words, override] of matMap) {
    if (has(...words)) {
      commands.push({ action: 'set_materials', override });
      notes.push(`applied ${override} across the scene`);
      break;
    }
  }
  if (has('original materials', 'reset materials', 'normal materials')) {
    commands.push({ action: 'set_materials', override: 'none' });
    notes.push('restored original materials');
  }

  // Roads
  const pct = /(\d+)\s*(?:%|percent)\s*(wider|narrower)/.exec(q);
  if (pct) {
    const factor = 1 + (parseInt(pct[1], 10) / 100) * (pct[2] === 'wider' ? 1 : -1);
    commands.push({ action: 'set_roads', widthMultiplier: factor });
    notes.push(`roads are now ${pct[1]}% ${pct[2]}`);
  } else if (has('wider road', 'roads wider', 'widen')) {
    commands.push({ action: 'set_roads', widthMultiplier: 1.25 });
    notes.push('widened the roads by 25%');
  } else if (has('narrower road', 'roads narrower')) {
    commands.push({ action: 'set_roads', widthMultiplier: 0.8 });
    notes.push('narrowed the roads');
  }
  if (has('sidewalk', 'pavement', 'footpath')) {
    commands.push({ action: 'set_roads', sidewalks: !has('remove', 'without', 'no ') });
    notes.push('updated sidewalks');
  }

  // Buildings
  const styleMap: [string[], BuildingStyle][] = [
    [['japanese', 'japan', 'pagoda'], 'japanese'],
    [['medieval', 'tudor', 'timber'], 'medieval'],
    [['cyberpunk tower', 'neon tower'], 'cyberpunk'],
    [['nordic', 'scandinavian', 'scandi'], 'nordic'],
    [['industrial', 'warehouse', 'factory'], 'industrial'],
    [['modern building', 'modern architecture', 'glass tower', 'skyscraper'], 'modern'],
  ];
  if (!template) {
    for (const [words, style] of styleMap) {
      if (has(...words)) {
        commands.push({ action: 'set_buildings', style });
        notes.push(`rebuilt architecture in ${style} style`);
        break;
      }
    }
  }
  if (has('denser', 'more buildings', 'more dense')) {
    commands.push({ action: 'set_buildings', density: Math.min(1, world.city.density + 0.2) });
    notes.push('densified the city');
  }
  if (has('fewer buildings', 'less dense', 'sparser')) {
    commands.push({ action: 'set_buildings', density: Math.max(0.05, world.city.density - 0.2) });
    notes.push('thinned the city out');
  }
  if (has('taller', 'higher buildings', 'raise the max')) {
    commands.push({ action: 'set_buildings', maxFloors: Math.round(world.city.maxFloors * 1.4) });
    notes.push('raised building heights');
  }
  if (has('no buildings', 'remove buildings', 'remove the city', 'clear the city')) {
    commands.push({ action: 'set_buildings', enabled: false });
    notes.push('removed the city');
  }

  // Terrain
  if (!template) {
    const terrMap: [string[], TerrainStyle][] = [
      [['mountain', 'mountainous', 'peaks', 'alps'], 'mountains'],
      [['island', 'archipelago'], 'islands'],
      [['canyon', 'mesa', 'desert cliffs'], 'canyon'],
      [['flat terrain', 'flatten', 'completely flat'], 'flat'],
      [['plains', 'meadow', 'grassland'], 'plains'],
      [['rolling hills', 'hills', 'hilly'], 'rolling'],
    ];
    for (const [words, style] of terrMap) {
      if (has(...words)) {
        commands.push({
          action: 'set_terrain',
          style,
          amplitude: style === 'mountains' ? Math.max(world.terrain.amplitude, 48) : undefined,
        });
        notes.push(`reshaped the terrain (${style})`);
        break;
      }
    }
  }
  if (has('river')) {
    commands.push({
      action: 'set_terrain',
      rivers: has('no river', 'remove river') ? 0 : Math.max(2, world.terrain.rivers + 1),
    });
    notes.push('rerouted the rivers');
  }
  if (has('more water', 'raise the water', 'flood')) {
    commands.push({ action: 'set_water', level: Math.min(0.9, world.terrain.waterLevel + 0.12) });
    notes.push('raised the water level');
  }

  // Vegetation
  const vegMap: [string[], VegetationStyle][] = [
    [['oak'], 'oak'],
    [['pine', 'conifer', 'evergreen'], 'pine'],
    [['palm', 'tropical tree'], 'palm'],
    [['scrub', 'shrub', 'sparse veg'], 'sparse'],
  ];
  for (const [words, style] of vegMap) {
    if (has(...words)) {
      commands.push({
        action: 'set_vegetation',
        style,
        enabled: true,
        density: Math.max(world.vegetation.density, 0.5),
      });
      notes.push(`planted ${style} trees`);
      break;
    }
  }
  if (has('more trees', 'more forest', 'add trees', 'add forest')) {
    commands.push({
      action: 'set_vegetation',
      enabled: true,
      density: Math.min(1, world.vegetation.density + 0.25),
    });
    notes.push('grew the forests');
  }
  if (has('remove trees', 'no trees', 'clear the forest')) {
    commands.push({ action: 'set_vegetation', enabled: false });
    notes.push('cleared the vegetation');
  }

  // Camera / meta
  if (has('flythrough', 'fly-through', 'fly through', 'cinematic', 'camera tour', 'showcase')) {
    commands.push({ action: 'camera_flythrough' });
    notes.push('starting a cinematic fly-through');
  }
  if (has('optimize', 'optimise', 'performance', 'run faster', 'mobile')) {
    commands.push({ action: 'optimize', level: has('mobile') ? 'mobile' : 'balanced' });
    notes.push('optimized scene settings');
  }
  if (has('regenerate', 'another version', 'new seed', 'variation', 'shuffle')) {
    commands.push({ action: 'reseed' });
    notes.push('rolled a new seed');
  }

  // Help / tutorials
  if (commands.length === 0 && has('how do i', 'help', 'controls', 'tutorial', 'shortcut')) {
    return {
      reply:
        'Quick guide — Orbit: drag with the left mouse button, scroll to zoom. Walk mode: press 2, then click the viewport and use WASD (Esc to release). Fly mode: press 3. Import a map: drop an image anywhere or use the Assets tab. Export: top-right Export menu (GLB, OBJ, PNG, .atlas3d project file). Command palette: Ctrl+K. Full shortcut list: press ?.',
      commands: [],
    };
  }

  if (commands.length === 0) {
    return {
      reply:
        "I couldn't map that to a scene change while offline. Start Ollama (`ollama run gemma4:31b-cloud`) for full natural-language control, or try things like “sunset lighting”, “make it mountainous with rivers”, “japanese architecture”, or “make all roads 25% wider”.",
      commands: [],
    };
  }

  const reply =
    notes.length === 1
      ? `Done — ${notes[0]}.`
      : `Done — ${notes.slice(0, -1).join(', ')}, and ${notes[notes.length - 1]}.`;
  return { reply, commands };
}
