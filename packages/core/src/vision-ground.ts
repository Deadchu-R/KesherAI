/**
 * Finding a thing on a screenshot with a local vision model (docs/research/browser-computer-control.md, Phase 6):
 * "the blue Save button" + a picture → a point in the picture's pixels and how sure the model was. The main model
 * plans in words; this one only points (the two-model pattern of UI-TARS and OmniParser).
 *
 * Everything here is pure apart from {@link VisionGrounder}, whose model call is passed in (vision-service.ts runs it
 * on its own llama.cpp server; tests pass a fake). Clicking stays with the computer and browser tools, so every click
 * still goes through the safety gate and its approval card.
 */
import type { VisionModel } from "@kesher/shared";

/** A rectangle: x, y, width, height. */
export type Rect = [number, number, number, number];

/** What one grounding call found. Coordinates are in pixels of the picture that was sent. */
export type GroundResult =
  | {
      found: true;
      x: number;
      y: number;
      /** The element's box, when the model gave one. */
      box?: Rect;
      /** 0 to 1, from the probabilities of the numbers the model wrote; undefined when the engine gave none. */
      confidence?: number;
      ms: number;
      model: string;
    }
  | { found: false; why: string; ms: number; model: string };

/** What the model call gets: the prompt and the picture. */
export interface VisionAsk {
  model: VisionModel;
  /** The picture (PNG unless `mime` says otherwise); absent for a question with no picture. */
  png?: Buffer;
  /** The picture's type (default image/png). */
  mime?: string;
  /** The longest answer in tokens (default 96: a point). */
  maxTokens?: number;
  system?: string;
  user: string;
  signal?: AbortSignal;
}

/** What the model answered: its text, and the log-probabilities of its tokens when the engine sends them. */
export interface VisionAnswer {
  text: string;
  tokens?: Array<{ token: string; logprob: number }>;
}

/** Runs one vision request (vision-service.ts: the llama.cpp slot; tests: a fake). */
export type VisionChat = (ask: VisionAsk) => Promise<VisionAnswer>;

/** Below this the tools say the model was unsure and ask for a look at the crop before acting. */
export const UNSURE = 0.5;

/**
 * Qwen2.5-VL's resize (UI-TARS uses it): both sides rounded to multiples of 28, the area kept between the limits.
 * UI-TARS answers in pixels of this resized picture, so its points are scaled back with it.
 *
 * @param width - The picture's width.
 * @param height - Its height.
 * @param minPixels - The smallest area (Qwen's default 56×56).
 * @param maxPixels - The largest area (UI-TARS: 16384×28×28).
 * @returns The resized width and height.
 */
export function smartResize(width: number, height: number, minPixels = 56 * 56, maxPixels = 16384 * 28 * 28): { width: number; height: number } {
  const f = 28;
  let w = Math.max(f, Math.round(width / f) * f);
  let h = Math.max(f, Math.round(height / f) * f);
  if (w * h > maxPixels) {
    const beta = Math.sqrt((width * height) / maxPixels);
    w = Math.max(f, Math.floor(width / beta / f) * f);
    h = Math.max(f, Math.floor(height / beta / f) * f);
  } else if (w * h < minPixels) {
    const beta = Math.sqrt(minPixels / (width * height));
    w = Math.ceil((width * beta) / f) * f;
    h = Math.ceil((height * beta) / f) * f;
  }
  return { width: w, height: h };
}

/**
 * The prompt for one model: Qwen3-VL answers JSON with a point from 0 to 1000; UI-TARS gets its own grounding prompt
 * and answers `(x,y)`. The description is the user's (or the main model's) words, kept short.
 *
 * @param model - The vision model.
 * @param query - What to find, e.g. "the blue Save button".
 * @returns The system and user text.
 */
