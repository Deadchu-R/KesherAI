/**
 * "Auto" as a chat model (docs/RESEARCH_LOG.md, "'Auto' model per message"): per message, a router picks which of the
 * user's models answers, and the reply shows it with a one-line reason ("Qwen3.6 27B — כלים").
 *
 * 1. What the message needs, by words and the tool groups the tool router already found (free): an image → vision,
 *    two or more tool groups → tools, a long Hebrew text or a song's lyrics → Hebrew writing, research words → research,
 *    code → code, a short simple turn → fast.
 * 2. When the words find nothing clear, a tiny JSON call (an enum held by a schema) to the small model loaded beside
 *    the main one, else to the loaded main model (never a swap just to route).
 * 3. A policy over the user's models and their strengths ({@link decideModel}): privacy (incognito → never the cloud),
 *    the cloud only for the kinds the user allows, a swap of the big local model only when the other one is clearly
 *    better for this message, and the choice kept for the next few turns of the same task ({@link nextSticky}).
 *
 * Only one big model fits on the card at a time and a swap costs ~16 s plus a cold prompt cache, which is why the
 * policy leans so hard toward the loaded model; cloud routers (OpenRouter Auto, NotDiamond) have no such cost.
 */
import type { AskJson } from "./tool-router.js";

/** What a model is good at (Settings › Models › Auto). */
export const STRENGTHS = ["tools", "hebrew", "code", "research", "vision", "fast"] as const;
/** One strength; see {@link STRENGTHS}. */
export type Strength = (typeof STRENGTHS)[number];

/** Each strength's name on screen and on the reply's reason line. */
export const STRENGTH_LABELS: Record<Strength, { he: string; en: string }> = {
  tools: { he: "כלים", en: "tools" },
  hebrew: { he: "כתיבה בעברית", en: "Hebrew writing" },
  code: { he: "קוד", en: "code" },
  research: { he: "מחקר ברשת", en: "web research" },
  vision: { he: "תמונה", en: "a picture" },
  fast: { he: "תשובה קצרה", en: "a short answer" },
};

/** How many turns a choice is kept for the same task (no swap back and forth inside one task). */
export const STICKY_TURNS = 3;

/** Where a model runs: on this computer, on a server of the user's, or in the cloud. */
export type Where = "local" | "server" | "cloud";

/**
 * The strengths a model has by its family, before the user changes them: Qwen3.x = tools + code, DictaLM = Hebrew
 * writing, Gemini = research (+ vision, Flash = fast), Claude and GPT = tools + code + vision, small files = fast.
 *
 * @param id - The model id (`llamacpp/Qwen3.6-27B-Q4_K_M`, `google/gemini-flash-latest`).
 * @param name - Its name on screen, when it says more than the id.
 * @returns Its strengths (may be empty: such a model is only picked when nothing else fits).
 */
export function defaultStrengths(id: string, name = ""): Strength[] {
  const s = `${id} ${name}`.toLowerCase();
  const out = new Set<Strength>();
  if (/dicta/.test(s)) out.add("hebrew");
  const toolsAndCode = () => {
    out.add("tools");
    out.add("code");
  };
  if (/qwen-?\d/.test(s) && !/dicta/.test(s)) toolsAndCode();
  if (/coder|codestral|devstral|deepseek-coder/.test(s)) out.add("code");
  if (/gpt-oss|gpt-?[45]|\bo[134]\b|claude|mistral-(large|medium)|glm-4\.[5-9]|kimi/.test(s)) toolsAndCode();
  if (/gemini/.test(s)) {
    out.add("research");
    out.add("vision");
    if (/flash/.test(s)) out.add("fast");
    if (/pro/.test(s)) out.add("code");
  }
  if (/claude|gpt-4o|gpt-[45]\.|[-_ ]vl\b|-vl-|vision|llava|pixtral|minicpm-v/.test(s)) out.add("vision");
  // A small file answers short turns fast ("Qwen3-4B", "gemma-3-1b"); the size comes from the name.
  const b = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s?b\b/.exec(s.replace(/-a\d+(\.\d+)?b/g, ""));
  if (b && Number(b[1]) <= 4) out.add("fast");
  return STRENGTHS.filter((x) => out.has(x));
}

