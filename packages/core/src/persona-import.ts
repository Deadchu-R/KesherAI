import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanParams, type PersonaParams } from "./personas.js";

/**
 * Personas from other apps: LM Studio presets (a system prompt and settings,
 * `.lmstudio/config-presets/*.preset.json`) and Ollama models made with a
 * Modelfile (`SYSTEM`, `PARAMETER`, `MESSAGE`, kept as layers of the model's
 * manifest). Their files are only read. See docs/RESEARCH_LOG.md for the
 * formats (an LM Studio preset was read on Roee's PC).
 */

/** A persona another app has. */
export interface FoundPersona {
  app: "LM Studio" | "Ollama";
  /** Its name there (the preset's name, or the Ollama model, e.g. `coder:latest`). */
  name: string;
  instructions: string;
  params?: PersonaParams;
  /** Opening suggestions (an Ollama model's example user messages). */
  starters?: string[];
}

/** LM Studio keeps every setting as a `{ key, value }` field. */
interface PresetFile { name?: unknown; operation?: { fields?: Array<{ key?: unknown; value?: unknown }> } }

/**
 * Reads one LM Studio preset.
 *
 * @param json - The preset file's JSON.
 * @returns The persona, or undefined when it has no system prompt.
 */
export function fromLmStudioPreset(json: unknown): FoundPersona | undefined {
  const p = json as PresetFile;
  const fields = new Map((p?.operation?.fields ?? []).filter((f) => typeof f?.key === "string").map((f) => [f.key as string, f.value]));
  const prompt = fields.get("llm.prediction.systemPrompt");
  if (typeof prompt !== "string" || !prompt.trim() || typeof p.name !== "string") return undefined;
  const stop = fields.get("llm.prediction.stopStrings");
  const params = cleanParams({ temperature: fields.get("llm.prediction.temperature"), topP: num(fields.get("llm.prediction.topPSampling")), stop: Array.isArray(stop) ? stop : [] });
  return { app: "LM Studio", name: p.name.slice(0, 60), instructions: prompt.trim(), ...(params ? { params } : {}) };
}

/** LM Studio may keep a setting as `{ checked, value }`. */
function num(v: unknown): unknown {
  return v && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v;
}

/**
 * Reads an Ollama model's Modelfile parts from its layers.
 *
 * @param name - The model (`coder:latest`).
 * @param layers - Its `system`, `params` and `messages` layers' text.
 * @returns The persona, or undefined when the model has no system prompt (a plain downloaded model).
 */
export function fromOllamaLayers(name: string, layers: { system?: string; params?: string; messages?: string }): FoundPersona | undefined {
  const system = layers.system?.trim();
  if (!system) return undefined;
  let raw: Record<string, unknown> = {};
  try {
    raw = layers.params ? (JSON.parse(layers.params) as Record<string, unknown>) : {};
  } catch {
    // no settings
  }
  const params = cleanParams({ temperature: raw.temperature, topP: raw.top_p, stop: raw.stop });
  let starters: string[] = [];
  try {
    const msgs = layers.messages ? (JSON.parse(layers.messages) as Array<{ role?: string; content?: string }>) : [];
    starters = msgs.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim()).map((m) => m.content!.trim().slice(0, 300)).slice(0, 6);
  } catch {
    // no examples
  }
  return { app: "Ollama", name: name.slice(0, 60), instructions: system, ...(params ? { params } : {}), ...(starters.length ? { starters } : {}) };
}

/**
 * Everything found on this computer.
 *
 * @param home - Home folder (tests pass a temp folder).
 * @param env - Environment (`OLLAMA_MODELS`).
 * @returns Personas from LM Studio presets and Ollama Modelfiles.
 */
