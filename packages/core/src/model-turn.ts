/**
 * The model function an agent session calls for each turn: resolves the model in the provider registry, passes
 * the tools when the provider can call tools, and reports the measured writing speed. Moved out of
 * conversations.ts (t7); conversations.ts re-exports what it exported before.
 */
import type { PersonaParams } from "./personas.js";
import { type ModelTurn } from "@kesher/agent";
import type { ProviderRegistry } from "@kesher/providers";

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
 * @returns The turn function.
 */
export function modelTurnFor(registry: ProviderRegistry, modelId: string, params?: PersonaParams): ModelTurn {
  const inner = rawTurnFor(registry, modelId, params);
  return async (req, signal, onText) => {
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

function rawTurnFor(registry: ProviderRegistry, modelId: string, params?: PersonaParams): ModelTurn {
  return async (req, signal, onText) => {
    const { provider, providerModelId } = registry.resolve(modelId);
    // A persona's own settings (temperature, top_p, stop), when it has them.
    const sampling = { ...(params?.temperature !== undefined ? { temperature: params.temperature } : {}), ...(params?.topP !== undefined ? { topP: params.topP } : {}), ...(params?.stop?.length ? { stop: params.stop } : {}) };
    if (provider.chatWithTools) {
      return provider.chatWithTools({ providerModelId, messages: req.messages, tools: req.tools, ...sampling }, signal, onText);
    }
    if (!provider.chat) throw new Error(`${modelId} is not a chat model.`);
    let text = "";
    const messages = req.messages
      .filter((m) => m.role !== "tool")
      .map((m) => ({ role: m.role, content: m.content }));
    for await (const ev of provider.chat({ providerModelId, messages, ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}) }, signal)) {
      if (ev.type === "delta") {
        text += ev.text;
        onText(ev.text);
      } else if (ev.type === "error") throw new Error(ev.message);
    }
    return { text, toolCalls: [] };
  };
}
