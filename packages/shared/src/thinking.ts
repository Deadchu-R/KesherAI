/**
 * How much a local reasoning model thinks before it answers (docs/FEATURE_REVIEW.md, 2026-11-21: Open WebUI 0.12,
 * LM Studio 1.2.2 and Jan 0.8 have a per-chat thinking control). The model menu offers it only for models known to
 * think, and only the levels the model's server can apply:
 * - llama.cpp (KesherAI's own engine): `chat_template_kwargs` (`enable_thinking` for Qwen3, GLM, SmolLM3 and
 *   friends; `reasoning_effort` for gpt-oss), so off, low and high all work.
 * - Other OpenAI-style local servers (LM Studio, Ollama): the standard `reasoning_effort` field, low or high only
 *   (an unknown "none" is refused by some of them).
 * - Cloud models and outside agents: nothing here (they have their own controls).
 */

/** The chat's thinking choice; unset means the model's own default. */
export type ThinkingLevel = "off" | "low" | "high";

/** Every level, in the menu's order. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "high"];

/**
 * Model names (any case) of local families that think before answering. Coder and "instruct" builds of Qwen3 do not.
 */
const REASONING = /qwen3(?![\w.-]*(?:coder|instruct))|qwq|deepseek-?r1|gpt-oss|magistral|phi-?4[\w-]*reasoning|glm-?4\.[5-9]|glm-?[5-9]|smollm3|exaone-?deep|granite[\w.-]*thinking|thinking|seed-oss|hermes-?4|nemotron[\w.-]*(?:nano|super)/i;

/**
 * Whether a model is known to think before it answers.
 *
 * @param name - The model's id or file name (e.g. `llamacpp/Qwen3.8-27B-Q4.gguf`).
 * @returns True for the reasoning families listed above.
 */
export function isReasoningModel(name: string): boolean {
  return REASONING.test(name);
}

/**
 * The levels the model menu offers for a model.
 *
 * @param providerId - The model's connection (`llamacpp`, `lmstudio`, `ollama`, …).
 * @param name - The model's id or file name.
 * @param location - Where it runs; cloud models get none.
 * @returns The levels, or an empty list when the picker should be hidden.
 */
export function thinkingLevels(providerId: string, name: string, location?: "local" | "server" | "cloud"): ThinkingLevel[] {
  if (location === "cloud" || providerId.startsWith("agent") || !isReasoningModel(name)) return [];
  return providerId === "llamacpp" ? [...THINKING_LEVELS] : ["low", "high"];
}

/**
 * The request fields for a thinking level.
 *
 * @param level - The chat's choice; unset sends nothing.
 * @param llamaCpp - Whether the server is llama.cpp's (chat template flags) or another OpenAI-style one.
 * @returns Fields to add to the chat completion's body.
 */
export function thinkingFields(level: ThinkingLevel | undefined, llamaCpp: boolean): Record<string, unknown> {
  if (!level) return {};
  if (llamaCpp) return { chat_template_kwargs: { enable_thinking: level !== "off", reasoning_effort: level === "off" ? "low" : level } };
  return level === "off" ? {} : { reasoning_effort: level };
}
