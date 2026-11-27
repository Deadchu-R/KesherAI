/**
 * Sampling presets per model family for local (llama.cpp) models. The agent loop sent no temperature, top_p or top_k,
 * so llama-server's own defaults applied (temperature 0.8, top_k 40, min_p 0.05), which the vendors do not recommend
 * for the newer families. The values below are the vendors' own (model cards; sources in docs/RESEARCH_LOG.md,
 * "2026-11-28 sampling presets"). A family with no official value has no preset: llama's defaults stay.
 *
 * A preset is used only when the user has not set sampling for that model: no `--temp`, `--top-p`, `--top-k`,
 * `--min-p`, `--presence-penalty` or `--repeat-penalty` in the model's own arguments, and the model's "use llama.cpp
 * defaults" switch is off. A persona's own temperature or top_p wins for that field. Cloud models never get one.
 */
import { isReasoningModel } from "./thinking.js";
import type { ModelLoadSettings } from "./model-args.js";

/** The sampling fields a preset sets (llama.cpp's names are in the provider). */
export interface SamplingValues {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
}

/** A model family, as far as sampling goes. */
export type SamplingFamily = "qwen" | "gemma" | "glm" | "deepseek" | "llama" | "mistral" | "phi" | "other";

/** What kind of turn asks: the agent loop (tool turns, where JSON must stay exact) or plain chat. */
export interface SamplingMode {
  /** True for a turn that carries tools. */
  agent: boolean;
  /** Whether the model thinks first (Qwen's card has different values for it). */
  thinking: boolean;
}

/** One preset chosen for a model and a mode. */
export interface SamplingPreset {
  family: SamplingFamily;
  /** For the settings line, e.g. `Qwen 3.6`. */
  label: string;
  values: SamplingValues;
}

/**
 * Which family a model belongs to, from its id or GGUF file name.
 *
 * @param name - E.g. `Qwen_Qwen3.6-27B-Q4_K_M.gguf`, `llamacpp/gemma-4-26b-a4b-it-Q4_K_M` or `Llama-3.3-70B-Instruct`.
 * @returns The family, or `other`.
 */
export function samplingFamily(name: string): SamplingFamily {
  const n = name.toLowerCase();
  if (/qwen|qwq/.test(n)) return "qwen";
  if (/gemma/.test(n)) return "gemma";
  if (/glm/.test(n)) return "glm";
  if (/deepseek/.test(n)) return "deepseek";
  if (/llama/.test(n)) return "llama";
  if (/mistral|ministral|magistral|devstral|mixtral/.test(n)) return "mistral";
  if (/(^|[^a-z])phi-?\d/.test(n)) return "phi";
  return "other";
}

/**
 * The preset for a model and a kind of turn.
 *
 * Qwen3.5 and Qwen3.6 (card "Best Practices"): thinking, general tasks use temperature 1.0 (presence penalty 1.5 on
 * 3.5, 0 on 3.6); precise coding uses 0.6 with no penalty; non-thinking uses 0.7, top_p 0.8, presence penalty 1.5.
 * Agent turns use the coding values: a presence penalty would punish the quotes and brackets of tool-call JSON.
 * Gemma 4: one setting for every use. GLM-4.7: default 1.0 / 0.95, coding and terminal 0.7 / 1.0. DeepSeek R1 0.6 /
 * 0.95 and V3.2 1.0 / 0.95. Mistral Small 3.2: temperature 0.15. Llama and Phi: no confirmed official value, unset.
 *
 * @param name - The model's id or file name.
 * @param mode - Agent turn or plain chat, and whether it thinks.
 * @returns The preset, or `undefined` when the family has no official value (llama's defaults apply).
 */