/** A model Auto may pick. */
export interface RouteCandidate {
  /** Its model id. */
  id: string;
  /** A short name for the reason line. */
  name: string;
  where: Where;
  strengths: readonly Strength[];
  /** It answers now without a load (the loaded local model, a server's or a cloud model). */
  ready: boolean;
  /** For a local model that is not loaded: about how long its load takes (seconds). */
  loadSec?: number;
}

/** What one message needs. */
export interface RouteNeed {
  /** The one thing that matters most; undefined = a general message. */
  need?: Strength;
  /** The other model is clearly better for it (worth a swap of the big local model). */
  strong: boolean;
}

/** A choice kept for the next turns of the same task. */
export interface StickyChoice {
  modelId: string;
  need?: Strength;
  /** Turns left. */
  left: number;
}

/** Auto's pick for one message. */
export interface ModelPick {
  modelId: string;
  /** The reason on the reply: what the message needed, or `general` (the chat's usual model). */
  why: Strength | "general";
  /** The big local model is swapped for this one (a load first). */
  swap: boolean;
  /** About how long the load takes (seconds), with `swap`. */
  loadSec?: number;
}

/** What {@link decideModel} weighs. */
export interface DecideInput extends RouteNeed {
  candidates: readonly RouteCandidate[];
  /** The model the chat used last. */
  current: string;
  sticky?: StickyChoice;
  /** Privacy (an incognito chat): never a cloud model. */
  noCloud: boolean;
  /** The kinds of message the user lets go to a cloud model (Settings › Models › Auto). */
  cloudKinds: readonly Strength[];
}

/**
 * Picks the model for one message (see the top of this file).
 *
 * @param d - The need, the user's models, the chat's model now, the kept choice and the privacy rules.
 * @returns The pick; the current model when nothing is clearly better.
 */
export function decideModel(d: DecideInput): ModelPick {
  const hasLocal = d.candidates.some((c) => c.where !== "cloud");
  // The cloud: never in privacy; else for the kinds the user allows, or for everything when there is no local model.
  const allowed = (c: RouteCandidate) => c.where !== "cloud" || (!d.noCloud && (!hasLocal || (!!d.need && d.cloudKinds.includes(d.need))));
  const pool = d.candidates.filter(allowed);
  const cur = pool.find((c) => c.id === d.current);
  const pick = (c: RouteCandidate, why: ModelPick["why"]): ModelPick => ({ modelId: c.id, why, swap: !c.ready, ...(!c.ready && c.loadSec ? { loadSec: c.loadSec } : {}) });
  const stay = (): ModelPick => ({ modelId: d.current, why: d.need && cur?.strengths.includes(d.need) ? d.need : "general", swap: false });
  // The chat's model is not allowed now (a cloud model in privacy, or a kind the cloud may not have): the loaded local
  // model first, then any other.
  const fallback = (): ModelPick => {
    const c = pool.find((x) => x.ready && x.where !== "cloud") ?? pool.find((x) => x.ready) ?? pool[0];
    return c ? pick(c, d.need && c.strengths.includes(d.need) ? d.need : "general") : { modelId: d.current, why: "general", swap: false };
  };
  if (!pool.length) return { modelId: d.current, why: "general", swap: false };
  // Ranked for a need: no load first, a local model before the cloud, then a load (a swap).
  const rank = (c: RouteCandidate) => (c.ready ? (c.where === "cloud" ? 1 : 0) : 2);
  const best = d.need ? pool.filter((c) => c.strengths.includes(d.need!)).sort((a, b) => rank(a) - rank(b))[0] : undefined;

  // A picture needs a model that sees: worth a load even without "strong".
  if (d.need === "vision") {
    if (cur?.strengths.includes("vision")) return stay();
    return best ? pick(best, "vision") : cur ? stay() : fallback();
  }
  // The same task: the kept choice stays unless this message clearly needs another model.
  const kept = d.sticky && d.sticky.left > 0 ? pool.find((c) => c.id === d.sticky!.modelId) : undefined;
  if (kept && (!d.need || !d.strong || kept.strengths.includes(d.need))) {
    const why = d.need && kept.strengths.includes(d.need) ? d.need : d.sticky!.need ?? "general";
    return { ...pick(kept, why), swap: !kept.ready };
  }
  if (!cur) return best && (best.ready || d.strong) ? pick(best, d.need!) : fallback();
  if (!d.need || cur.strengths.includes(d.need) || !best) return stay();
  // Another model has the strength: free to move when it needs no load; a swap only when it is clearly better.
  if (best.ready || d.strong) return pick(best, d.need);
  return stay();
}