export async function findPersonas(home = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<FoundPersona[]> {
  const out: FoundPersona[] = [];
  const presets = join(home, ".lmstudio", "config-presets");
  for (const f of await readdir(presets).catch(() => [] as string[])) {
    if (!f.endsWith(".preset.json")) continue;
    const json = await readFile(join(presets, f), "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);
    const p = fromLmStudioPreset(json);
    if (p) out.push(p);
  }
  const models = env.OLLAMA_MODELS ?? join(home, ".ollama", "models");
  const walk = async (dir: string, parts: string[]): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (parts.length < 4) await walk(full, [...parts, e.name]);
        continue;
      }
      const manifest = await readFile(full, "utf8").then((t) => JSON.parse(t) as { layers?: Array<{ mediaType?: string; digest?: string }> }, () => undefined);
      if (!manifest?.layers) continue;
      const blob = async (kind: string) => {
        const d = manifest.layers!.find((l) => l.mediaType === `application/vnd.ollama.image.${kind}`)?.digest;
        return d ? readFile(join(models, "blobs", d.replace(":", "-")), "utf8").catch(() => undefined) : undefined;
      };
      // manifests/registry.ollama.ai/library/<model>/<tag> → model:tag; other namespaces keep their prefix.
      const [, ns, ...rest] = parts;
      const model = ns === "library" ? rest.join("/") : [ns, ...rest].join("/");
      const system = await blob("system");
      if (!system) continue;
      const [params, messages] = await Promise.all([blob("params"), blob("messages")]);
      const p = fromOllamaLayers(`${model}:${e.name}`, { system, ...(params ? { params } : {}), ...(messages ? { messages } : {}) });
      if (p) out.push(p);
    }
  };
  await walk(join(models, "manifests"), []);
  return out;
}

/** A persona file from LobeHub (an agent) or Open WebUI (exported workspace models). */
export type PersonaFileSource = "LobeHub" | "Open WebUI";

/**
 * Reads personas from an exported file: a LobeHub agent (`{ meta, config:
 * { systemRole, params } }`, one or a list) or Open WebUI's exported models
 * (a list of `{ name, params: { system, temperature, top_p, stop },
 * meta: { suggestion_prompts } }`). The format is read from the content.
 *
 * @param json - The file's JSON.
 * @returns What it holds, and where it is from.
 */
export function personasFromFile(json: unknown): { source: PersonaFileSource; personas: Array<Omit<FoundPersona, "app"> & { icon?: string }> } | undefined {
  const list = Array.isArray(json) ? json : [json];
  const objs = list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
  if (!objs.length) return undefined;
  const isLobe = objs.some((o) => o.config && typeof o.config === "object" && typeof (o.config as Record<string, unknown>).systemRole === "string");
  const isOwui = objs.some((o) => o.params && typeof o.params === "object" && typeof (o.params as Record<string, unknown>).system === "string");
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (isLobe) {
    const personas = objs.flatMap((o) => {
      const config = (o.config ?? {}) as Record<string, unknown>;
      const meta = (o.meta ?? {}) as Record<string, unknown>;
      const instructions = text(config.systemRole);
      if (!instructions) return [];
      const p = (config.params ?? {}) as Record<string, unknown>;
      const params = cleanParams({ temperature: p.temperature, topP: p.top_p });
      const name = text(meta.title) || text(o.identifier) || "LobeHub agent";
      const icon = text(meta.avatar);
      return [{ name: name.slice(0, 60), instructions, ...(params ? { params } : {}), ...(icon && [...icon].length <= 2 ? { icon } : {}) }];
    });
    return personas.length ? { source: "LobeHub", personas } : undefined;
  }
  if (isOwui) {
    const personas = objs.flatMap((o) => {
      const p = (o.params ?? {}) as Record<string, unknown>;
      const instructions = text(p.system);
      if (!instructions) return [];
      const meta = (o.meta ?? {}) as Record<string, unknown>;
      const params = cleanParams({ temperature: p.temperature, topP: p.top_p, stop: p.stop });
      const starters = (Array.isArray(meta.suggestion_prompts) ? meta.suggestion_prompts : [])
        .map((s) => (s && typeof s === "object" ? text((s as Record<string, unknown>).content) : text(s)))
        .filter(Boolean)
        .slice(0, 6);
      return [{ name: (text(o.name) || text(o.id) || "Open WebUI model").slice(0, 60), instructions, ...(params ? { params } : {}), ...(starters.length ? { starters } : {}) }];
    });
    return personas.length ? { source: "Open WebUI", personas } : undefined;
  }
  return undefined;
}
