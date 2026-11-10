import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Personas: saved assistants with their own instructions, and optionally
 * their own model and knowledge base. A chat started with a persona uses
 * them; the persona can be changed in the middle of a chat.
 */

/** A saved persona. */
/** Sampling settings a persona asks of its model. */
export interface PersonaParams {
  /** 0–2: lower is steadier, higher more varied. */
  temperature?: number;
  /** 0–1. */
  topP?: number;
  /** Texts that end the answer. */
  stop?: string[];
}

/**
 * Keeps only valid settings (from a form or an imported file).
 *
 * @param p - Anything.
 * @returns The settings, or undefined when none is valid.
 */
export function cleanParams(p: unknown): PersonaParams | undefined {
  if (!p || typeof p !== "object") return undefined;
  const o = p as Record<string, unknown>;
  const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
  const temperature = num(o.temperature, 2);
  const topP = num(o.topP, 1);
  const stop = Array.isArray(o.stop) ? o.stop.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 40).slice(0, 4) : [];
  const out: PersonaParams = { ...(temperature !== undefined ? { temperature } : {}), ...(topP !== undefined ? { topP } : {}), ...(stop.length ? { stop } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** A saved assistant. */
export interface Persona {
  id: string;
  name: string;
  /** One emoji or character shown next to the name. */
  icon?: string;
  /** How it should behave: its role, tone, rules. */
  instructions: string;
  /** The model it uses when a chat starts with it. */
  modelId?: string;
  /** A knowledge base (its name) to search first. */
  knowledge?: string;
  /** How the model writes for it (imported presets carry these; empty = the model's defaults). */
  params?: PersonaParams;
  /** Opening messages offered when a chat starts with it (Open WebUI's prompt suggestions, Modelfile examples). */
  starters?: string[];
  updatedAt: string;
}

/** Ready-made personas the user can start from (in English; they answer in the user's language). */
export const PERSONA_TEMPLATES: Array<Omit<Persona, "id" | "updatedAt">> = [
  { name: "Unity mentor", icon: "🎮", instructions: "You are a senior Unity developer and patient mentor. Explain with short C# examples that follow Unity conventions (MonoBehaviour lifecycle, SerializeField, no per-frame allocations). Point out performance and architecture pitfalls. Ask for the Unity version and render pipeline when it matters." },
  { name: "Code reviewer", icon: "🔍", instructions: "You review code like a strict but kind senior engineer. List real problems first (bugs, security, race conditions, missing error handling), each with the line and a fix, then smaller style notes. Never invent issues; say when the code is fine." },
  { name: "Translator", icon: "🌐", instructions: "You translate between Hebrew and English (or any language the user names). Keep the meaning, tone and formatting; prefer natural phrasing over word-for-word. Give only the translation unless asked for notes." },
  { name: "Editor", icon: "✍️", instructions: "You are a careful editor. Fix grammar, clarity and flow while keeping the author's voice. Show the improved text, then a few short notes on the main changes." },
  {
    name: "מנתח קשרים אנושיים",
    icon: "🤝",
    instructions:
      "You are the relationship analyst: you read a conversation between people and tell the user, honestly and with a sense of humour, what is really going on in it. Start by asking two things if the user did not say: what kind of chat it is (romantic, a friends group, one friend, family, work or team, or other such as roommates or neighbours) and who the user is in it. Then ask for the chat: an exported chat file (WhatsApp: the chat → ⋮ → More → Export chat → Without media; Telegram: the JSON export), screenshots, or pasted text. With a file or pasted text, ALWAYS run analyze_chat first and build on its numbers; with screenshots, read them carefully. Write the report in this order: 1) The verdict: one or two punchy sentences on the dynamic. 2) The numbers that matter: who writes more, who starts conversations, who answers faster, who asks the questions, late nights, as a short list. 3) Patterns: interest and effort on each side, tone shifts over time, mixed signals, recurring jokes, who carries the conversation, what is avoided. Quote short lines from the chat as evidence. 4) What it probably means, as possibilities with how sure you are, and what you cannot know from the chat alone. 5) What to do next: two or three concrete moves, with an example message the user could send. Keep a light, playful voice and you may tease the user a little, but never cruelly, and drop the jokes when the subject is painful. Offer to dig deeper into any part (a period, one person, a turning point) and do it when asked. Never diagnose anyone, never help to manipulate, track or control another person, and if there are signs of abuse, threats or danger, say so plainly and point to real help. Everything stays on this computer: say so if the user worries about privacy. Reply in the user's language.",
  },
  { name: "Teacher", icon: "🧑‍🏫", instructions: "You teach step by step. Check what the user already knows, explain with simple examples, and end each answer with one short question that checks understanding." },
];

/** Keeps personas in a JSON file. */
export class Personas {
  private list_: Persona[] = [];
  private loaded?: Promise<void>;

  /** @param file - personas.json in KesherAI's data folder. */
  constructor(private readonly file: string) {}

  /** Reads the file (once). */
  load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then(
      (t) => void (this.list_ = (JSON.parse(t) as Persona[]).filter((p) => p && p.id && p.name)),
      () => undefined,
    );
    return this.loaded;
  }

  /** @returns All personas, by name. */
  async list(): Promise<Persona[]> {
    await this.load();
    return [...this.list_].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @returns One persona, from what is loaded now. */
  get(id: string | undefined): Persona | undefined {
    return id ? this.list_.find((p) => p.id === id) : undefined;
  }

  /**
   * Creates or changes a persona.
   *
   * @param input - At least a name and instructions.
   * @returns The saved persona.
   */
  async save(input: Partial<Persona> & { name: string; instructions: string }): Promise<Persona> {
    await this.load();
    const old = input.id ? this.get(input.id) : undefined;
    const p: Persona = {
      id: old?.id ?? randomUUID(),
      name: input.name.trim().slice(0, 60),
      ...(input.icon?.trim() ? { icon: [...input.icon.trim()].slice(0, 2).join("") } : {}),
      instructions: input.instructions.trim().slice(0, 20_000),
      ...(input.modelId?.trim() ? { modelId: input.modelId.trim() } : {}),
      ...(input.knowledge?.trim() ? { knowledge: input.knowledge.trim() } : {}),
      ...((): { params?: PersonaParams } => {
        const params = cleanParams(input.params);
        return params ? { params } : {};
      })(),
      ...((): { starters?: string[] } => {
        const starters = (Array.isArray(input.starters) ? input.starters : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 6);
        return starters.length ? { starters } : {};
      })(),
      updatedAt: new Date().toISOString(),
    };
    if (!p.name || !p.instructions) throw new Error("A persona needs a name and instructions.");
    this.list_ = old ? this.list_.map((x) => (x.id === p.id ? p : x)) : [...this.list_, p];
    await this.persist();
    return p;
  }

  /** Deletes a persona (chats that used it go back to the default). */
  async remove(id: string): Promise<void> {
    await this.load();
    this.list_ = this.list_.filter((p) => p.id !== id);
    await this.persist();
  }

  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.list_, null, 2));
  }
}

/**
 * The system-prompt part for a persona.
 *
 * @param p - The persona.
 * @returns Text for the prompt.
 */
export function personaPrompt(p: Persona): string {
  return [
    `You are "${p.name}", a persona the user set up. Follow these instructions in this chat (they come before your usual style, but never before safety or the user's direct requests):`,
    p.instructions,
    ...(p.knowledge ? [`When a question may be answered by the "${p.knowledge}" knowledge base, call search_knowledge with base "${p.knowledge}" first and cite the sources.`] : []),
  ].join("\n");
}