/**
 * The kept choice after a pick: a pick for a strong need (or a swap) is kept for {@link STICKY_TURNS} turns, a pick of
 * the same model uses up one turn, and another model ends it.
 *
 * @param prev - The kept choice before this message.
 * @param p - This message's pick.
 * @param strong - Whether this message's need was strong.
 * @returns The kept choice for the next message, or undefined.
 */
export function nextSticky(prev: StickyChoice | undefined, p: ModelPick, strong: boolean): StickyChoice | undefined {
  if (p.swap || (strong && p.why !== "general")) return { modelId: p.modelId, ...(p.why !== "general" ? { need: p.why } : {}), left: STICKY_TURNS };
  if (prev && prev.modelId === p.modelId && prev.left > 1) return { ...prev, left: prev.left - 1 };
  return undefined;
}

const HEBREW = /[֐-׿]/;
/** Asking to write (Hebrew verbs, any form). */
const WRITE_HE = /(?:^|\s)(?:ת?כתו?ב|תכתבי|כתבי|ת?חבר|תחברי|ת?נסח|תנסחי|ערוך|תערוך|שכתב|תשכתב|תרגם לעברית)/;
/** Kinds of text worth Dicta's Hebrew: long or careful writing. */
const LONG_TEXT_HE = /שיר|מילים ל|פזמון|בית ופזמון|מכתב|סיפור|מאמר|חיבור|נאום|פוסט|ברכה|הספד|דרשה|שירה|פרק|עמוד|ארוך|מפורט|תסריט|מונולוג/;
const RESEARCH = /\b(research|deep research|look into|find sources|compare (?:the )?(?:latest|prices|reviews))\b|מחקר|תחקור|תחקר|חקור|מקורות|השווה מחירים|חפש ברשת|חפש באינטרנט/i;
const CODE = /```|\b(code|function|class|bug|stack trace|typescript|python|c\+\+|c#|javascript|regex|sql|compile|refactor)\b|קוד|באג|פונקצי|מחלקה|קומפייל|ריפקטור/i;
/** Tool groups that do work (not just remembering or a timer). */
const LIGHT_GROUPS = new Set(["memory", "timers", "web"]);

/** What {@link needByWords} reads besides the text. */
export interface NeedContext {
  /** The tool groups the tool router found for the message. */
  groups: readonly string[];
  /** The message has a picture. */
  image?: boolean;
  /** A song or music request (the tool router's `music`). */
  music?: boolean;
  /** A short simple turn (tool-router's isSimpleTurn). */
  simple?: boolean;
}

/**
 * What a message needs, by its words and the tool groups (free; no model).
 *
 * @param text - The user's message.
 * @param c - Its tool groups, picture, music flag and whether it is a simple turn.
 * @returns The need and whether it is strong; `need` undefined when the words find nothing clear.
 */
export function needByWords(text: string, c: NeedContext): RouteNeed {
  const t = text.trim();
  if (c.image) return { need: "vision", strong: true };
  const work = c.groups.filter((g) => !LIGHT_GROUPS.has(g));
  const hebrewText = HEBREW.test(t) && !CODE.test(t);
  const writes = hebrewText && (WRITE_HE.test(t) || (c.music ?? false));
  const longHebrew = writes && (LONG_TEXT_HE.test(t) || (c.music ?? false) || t.length > 400);
  // A song's lyrics or a long Hebrew text wins even with a tool (make_music, a document): the words are the work.
  if (longHebrew) return { need: "hebrew", strong: true };
  if (work.length >= 2 || c.groups.includes("helpers")) return { need: "tools", strong: true };
  if (RESEARCH.test(t)) return { need: "research", strong: true };
  if (CODE.test(t) && (t.includes("```") || c.groups.includes("files"))) return { need: "code", strong: true };
  if (work.length === 1) return { need: "tools", strong: false };
  if (writes) return { need: "hebrew", strong: false };
  if (c.groups.includes("web")) return { need: "research", strong: false };
  if (CODE.test(t)) return { need: "code", strong: false };
  if (c.simple) return { need: "fast", strong: false };
  return { strong: false };
}

