/**
 * The model function an agent session calls for each turn: resolves the model in the provider registry, passes
 * the tools when the provider can call tools, and reports the measured writing speed. Moved out of
 * conversations.ts (t7); conversations.ts re-exports what it exported before.
 */
import type { PersonaParams } from "./personas.js";
import { type ModelTurn } from "@kesher/agent";
import { OTHER_SCRIPTS_BIAS, thinkingLevels, type ThinkingLevel } from "@kesher/shared";
import type { ProviderRegistry, SlotKind } from "@kesher/providers";
import { isFreeCloudModel } from "./free-cloud.js";
import { guardMessages } from "./privacy-guard.js";

/**
 * The most tokens one turn of a local (llama.cpp) model may write, reasoning included. A thinking model once wrote
 * 15,306 tokens of reasoning before one tool call; at this limit the turn ends and the session asks for a brief
 * answer (`truncated`, session.ts). Cloud models keep their own limits.
 */
export const LOCAL_TURN_MAX_TOKENS = 8192;

let speedRecorder: ((modelId: string, tokens: number, ms: number) => void) | undefined;

/**
 * Where measured speeds go (the server keeps them per model, for "measured
 * N tokens/s" next to models instead of an estimate).
 *
 * @param fn - Gets the model, the tokens it wrote (about), and the time it took.
 */
export function onModelSpeed(fn: typeof speedRecorder): void {
  speedRecorder = fn;
}

/**
 * Builds the model function an agent session calls for each turn. Providers
 * with tool calling get the tools; chat-only providers (some plugins) still
 * work, just without tools.
 *
 * @param registry - Provider registry.
 * @param modelId - Global model id.
 * @param params - A persona's sampling settings, if any.
 * @param slotKind - Who asks (the chat's main model, a helper, or other), so llama.cpp keeps each kind's prompt
 *   cache in its own slot. Default `other`.
 * @param opts.thinking - The chat's thinking level, read at each call (it can change mid-chat; thinking.ts). Unset
 *   means a helper job: thinking is turned off for models that can (a short direct answer).
 * @param opts.unattended - No one watches the run (task inbox, self-work): read by the privacy guard at each call.
 * @returns The turn function.
 */
export function modelTurnFor(registry: ProviderRegistry, modelId: string, params?: PersonaParams, slotKind?: SlotKind, opts: { thinking?: () => ThinkingLevel | undefined; noCloud?: () => boolean; fallback?: () => ModelTurn | undefined; unattended?: () => boolean } = {}): ModelTurn {
  // Only the chat's own model passes a thinking level (the user's choice). Every other caller (router, inline code,
  // translator, titles, summaries, reports) wants a short direct answer, so a reasoning model gets thinking off.
  const inner = rawTurnFor(registry, modelId, params, slotKind, opts.thinking ?? (() => "off"));
  return async (req, signal, onText) => {
    // A chat marked "never to the cloud" (incognito) is never sent to a free cloud provider, even when it is picked.
    if (isFreeCloudModel(modelId) && opts.noCloud?.()) throw new Error("This chat is private (incognito): it is never sent to the cloud. Choose a local model.");
    // A service that may train on what it is sent gets sensitive things hidden (or nothing at all): privacy-guard.ts.
    const guarded = guardMessages(modelId, req.messages, { unattended: opts.unattended?.() === true });
    if (guarded.hidden) req = { ...req, messages: guarded.messages };
    let first = 0;
    let chars = 0;
    const once = () =>
      inner(req, signal, (t) => {
        if (!first) first = Date.now();
        chars += t.length;
        onText(t);
      });
    let r;
    try {
      r = await once();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // Nothing listens there at all (LM Studio or Ollama not running): say so, not "the conversation is too long"
      // (found on the PC: a night routine on an LM Studio model, with LM Studio closed).
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if ((code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) && !signal?.aborted && chars === 0) {
        // The user allowed free cloud helpers when the local model is off (Settings), and this chat may go to the cloud.
        const alt = opts.noCloud?.() ? undefined : opts.fallback?.();
        if (alt) return alt(req, signal, onText);
      }
      if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) {
        throw new Error(`The model server for ${modelId} is not running (nothing answers at its address). Start it (e.g. LM Studio or Ollama), or choose another model for this chat or routine.`);
      }
      // The model server dropped the connection (a local server restarting, or out of memory/context).
      const dropped = /terminated|ECONNRESET|socket hang up|fetch failed|other side closed/i.test(msg);
      if (!dropped || signal?.aborted) throw err;
      // Little or nothing was written yet: try once more, after a moment.
      if (chars < 200) {
        await new Promise((res) => setTimeout(res, 3000));
        try {
          r = await once();
        } catch (again) {
          throw new Error(`The model server closed the connection twice (${(again as Error).message}). This often means the conversation is longer than the model's context: start a new chat, or load the model with a bigger context.`);
        }
      } else {
        throw new Error(`The model server closed the connection while answering (${msg}). This often means the conversation is longer than the model's context: say "continue", start a new chat, or load the model with a bigger context.`);
      }
    }
    // Speed of writing (after the first word), so reading a long prompt does not count against it.
    const ms = first ? Date.now() - first : 0;
    if (chars > 200 && ms > 500) speedRecorder?.(modelId, Math.round(chars / 4), ms);
    return r;
  };
}

function rawTurnFor(registry: ProviderRegistry, modelId: string, params?: PersonaParams, slotKind?: SlotKind, thinkingOf?: () => ThinkingLevel | undefined): ModelTurn {
  return async (req, signal, onText) => {
    const { provider, providerModelId } = registry.resolve(modelId);
    // A persona's own settings (temperature, top_p, stop), when it has them.
    const sampling = { ...(params?.temperature !== undefined ? { temperature: params.temperature } : {}), ...(params?.topP !== undefined ? { topP: params.topP } : {}), ...(params?.stop?.length ? { stop: params.stop } : {}) };
    if (provider.chatWithTools) {
      // A Hebrew answer from a local llama.cpp model: other alphabets made unlikely (language confusion).
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const he = (last?.content.match(/[\u0590-\u05FF]/g) ?? []).length;
      const hebrew = provider.id === "llamacpp" && he >= 2 && he >= (last?.content.match(/[A-Za-z]/g) ?? []).length;
      // Only for a local model the menu offers levels for (a cloud model or an unknown family is left as it is).
      const level = thinkingOf?.();
      const thinking = level && thinkingLevels(provider.id, providerModelId, provider.location).includes(level) ? level : undefined;
      return provider.chatWithTools({ providerModelId, messages: req.messages, tools: req.tools, ...sampling, ...(provider.id === "llamacpp" ? { maxTokens: req.maxTokens ?? LOCAL_TURN_MAX_TOKENS } : req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(hebrew ? { logitBias: OTHER_SCRIPTS_BIAS } : {}), ...(slotKind ? { slotKind } : {}), ...(thinking ? { thinking } : {}) }, signal, onText);
    }
    if (!provider.chat) throw new Error(`${modelId} is not a chat model.`);
    let text = "";
    const messages = req.messages
      .filter((m) => m.role !== "tool")
      .map((m) => ({ role: m.role, content: m.content }));
    const level = thinkingOf?.();
    const thinking = level && thinkingLevels(provider.id, providerModelId, provider.location).includes(level) ? level : undefined;
    for await (const ev of provider.chat({ providerModelId, messages, ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}), ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}), ...(thinking ? { thinking } : {}) }, signal)) {
      if (ev.type === "delta") {
        text += ev.text;
        onText(ev.text);
      } else if (ev.type === "error") throw new Error(ev.message);
    }
    return { text, toolCalls: [] };
  };
}
