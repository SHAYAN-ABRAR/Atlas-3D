import { BUILDING_STYLES, LIGHTING_PRESETS } from '@/config/constants';
import type { ChatMessage, OllamaStatus } from '@/types/chat';
import type { SceneCommand } from '@/types/commands';
import type { GeneratedWorld, WorldState } from '@/types/world';

/**
 * Client for an Ollama-compatible endpoint: a locally running instance
 * (everything stays on this machine) or the deployment's same-origin
 * /api/assistant proxy when one is configured.
 */

export interface OllamaConfig {
  url: string;
  model: string;
}

/**
 * Tolerates how endpoints actually get typed into the settings field:
 * stray whitespace, trailing slashes, a missing scheme. A malformed
 * stored URL must degrade to a fixable state, never a silent "offline".
 */
export function normalizeOllamaUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.startsWith('/')) return `/${u.replace(/^\/+/, '')}`; // same-origin path, e.g. the hosted assistant proxy
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u || 'http://127.0.0.1:11434';
}

export async function checkOllama(config: OllamaConfig): Promise<{
  status: OllamaStatus;
  models: string[];
}> {
  try {
    const res = await fetch(`${normalizeOllamaUrl(config.url)}/api/tags`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { status: 'offline', models: [] };
    const json = (await res.json()) as { models?: { name: string }[] };
    const models = (json.models ?? []).map((m) => m.name);
    const wanted = config.model.trim();
    const base = wanted.split(':')[0];
    const hasModel = models.some((m) => m === wanted || m.startsWith(base));
    return { status: hasModel ? 'online' : 'model-missing', models };
  } catch {
    return { status: 'offline', models: [] };
  }
}

export function buildSystemPrompt(world: WorldState, generated: GeneratedWorld): string {
  const s = generated.stats;
  return `You are Atlas, the scene assistant inside Atlas 3D — a local app that turns 2D maps into explorable procedural 3D worlds.

CURRENT SCENE
- terrain: ${world.terrain.style}, amplitude ${world.terrain.amplitude}, rivers ${world.terrain.rivers}, water level ${world.terrain.waterLevel}
- city: ${world.city.enabled ? `${world.city.style} / ${world.city.layout}, density ${world.city.density}, max ${world.city.maxFloors} floors` : 'disabled'}
- roads: width x${world.roads.widthScale}${world.roads.sidewalks ? ', sidewalks' : ''}
- vegetation: ${world.vegetation.enabled ? `${world.vegetation.style}, density ${world.vegetation.density}` : 'disabled'}
- lighting: ${world.lighting.preset}, fog ${world.lighting.fog}
- materials override: ${world.materials.override}
- stats: ${s.buildings} buildings (tallest ${s.tallestBuilding.toFixed(0)}m), ${s.trees} trees, ${(s.roadLength / 1000).toFixed(1)}km roads, water ${(s.waterCoverage * 100).toFixed(0)}%, green ${(s.greenCoverage * 100).toFixed(0)}%
- uploaded map: ${world.map.enabled && world.map.analysis ? `guiding generation (${world.map.analysis.sourceName})` : 'none'}

HOW TO CHANGE THE SCENE
When the user asks for scene changes, reply with one short conversational sentence, then a single fenced block tagged "atlas" containing JSON: {"commands":[...]}. Emit ONLY these actions:
- {"action":"generate_world","template":"medieval-kingdom|cyberpunk-district|modern-city|island-village|mountain-wilds|nordic-harbor"}
- {"action":"reseed"}
- {"action":"set_terrain","style":"flat|plains|rolling|mountains|islands|canyon","amplitude":num,"waterLevel":0..1,"rivers":num}
- {"action":"set_buildings","style":"${Object.keys(BUILDING_STYLES).join('|')}","layout":"grid|organic|radial","density":0..1,"maxFloors":num,"enabled":bool}
- {"action":"set_roads","widthMultiplier":num,"sidewalks":bool}   (widthMultiplier 1.25 = 25% wider)
- {"action":"set_vegetation","style":"mixed|pine|oak|palm|sparse","density":0..1,"enabled":bool}
- {"action":"set_water","enabled":bool,"level":0..1}
- {"action":"set_lighting","preset":"${Object.keys(LIGHTING_PRESETS).join('|')}","fog":0..1}
- {"action":"set_weather","particles":"none|rain|snow|fireflies|embers"}
- {"action":"set_materials","override":"none|marble|walnut|concrete|sandstone|obsidian|copper"}
- {"action":"camera_flythrough"}
- {"action":"optimize","level":"mobile|balanced|quality"}
- {"action":"stats"}

For pure questions (counts, sizes, advice on floor plans, tutorials about controls) answer in plain text using the scene facts above — no command block. Camera: orbit = drag, walk mode = key 2 + WASD, fly = key 3. Never invent actions outside the list. Keep answers under 120 words.`;
}

export async function streamChat(opts: {
  config: OllamaConfig;
  system: string;
  messages: ChatMessage[];
  onToken: (full: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { config, system, messages, onToken, signal } = opts;
  const res = await fetch(`${normalizeOllamaUrl(config.url)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: config.model.trim(),
      stream: true,
      messages: [
        { role: 'system', content: system },
        ...messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  if (!res.ok || !res.body) {
    // Surface Ollama's own explanation (e.g. "this model requires a
    // subscription") — it's actionable, unlike a bare status code.
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // No JSON body — fall back to the status code.
    }
    throw new Error(detail || `Ollama responded ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (json.message?.content) {
          full += json.message.content;
          onToken(full);
        }
      } catch {
        // Partial line — ignored, completed on next chunk.
      }
    }
  }
  return full;
}

/** Extracts {"commands":[...]} from ```atlas / ```json fenced blocks (or bare JSON). */
export function parseSceneCommands(text: string): SceneCommand[] {
  const commands: SceneCommand[] = [];
  const fenceRe = /```(?:atlas|json)?\s*([\s\S]*?)```/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) candidates.push(match[1]);
  if (candidates.length === 0) {
    const braceIdx = text.indexOf('{"commands"');
    if (braceIdx >= 0) candidates.push(text.slice(braceIdx));
  }
  for (const raw of candidates) {
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) continue;
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        commands?: unknown;
        action?: string;
      };
      if (Array.isArray(parsed.commands)) {
        for (const c of parsed.commands)
          if (c && typeof c === 'object' && 'action' in c) commands.push(c as SceneCommand);
      } else if (parsed.action) {
        commands.push(parsed as SceneCommand);
      }
    } catch {
      // Malformed block — skip.
    }
  }
  return commands;
}

/** Removes command fences so chat bubbles read cleanly. */
export function stripCommandBlocks(text: string): string {
  return text
    .replace(/```(?:atlas|json)?\s*\{[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