export function samplingPreset(name: string, mode: SamplingMode): SamplingPreset | undefined {
  const n = name.toLowerCase();
  const family = samplingFamily(n);
  const make = (label: string, values: SamplingValues): SamplingPreset => ({ family, label, values });
  if (family === "qwen") {
    const v = /qwen-?3\.([56])/.exec(n)?.[1];
    if (!v) return undefined;
    const label = `Qwen 3.${v}`;
    if (mode.agent) return make(label, { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0 });
    if (mode.thinking) return make(label, { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: v === "5" ? 1.5 : 0 });
    return make(label, { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 });
  }
  if (family === "gemma" && /gemma-?4/.test(n)) return make("Gemma 4", { temperature: 1.0, topP: 0.95, topK: 64 });
  if (family === "glm" && /glm-?4\.7/.test(n)) return make("GLM-4.7", mode.agent ? { temperature: 0.7, topP: 1.0 } : { temperature: 1.0, topP: 0.95 });
  if (family === "deepseek") {
    if (/r1/.test(n)) return make("DeepSeek R1", { temperature: 0.6, topP: 0.95 });
    if (/v3\.2/.test(n)) return make("DeepSeek V3.2", { temperature: 1.0, topP: 0.95 });
    return undefined;
  }
  if (family === "mistral" && /small-?3[.-]2/.test(n)) return make("Mistral Small 3.2", { temperature: 0.15 });
  return undefined;
}

/** The llama-server flags that set sampling; any of them in a model's own arguments means the user chose. */
const SAMPLING_FLAGS = new Set(["--temp", "--temperature", "--top-k", "--top-p", "--min-p", "--presence-penalty", "--repeat-penalty"]);

/**
 * Whether the user has taken sampling into their own hands for a model: the "llama.cpp defaults" switch, or sampling
 * flags among the model's own arguments (those apply to every request and the preset must not override them).
 *
 * @param settings - The model's saved load settings.
 * @returns True when no preset may be applied.
 */
export function userSamplingWins(settings: ModelLoadSettings | undefined): boolean {
  return !!settings && (settings.samplingOff === true || !!settings.extra?.some((a) => SAMPLING_FLAGS.has(a)));
}

/**
 * The sampling values a request to a local model carries.
 *
 * @param name - The model's id or file name.
 * @param mode - Agent turn or plain chat, and thinking.
 * @param settings - The model's saved load settings, if any.
 * @param persona - A persona's own temperature and top_p, which win for their field.
 * @returns The values to send; empty when the user's own settings apply or the family has no preset.
 */
export function samplingFor(name: string, mode: SamplingMode, settings: ModelLoadSettings | undefined, persona?: Pick<SamplingValues, "temperature" | "topP">): SamplingValues {
  if (userSamplingWins(settings)) return {};
  const p = samplingPreset(name, mode)?.values;
  if (!p) return {};
  return { ...p, ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}), ...(persona?.topP !== undefined ? { topP: persona.topP } : {}) };
}

/**
 * The line a model's settings show: where its sampling comes from.
 *
 * @param name - The model's id or file name.
 * @param settings - The model's saved load settings, if any.
 * @param thinking - Whether the model thinks by default (for the chat values).
 * @returns `state`: `custom` (the user's own), `off` (llama.cpp defaults chosen), `preset` or `none` (no official value);
 *   with the family's label and its agent and chat values whenever it has a preset (so the switch can turn it back on).
 */
export function samplingSummary(name: string, settings: ModelLoadSettings | undefined, thinking = isReasoningModel(name)): { state: "custom" | "off" | "preset" | "none"; label?: string; agent?: SamplingValues; chat?: SamplingValues } {
  const agent = samplingPreset(name, { agent: true, thinking });
  const preset = agent ? { label: agent.label, agent: agent.values, chat: samplingPreset(name, { agent: false, thinking })?.values ?? {} } : {};
  if (settings?.samplingOff) return { state: "off", ...preset };
  if (userSamplingWins(settings)) return { state: "custom", ...preset };
  return agent ? { state: "preset", ...preset } : { state: "none" };
}
