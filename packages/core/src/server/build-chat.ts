/**
 * The chat side's start (docs/ARCHITECTURE_REVIEW.md B4, first part): the providers from the settings, then the local
 * servers found running (LM Studio, Ollama…). Personas, skills, MCP and the conversation manager follow.
 */
import { PROVIDER_PRESETS, type ProviderRegistry } from "@kesher/providers";
import { join } from "node:path";
import { seedBuiltinSkills } from "../builtin-skills.js";
import type { DataPaths, KesherConfig } from "../config.js";
import { Personas } from "../personas.js";
import { SkillStore } from "../skill-store.js";

/**
 * Adds the providers from the settings (one that cannot be made is skipped with a warning), then, when asked, tries
 * each auto-detectable preset not set up yet and keeps the ones that answer within 1.5 s.
 *
 * @param registry - The providers (plugins have added their types already).
 * @param config - The settings.
 * @param autodetect - Whether to look for local servers.
 * @returns The ids of the presets found running.
 */
export async function addProviders(registry: ProviderRegistry, config: KesherConfig, autodetect: boolean): Promise<Set<string>> {
  for (const p of config.providers) {
    try {
      registry.add(p);
    } catch (err) {
      console.warn(`[providers] skipping "${p.id}": ${(err as Error).message}`);
    }
  }
  const autodetected = new Set<string>();
  if (autodetect) {
    await Promise.all(
      PROVIDER_PRESETS.filter((preset) => preset.autodetect && !registry.get(preset.config.id)).map(async (preset) => {
        const provider = registry.add(preset.config);
        if (await provider.checkHealth(AbortSignal.timeout(1500))) autodetected.add(preset.config.id);
        else registry.remove(preset.config.id);
      }),
    );
  }
  return autodetected;
}

/**
 * The personas and the skills. Both read their files in the background; the skills KesherAI ships with (materials,
 * VFX, level design) are written first, keeping the user's own edits.
 *
 * @param paths - The data folders.
 * @returns The two stores.
 */
export function openPersonasAndSkills(paths: DataPaths): { personas: Personas; skills: SkillStore } {
  const personas = new Personas(join(paths.root, "personas.json"));
  const skills = new SkillStore(paths.skills);
  void seedBuiltinSkills(paths.skills).then(() => skills.list()).catch(() => undefined);
  void skills.list().catch(() => undefined);
  void personas.load();
  return { personas, skills };
}
