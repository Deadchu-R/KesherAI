/**
 * KesherAI's translator (Roee, 2026-11-21: "מחולל תרגום"): one service that turns text into English or Hebrew.
 *
 * Image, video and music models read English only. The chat model is asked to write English prompts, but it forgets
 * (a Hebrew "monkey" came out as an owl), so every media prompt passes through {@link Translator.englishPrompt} first,
 * and the English actually sent is shown under the result. The Translate page uses the same service.
 *
 * Which model translates: the cheapest one already available (RESEARCH_LOG "On-demand engines and the translator"):
 * 1. the local chat model, when it is loaded (no extra memory, no cost);
 * 2. the user's free Gemini connection (provider "gemini"), a flash model;
 * 3. a small local translation model (TranslateGemma 4B) loaded beside the main one on demand; the GPU guard unloads
 *    it again after a few idle minutes (Settings → graphics card → load on demand).
 */
import type { ModelTurn } from "@kesher/agent";

/** The two directions KesherAI translates in. */
export type TranslateTarget = "en" | "he";

/** Which kind of model translated. */
export type TranslatorVia = "chat" | "gemini" | "local";

/** The small local translation model offered for one-click download (llama.cpp, Gemma 3 chat format). */
export const TRANSLATION_MODEL = {
  name: "TranslateGemma 4B",
  repo: "42ailab/TranslateGemma-4B-GGUF",
  pattern: /Q4_K_M\.gguf$/i,
  fallback: /\.gguf$/i,
  sizeGb: 2.5,
} as const;

/** The longest text one call translates (TranslateGemma reads about 2K tokens; longer text is split by paragraphs). */
export const TRANSLATE_CHUNK = 3000;

/** The longest text the service accepts at once. */
export const TRANSLATE_MAX = 20_000;

/**
 * Whether a text is mostly in another alphabet than Latin (Hebrew, Arabic, Cyrillic…), so an English-only model would
 * misread it. Accented Latin letters count as Latin.
 *
 * @param text - The text.
 * @returns True when more than 30% of its letters are not Latin.
 */
export function notEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const foreign = letters.filter((c) => !/[A-Za-zÀ-ɏ]/.test(c)).length;
  return foreign / letters.length > 0.3;
}

/**
 * The language to translate into when the user did not say: Hebrew text goes to English, anything else to Hebrew.
 *
 * @param text - The text.
 */
export function autoTarget(text: string): TranslateTarget {
  return /[֐-׿]/.test(text) && notEnglish(text) ? "en" : "he";
}

/**
 * Picks the translating model: the translation model file the user chose (when it is on the computer), else the
 * loaded local chat model, else any local translation model file (loaded on demand), and only then Gemini's flash model.
 * A model on this computer is used before the cloud one.
 *
 * @param o.localChat - The local chat model's id, when one is loaded now.
 * @param o.gemini - Gemini's flash model id, when a Gemini connection is set up.
 * @param o.translatorFile - A downloaded translation model (GGUF path), if there is one.
 * @param o.chosen - The user chose that file in Settings → model team: it comes before every other translator.
 * @returns The choice, or undefined when nothing can translate.
 */
export function pickTranslator(o: { localChat?: string | undefined; gemini?: string | undefined; translatorFile?: string | undefined; chosen?: boolean | undefined }): { via: TranslatorVia; model: string } | undefined {
  if (o.chosen && o.translatorFile) return { via: "local", model: o.translatorFile };
  if (o.localChat) return { via: "chat", model: o.localChat };
  if (o.translatorFile) return { via: "local", model: o.translatorFile };
  if (o.gemini) return { via: "gemini", model: o.gemini };
  return undefined;
}

/**
 * Gemini's flash chat model out of its model list (the same rule as the task inbox's research route, build-inbox.ts).
 *
 * @param models - The connection's models.
 * @returns Its id, or undefined.
 */
export function pickFlash(models: ReadonlyArray<{ id: string; providerModelId: string; category?: string }>): string | undefined {
  // Google keeps listing retired models (Gemini 2.5 answers 404 since Oct 2026): the "flash-latest" alias first, then
  // the newest numbered Flash.
  const flash = models.filter((m) => (m.category ?? "chat") === "chat" && /flash/i.test(m.providerModelId) && !/lite|image|tts|live|preview|exp|thinking/i.test(m.providerModelId));
  const ver = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return (flash.find((m) => /flash-latest$/i.test(m.providerModelId)) ?? [...flash].sort((x, y) => ver(y.providerModelId) - ver(x.providerModelId))[0])?.id;
}

/**
 * The translator's instructions.
 *
 * @param to - The target language.
 * @param kind - "prompt": a picture/video/music prompt (keep every subject, style and detail; English words for a
 *   generator); "text": any text, as it is.
 */
export function translateSystem(to: TranslateTarget, kind: "text" | "prompt"): string {
  const lang = to === "en" ? "English" : "Hebrew";
  if (kind === "prompt") {
    return `Translate the user's description into ${lang} for an image/video/music generator. Keep every subject, count, color, style, mood and detail; do not add or drop anything. Names of styles and artists stay as they are. Answer with the translated description only: no quotes, no notes.`;
  }
  return `Translate the text the user sends into ${lang}. Keep its meaning, tone, line breaks, Markdown, numbers, names, code and links exactly. Answer with the translation only: no quotes, no notes, no explanations.`;
}

