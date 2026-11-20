/**
 * Routing a message to tools by meaning (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", step 8 / C1).
 *
 * Tool search sends a local model only its everyday tools in full and lists the rest by name; the session loaded the
 * others only when the message held a tool's own English word, so a Hebrew request ("תצייר לי חתול") never got
 * generate_image. Before the model answers, the router picks 1-3 tool groups (chat-tool-groups.ts):
 * 1. by words, Hebrew and English (always; free);
 * 2. when the built-in engine is running, by a tiny call to the model it has loaded (no swap), with JSON output held to
 *    the group ids by a schema (llama.cpp turns it into a grammar), a short timeout, and a cache per message.
 * The model's answer adds to the words' answer; when it is slow or fails, the words alone decide.
 *
 * It also tells the model when a group the message needs has no tools because something is not installed (an image
 * model, a video model), so it offers the Install button (offer_install) instead of a workaround.
 */
import { llamaCppFields } from "@kesher/providers";
import { CHAT_TOOL_GROUPS, groupOfTool, groupsByWords } from "./chat-tool-groups.js";

/**
 * Asks a model for JSON held to a schema.
 *
 * @param system - The instructions.
 * @param user - The message to classify.
 * @param schema - A JSON schema the answer must match.
 * @param signal - Stops the call (the router's timeout).
 * @returns The model's raw answer.
 */
export type AskJson = (system: string, user: string, schema: Record<string, unknown>, signal: AbortSignal) => Promise<string>;

/** What the router decided for one message. */
export interface Route {
  /** The groups the message needs. */
  groups: string[];
  /** The chat's tools in those groups, sorted by name (a stable prompt). */
  tools: string[];
  /** Groups the message needs whose tools are missing, with what installs them. */
  missing: Array<{ group: string; needs: string }>;
}

const SYSTEM = `You route a user's request to tool groups. Answer with JSON only: {"groups": [...]} with 0 to 3 ids from the list, the ones the request needs, most needed first. Requests may be in Hebrew or English. Groups:\n${CHAT_TOOL_GROUPS.map((g) => `- ${g.id}: ${g.about}`).join("\n")}`;

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { groups: { type: "array", items: { type: "string", enum: CHAT_TOOL_GROUPS.map((g) => g.id) }, maxItems: 3 } },
  required: ["groups"],
};

/** Reads the model's answer: known group ids only, at most three. */
export function parseGroups(raw: string): string[] {
  const known = new Set(CHAT_TOOL_GROUPS.map((g) => g.id));
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { groups?: unknown };
    return Array.isArray(j.groups) ? [...new Set(j.groups.filter((x): x is string => typeof x === "string" && known.has(x)))].slice(0, 3) : [];
  } catch {
    return [];
  }
}

/** Routes messages to tool groups; one per conversation manager (its cache is shared by the chats). */
export class ToolRouter {
  private readonly cache = new Map<string, string[]>();

  /**
   * @param opts.ask - The built-in engine's JSON call, or undefined while it is not running (words only).
   * @param opts.timeoutMs - How long the model may take (default 2.5 s; it runs before every answer).
   * @param opts.cacheSize - Messages remembered (default 200).
   */
  constructor(private readonly opts: { ask?: () => AskJson | undefined; timeoutMs?: number; cacheSize?: number } = {}) {}

  /**
   * The groups a message needs: its words, and the model's pick when it can be asked.
   *
   * @param text - The user's message.
   * @param useModel - Whether to ask the model (only when tool search is on, i.e. the routing changes what is sent).
   * @param signal - Stops the call with the user's Stop.
   * @returns Group ids.
   */
  async groups(text: string, useModel: boolean, signal?: AbortSignal): Promise<string[]> {
    const byWords = groupsByWords(text);
    const key = text.trim().slice(0, 2000);
    const ask = useModel && key.length > 2 ? this.opts.ask?.() : undefined;
    if (!ask) return byWords;
    let byModel = this.cache.get(key);
    if (!byModel) {
      // A plain timer (AbortSignal.timeout's does not keep the process waiting, so a hung call could end it early).
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), this.opts.timeoutMs ?? 2500);
      const stop = AbortSignal.any([timer.signal, ...(signal ? [signal] : [])]);
      byModel = await ask(SYSTEM, key, SCHEMA, stop).then(parseGroups, () => undefined).finally(() => clearTimeout(t));
      if (byModel) {
        this.cache.set(key, byModel);
        if (this.cache.size > (this.opts.cacheSize ?? 200)) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return [...new Set([...(byModel ?? []), ...byWords])];
  }