/** The tiny call's instructions (the same every time, so the engine keeps them cached). */
const SYSTEM = `You route a chat message to the kind of model that should answer it. Answer only JSON.
need: "tools" (needs actions or several tools), "hebrew" (writing a text in Hebrew: a letter, story, song lyrics, an article), "code" (programming), "research" (looking things up on the web), "fast" (a greeting, thanks, a short fact), or "general".
long: true when the answer is a long or careful text.`;

const SCHEMA = {
  type: "object",
  properties: { need: { type: "string", enum: ["tools", "hebrew", "code", "research", "fast", "general"] }, long: { type: "boolean" } },
  required: ["need", "long"],
};

/**
 * Reads the tiny call's answer.
 *
 * @param raw - The model's JSON.
 * @returns The need (strong when the answer is long and the need is writing or code), or undefined when unreadable.
 */
export function parseNeed(raw: string): RouteNeed | undefined {
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { need?: unknown; long?: unknown };
    if (typeof j.need !== "string") return undefined;
    if (j.need === "general") return { strong: false };
    if (!(STRENGTHS as readonly string[]).includes(j.need) || j.need === "vision") return undefined;
    const need = j.need as Strength;
    return { need, strong: j.long === true && (need === "hebrew" || need === "code") };
  } catch {
    return undefined;
  }
}

/**
 * What a message needs: the words first; when they find nothing clear (no need, or a weak one), a tiny JSON call to a
 * loaded model with the chat's recent topic, held to a short timeout and cached per message.
 */
export class NeedClassifier {
  private readonly cache = new Map<string, RouteNeed>();

  /**
   * @param opts.timeoutMs - How long the model may take (default 2 s: it runs before every answer in Auto).
   * @param opts.cacheSize - Messages remembered (default 200).
   */
  constructor(private readonly opts: { timeoutMs?: number; cacheSize?: number } = {}) {}

  /**
   * @param text - The user's message.
   * @param c - See {@link needByWords}.
   * @param ask - The small model beside the main one, else the loaded main model; undefined = words only.
   * @param recent - The chat's previous user message (its topic), when there is one.
   * @param signal - The user's Stop.
   * @returns The need.
   */
  async classify(text: string, c: NeedContext, ask: AskJson | undefined, recent?: string, signal?: AbortSignal): Promise<RouteNeed> {
    const byWords = needByWords(text, c);
    if (byWords.strong || !ask || text.trim().length < 3) return byWords;
    const key = `${recent?.slice(0, 300) ?? ""}\n${text.trim().slice(0, 1500)}`;
    let byModel = this.cache.get(key);
    if (!byModel) {
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), this.opts.timeoutMs ?? 2000);
      const stop = AbortSignal.any([timer.signal, ...(signal ? [signal] : [])]);
      const user = recent ? `Earlier message: ${recent.slice(0, 300)}\nMessage: ${text.trim().slice(0, 1500)}` : text.trim().slice(0, 1500);
      byModel = await ask(SYSTEM, user, SCHEMA, stop).then(parseNeed, () => undefined).finally(() => clearTimeout(t));
      if (byModel) {
        this.cache.set(key, byModel);
        if (this.cache.size > (this.opts.cacheSize ?? 200)) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    // The model fills in what the words left open; a weak need by words stays when the model says "general".
    return byModel?.need ? byModel : byWords;
  }
}

/** Cloud model ids that are not for chat (pictures, speech, embeddings): never an Auto pick. */
export const NOT_CHAT = /image|imagen|veo|tts|embed|audio|live|whisper|dall-?e|moderation|transcri|realtime/i;