export function groundPrompt(model: Pick<VisionModel, "coords">, query: string): { system?: string; user: string } {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 300);
  if (model.coords === "abs28") return { user: `Output only the coordinate of one point in your response. What element matches the following task: ${q}` };
  return {
    system: "You locate user-interface elements on screenshots. Answer with JSON only, no other words.",
    user: `Find this on the screenshot: "${q}". Answer {"point_2d": [x, y], "bbox_2d": [x1, y1, x2, y2]} with every number from 0 to 1000 of the picture's width and height, or {"none": true} when it is not on the screenshot.`,
  };
}

/**
 * Reads the point out of a model's answer and maps it to the sent picture's pixels.
 *
 * Accepts `{"point_2d": [x, y]}`, `{"bbox_2d": [...]}` (its centre), a list of such objects (the first), UI-TARS'
 * `(x,y)`, `start_box='(x,y)'` and `<|box_start|>(x,y)<|box_end|>`, and `{"none": true}` / "not found".
 *
 * @param text - The model's answer.
 * @param model - Which coordinates it writes.
 * @param width - The sent picture's width.
 * @param height - Its height.
 * @returns The point (and box) in picture pixels, or why there is none.
 */
export function parseGround(text: string, model: Pick<VisionModel, "coords">, width: number, height: number): { x: number; y: number; box?: Rect } | { none: string } {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  if (/"none"\s*:\s*true|\bnot (?:found|visible|on the screen(?:shot)?)\b/i.test(t)) return { none: "The model says it is not on the screen." };
  const map = (x: number, y: number): [number, number] => {
    if (model.coords === "rel1000") return [(x / 1000) * width, (y / 1000) * height];
    const r = smartResize(width, height);
    return [(x * width) / r.width, (y * height) / r.height];
  };
  const nums = (s: string | undefined) => (s ?? "").split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  let point: number[] = nums(/"point_2d"\s*:\s*\[([^\]]*)\]/i.exec(t)?.[1]);
  let bbox: number[] = nums(/"bbox_2d"\s*:\s*\[([^\]]*)\]/i.exec(t)?.[1]);
  if (point.length < 2 && bbox.length < 4) {
    const pair = /\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*)?\)/.exec(t) ?? /\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*)?\]/.exec(t);
    if (pair) {
      const v = pair.slice(1).filter((s) => s !== undefined).map(Number);
      if (v.length === 4) bbox = v;
      else point = v;
    }
  }
  let box: Rect | undefined;
  if (bbox.length >= 4) {
    const [a, b] = map(bbox[0]!, bbox[1]!);
    const [c, d] = map(bbox[2]!, bbox[3]!);
    box = [Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b)];
  }
  let x: number, y: number;
  if (point.length >= 2) [x, y] = map(point[0]!, point[1]!);
  else if (box) [x, y] = [box[0] + box[2] / 2, box[1] + box[3] / 2];
  else return { none: "The model's answer had no point." };
  if (x < 0 || y < 0 || x > width || y > height) return { none: `The model pointed outside the picture (${Math.round(x)},${Math.round(y)}).` };
  return { x: Math.round(x), y: Math.round(y), ...(box ? { box: box.map(Math.round) as Rect } : {}) };
}

/**
 * How sure the model was: the geometric mean of the probabilities of the tokens that carry the numbers.
 *
 * @param tokens - The answer's tokens with their log-probabilities.
 * @returns 0 to 1, or undefined without tokens.
 */
export function confidenceOf(tokens: VisionAnswer["tokens"]): number | undefined {
  const digits = (tokens ?? []).filter((t) => /\d/.test(t.token) && Number.isFinite(t.logprob));
  if (!digits.length) return undefined;
  const mean = digits.reduce((n, t) => n + t.logprob, 0) / digits.length;
  return Math.round(Math.min(1, Math.max(0, Math.exp(mean))) * 100) / 100;
}