  /**
   * Routes a message in one chat.
   *
   * @param text - The user's message.
   * @param available - The chat's tools (after its switches).
   * @param off - The groups the user turned off in this chat (never routed to, never offered for install).
   * @param useModel - See {@link ToolRouter.groups}.
   * @param signal - Stops the model call.
   * @returns The groups, their tools here, and what is missing.
   */
  async route(text: string, available: readonly string[], off: readonly string[], useModel: boolean, signal?: AbortSignal): Promise<Route> {
    const groups = (await this.groups(text, useModel, signal)).filter((g) => !off.includes(g));
    const tools = available.filter((n) => { const g = groupOfTool(n); return !!g && groups.includes(g); }).sort();
    const missing = groups.flatMap((id) => {
      const g = CHAT_TOOL_GROUPS.find((x) => x.id === id);
      return g?.needs && !available.some((n) => g.tools.test(n)) ? [{ group: id, needs: g.needs }] : [];
    });
    return { groups, tools, missing };
  }
}

/**
 * The line the model reads when a request needs something that is not installed.
 *
 * @param missing - From {@link ToolRouter.route}.
 * @returns The line, or undefined when nothing is missing.
 */
export function missingNote(missing: Route["missing"]): string | undefined {
  if (!missing.length) return undefined;
  const ids = missing.map((m) => `"${m.needs}"`).join(", ");
  return `[KesherAI] If this request needs something made with a tool that is not installed yet (${ids}), say so in one short sentence and call offer_install with that id, so the user gets an Install button; do not look for a workaround (no other libraries, no drawing with code). After it is installed the chat continues by itself. If the request does not need it (e.g. only reading a picture), ignore this.`;
}

/** Words of a request that needs real work even when it is short (code, files, a long or careful answer). */
const NOT_SIMPLE = /```|`|https?:\/\/|[\w-]+\.[a-z]{1,5}\b|[\\/]\w|\b(code|bug|fix|build|write|debug|explain|analy[sz]e|compare|plan|translate|summar|step by step|in detail|calculate|prove|essay|story|poem)\b|קוד|באג|תקן|תבנה|בנה|כתוב|תכתוב|הסבר|תסביר|נתח|השווה|תכנן|תרגם|סכם|תסכם|בפירוט|חשב|הוכח|חיבור|סיפור|שיר/i;

/** The longest message that can still be a simple turn (characters). */
const SIMPLE_CHARS = 160;

/**
 * Whether a message is a simple turn a smaller model answers as well as the big one: short, needs no tool group, and
 * asks for no code, files, links or a long or careful answer (a greeting, thanks, a yes/no, a short fact).
 *
 * @param text - The user's message.
 * @param groups - The groups the router picked for it.
 * @returns True for a simple turn.
 */
export function isSimpleTurn(text: string, groups: readonly string[]): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= SIMPLE_CHARS && groups.length === 0 && !t.includes("\n") && !NOT_SIMPLE.test(t);
}

/**
 * The built-in engine (llama.cpp) as an {@link AskJson}: its OpenAI-style endpoint with a JSON schema, thinking off,
 * temperature 0 and a few tokens. The instructions stay the same for every message, so the engine keeps them cached.
 *
 * The call is pinned to the engine's "other" slot when it has one per agent kind (llamaCppFields), so the router's
 * tiny prompt never pushes the chat's long prompt out of the main slot's cache.
 *
 * @param e - Where the engine listens, its key, whether a model is loaded now, and its slots (for the pin).
 * @returns The call, or undefined while no model is loaded.
 */
export function engineAsk(e: { baseUrl: () => string; apiKey: string; ready: () => boolean; slots?: () => number; parallelChats?: () => number }): AskJson | undefined {
  if (!e.ready()) return undefined;
  return async (system, user, schema, signal) => {
    const res = await fetch(`${e.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.apiKey}` },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0,
        max_tokens: 40,
        ...llamaCppFields("other", e.slots?.() ?? 0, e.parallelChats?.() ?? 1),
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { name: "route", schema } },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`The engine answered ${res.status}`);
    return ((await res.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
  };
}
