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
import { asksForMusic, asksToBrowse, asksToCreate, CHAT_TOOL_GROUPS, groupOfTool, groupsByWords } from "./chat-tool-groups.js";

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
  /** A ready flow the message asks for by itself (a tileable PBR texture, a UI sprite), see {@link flowIntent}. */
  intent?: FlowIntent;
  /** The message asks for a song or music (see {@link asksForMusic}). */
  music?: boolean;
  /** The message only asks to make something (see {@link asksToCreate}): web_search is held back for it. */
  noSearch?: boolean;
}

/** The tools held back from a model for a pure create request: it needs no search, and a weak model would use it. */
export const SEARCH_TOOLS = ["web_search", "deep_research"] as const;

/** A request that one of KesherAI's one-request flows answers. */
export type FlowIntent = "pbr" | "sprite";

const SPRITE_WORDS = /\b(sprites?|ui icons?|game icons?|app icons?|hud icons?|button art|inventory icons?|icon for (?:my|the|a) (?:game|ui|app|button))\b|ספרייט|אייקון|סמל(?:ים)? למשחק|כפתור(?:ים)? למשחק/i;
const PBR_WORDS = /\b(pbr|tileable|tiling|seamless|textures?|albedo|normal map)\b|טקסטור|חומר\s*pbr|בלי תפר/i;
/** Words that point at the object selected in a game engine (the Unity tools come along). */
const SELECTED_WORDS = /\b(selected|selection|unity)\b|נבחר|מסומן|שבחרתי|יוניטי/i;

/**
 * Which one-request flow a message asks for, by its words, Hebrew and English: "make a tileable wall texture" and
 * "תעשה לי טקסטורת קיר שחוזרת" are a PBR texture; "a sprite / UI icon for my game" is a sprite (a sprite wins when
 * both match: "a sprite with a stone texture").
 *
 * @param text - The user's message.
 * @returns The flow, or undefined.
 */
export function flowIntent(text: string): FlowIntent | undefined {
  if (SPRITE_WORDS.test(text)) return "sprite";
  if (PBR_WORDS.test(text)) return "pbr";
  return undefined;
}

/**
 * The line the model reads when the message asks for a one-request flow whose tool the chat has, so it picks that
 * tool by itself instead of generate_image.
 *
 * @param intent - From {@link flowIntent}.
 * @param tools - The tools routed for this message.
 * @returns The line, or undefined.
 */
export function intentNote(intent: FlowIntent | undefined, tools: readonly string[]): string | undefined {
  if (intent === "pbr" && tools.includes("make_pbr_texture")) {
    const unity = tools.includes("unity_create_pbr_material") ? " If they want it on the object selected in Unity, then call unity_create_pbr_material with its albedo, normal, roughness and ao ids and apply_to [\"selection\"]." : "";
    return `[KesherAI] This asks for a texture or material: call make_pbr_texture (a seamless albedo with normal, roughness, AO and height maps), not generate_image.${unity}`;
  }
  if (intent === "sprite" && tools.includes("make_ui_sprite")) {
    const unity = tools.includes("unity_import_sprite") ? " If they want it in Unity, then call unity_import_sprite with its picture id." : "";
    return `[KesherAI] This asks for a 2D game or UI sprite: call make_ui_sprite (the picture with its background removed), not generate_image.${unity}`;
  }
  return undefined;
}

/**
 * The line the model reads when the message asks for a song or music: make_music, not a search and not a picture; or,
 * when the chat has no make_music (ComfyUI is not set up), to say so and offer the install, not to draw.
 *
 * @param music - From {@link asksForMusic}.
 * @param tools - The tools routed for this message.
 * @returns The line, or undefined.
 */
export function musicNote(music: boolean | undefined, tools: readonly string[]): string | undefined {
  if (!music) return undefined;
  if (tools.includes("make_music")) return "[KesherAI] This asks for a song or music: write the lyrics (in the language the user wants) and call make_music. Do not search the web for the song, and do not call generate_image (a cover picture is made by make_music itself).";
  return "[KesherAI] This asks for a song or music, but make_music is not available in this chat (ComfyUI is not installed or the Nodes part is off). Say so in one short sentence and call offer_install with \"comfyui\"; do not draw pictures instead and do not search the web for it.";
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
    const intent = flowIntent(text);
    // A flow request routes to its tools by itself (the Unity tools too when it names the selection or Unity).
    const music = asksForMusic(text);
    // A song, a picture, a document or code to make, with no lookup asked for: no web search (even in the groups by words).
    const browse = asksToBrowse(text);
    const noSearch = music || asksToCreate(text) || browse;
    const wanted = [...(intent ? ["images", ...(SELECTED_WORDS.test(text) ? ["unity"] : [])] : []), ...(music ? ["audio"] : []), ...(browse ? ["browser"] : [])];
    // A song is not a web search or a picture: the groups a weak model would grab instead stay out (a local model
    // searched for the song's name and drew covers; make_music was never called).
    const picked = (await this.groups(text, useModel, signal)).filter((g) => !music || (g !== "images" && g !== "web")).filter((g) => !noSearch || g !== "web");
    const groups = [...new Set([...picked, ...wanted])].filter((g) => !off.includes(g));
    const tools = available.filter((n) => { const g = groupOfTool(n); return !!g && groups.includes(g); }).sort();
    const missing = groups.flatMap((id) => {
      const g = CHAT_TOOL_GROUPS.find((x) => x.id === id);
      return g?.needs && !available.some((n) => g.tools.test(n)) ? [{ group: id, needs: g.needs }] : [];
    });
    // Music comes from ComfyUI (ACE-Step): without make_music the install is offered, even when speech tools exist.
    const noMusic = music && groups.includes("audio") && !available.includes("make_music");
    if (noMusic) missing.push({ group: "audio", needs: "comfyui" });
    return { groups, tools, missing, ...(intent ? { intent } : {}), ...(music ? { music } : {}), ...(noSearch ? { noSearch } : {}) };
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