/**
 * Cleans a model's translation: thinking blocks, a "Translation:" label and wrapping quotes are removed.
 *
 * @param out - The model's answer.
 */
export function cleanTranslation(out: string): string {
  let s = out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/^(here is the translation|translation|english|hebrew|תרגום)\s*[:：]\s*/i, "");
  const q = /^(["“”'«])([\s\S]*)(["“”'»])$/.exec(s);
  if (q && !q[2]!.includes(q[1]!)) s = q[2]!;
  return s.trim();
}

/**
 * Splits a long text by paragraphs (then lines, then hard) into pieces of at most `max` characters.
 *
 * @param text - The text.
 * @param max - The longest piece.
 */
export function splitForTranslation(text: string, max = TRANSLATE_CHUNK): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/(\n\s*\n)/)) {
    if ((cur + para).length <= max) {
      cur += para;
      continue;
    }
    if (cur) out.push(cur);
    cur = "";
    if (para.length <= max) {
      cur = para;
      continue;
    }
    for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max));
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** What a translation answers. */
export interface TranslationResult {
  text: string;
  /** Which kind of model translated ("none" when nothing needed translating). */
  via: TranslatorVia | "none";
  /** The model id used. */
  model?: string;
}

/** What the translator needs from the server. */
export interface TranslatorDeps {
  /** The local chat model's id when it is loaded now (KesherAI's engine), else undefined. Never loads a model. */
  localChat(): string | undefined;
  /** Gemini's flash model id when a "gemini" connection is set up (may list its models), else undefined. */
  gemini(signal?: AbortSignal): Promise<string | undefined>;
  /** A downloaded translation model file, if there is one. */
  translatorFile(): string | undefined;
  /** Whether the user chose that file in Settings → model team (then it is used first). */
  translatorChosen?(): boolean;
  /** Loads a translation model file beside the main one and returns its model id. */
  loadFile(path: string): Promise<string>;
  /** A model turn for a model id. */
  turn(modelId: string): ModelTurn;
}

/** The translator. One per server. */
export class Translator {
  /** @param deps - See {@link TranslatorDeps}. */
  constructor(private readonly deps: TranslatorDeps) {}

  /**
   * Which model would translate now (for the Translate page), without loading anything.
   *
   * @param signal - Cancels listing Gemini's models.
   */
  async which(signal?: AbortSignal): Promise<{ via: TranslatorVia; model: string } | undefined> {
    return pickTranslator({ localChat: this.deps.localChat(), gemini: await this.deps.gemini(signal).catch(() => undefined), translatorFile: this.deps.translatorFile(), chosen: this.deps.translatorChosen?.() });
  }

  /**
   * Translates a text.
   *
   * @param text - The text (at most {@link TRANSLATE_MAX} characters).
   * @param to - The target language.
   * @param opts.kind - "prompt" for a generator's prompt, "text" otherwise.
   * @param opts.signal - Cancels it.
   * @returns The translation, and which model made it.
   * @throws When no model can translate, or the model fails.
   */
  async translate(text: string, to: TranslateTarget, opts: { kind?: "text" | "prompt"; signal?: AbortSignal } = {}): Promise<TranslationResult> {
    const src = text.slice(0, TRANSLATE_MAX);
    if (!src.trim()) return { text: "", via: "none" };
    const pick = await this.which(opts.signal);
    if (!pick) throw new Error("No model can translate: load a chat model, connect Gemini (Models → Connections), or download the translation model (Translate page).");
    const modelId = pick.via === "local" ? await this.deps.loadFile(pick.model) : pick.model;
    const turn = this.deps.turn(modelId);
    const system = translateSystem(to, opts.kind ?? "text");
    const signal = opts.signal ?? AbortSignal.timeout(120_000);
    const parts: string[] = [];
    for (const piece of splitForTranslation(src)) {
      if (!piece.trim()) {
        parts.push(piece);
        continue;
      }
      const r = await turn({ messages: [{ role: "system", content: system }, { role: "user", content: piece }], tools: [] }, signal, () => undefined);
      parts.push(cleanTranslation(r.text));
    }
    return { text: parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(), via: pick.via, model: modelId };
  }

  /**
   * The English prompt to send to an image, video or music model: the prompt as it is when it is already English,
   * else its translation.
   *
   * @param prompt - The prompt the chat model (or the user) wrote.
   * @param signal - Cancels it.
   * @returns The English prompt, and whether it was translated.
   */
  async englishPrompt(prompt: string, signal?: AbortSignal): Promise<{ prompt: string; translated: boolean; via?: TranslatorVia }> {
    if (!notEnglish(prompt)) return { prompt, translated: false };
    const r = await this.translate(prompt, "en", { kind: "prompt", ...(signal ? { signal } : {}) });
    // A weak model that answered in the same language again: not usable.
    if (!r.text || notEnglish(r.text)) throw new Error("The translation did not come out in English.");
    return { prompt: r.text, translated: true, ...(r.via !== "none" ? { via: r.via } : {}) };
  }
}