/** Words of a description that say how a thing looks, not what it is called ("the blue Save button"). */
const LOOK_WORDS = new Set([
  "the", "a", "an", "button", "icon", "link", "field", "box", "menu", "item", "tab", "on", "at", "in", "of", "top", "bottom",
  "left", "right", "blue", "red", "green", "grey", "gray", "white", "black", "big", "small", "little",
  "את", "של", "כפתור", "הכפתור", "אייקון", "האייקון", "קישור", "שדה", "תפריט", "לשונית", "כחול", "הכחול", "אדום", "ירוק", "אפור", "למעלה", "למטה", "בצד",
]);

/** The words that name a thing: lower case, without look words. */
function nameWords(s: string): string[] {
  return s.toLowerCase().replace(/["'“”‘’()[\]{}.,:;!?]/g, " ").split(/\s+/).filter((w) => w && !LOOK_WORDS.has(w));
}

/**
 * The control whose name matches a description best, for the accessibility-tree path before any vision: every
 * naming word of the description must be in the control's name, and an exact name wins.
 *
 * @param query - The description, e.g. "the blue Save button".
 * @param items - Controls with a name (and a box).
 * @returns The best item, or undefined when none names all the words.
 */
export function bestNameMatch<T extends { name: string }>(query: string, items: readonly T[]): T | undefined {
  const want = nameWords(query);
  if (!want.length) return undefined;
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const have = nameWords(item.name);
    if (!have.length || !want.every((w) => have.some((h) => h === w || (w.length > 2 && h.startsWith(w))))) continue;
    // Fewer extra words is closer ("Save" beats "Save as…" for "Save").
    const score = 10 - Math.min(9, have.length - want.length) + (have.join(" ") === want.join(" ") ? 5 : 0);
    if (!best || score > best.score) best = { item, score };
  }
  return best?.item;
}

/**
 * Asks a vision model where a thing is on a picture. One call at a time (the model has one slot), so parallel
 * helpers wait in line instead of fighting over the graphics card.
 */
export class VisionGrounder {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param chat - Runs the model.
   * @param now - The clock (tests).
   */
  constructor(private readonly chat: VisionChat, private readonly now: () => number = Date.now) {}

  /**
   * Finds one thing on a picture.
   *
   * @param model - The vision model to ask.
   * @param req.png - The picture (PNG) and its size in pixels.
   * @param req.query - What to find.
   * @returns The point in the picture's pixels, or why it was not found.
   */
  ground(model: VisionModel, req: { png: Buffer; width: number; height: number; query: string; signal?: AbortSignal }): Promise<GroundResult> {
    const run = async (): Promise<GroundResult> => {
      const started = this.now();
      const prompt = groundPrompt(model, req.query);
      const answer = await this.chat({ model, png: req.png, user: prompt.user, ...(prompt.system ? { system: prompt.system } : {}), ...(req.signal ? { signal: req.signal } : {}) });
      const ms = this.now() - started;
      const p = parseGround(answer.text, model, req.width, req.height);
      if ("none" in p) return { found: false, why: p.none, ms, model: model.id };
      const confidence = confidenceOf(answer.tokens);
      return { found: true, x: p.x, y: p.y, ...(p.box ? { box: p.box } : {}), ...(confidence !== undefined ? { confidence } : {}), ms, model: model.id };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * The tools' words for a result: where, how sure, and what to do next.
 *
 * @param r - A found result.
 * @param clickTool - The tool that clicks a point (`computer_click` or `browser_click_at`).
 * @returns One or two sentences for the model.
 */
export function foundText(r: Extract<GroundResult, { found: true }>, clickTool: string): string {
  const sure = r.confidence === undefined ? "confidence unknown" : `confidence ${Math.round(r.confidence * 100)}%`;
  const unsure = r.confidence !== undefined && r.confidence < UNSURE ? " The model was unsure: look at the attached crop before clicking, or describe it differently." : "";
  return `Found at x=${r.x}, y=${r.y} in the screenshot's pixels (${sure}, ${r.model}, ${(r.ms / 1000).toFixed(1)} s). To click it: ${clickTool} with x=${r.x}, y=${r.y}.${unsure}`;
}
