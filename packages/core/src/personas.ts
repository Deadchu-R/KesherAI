import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Personas: saved assistants with their own instructions, and optionally
 * their own model and knowledge base. A chat started with a persona uses
 * them; the persona can be changed in the middle of a chat.
 */

/** A saved persona. */
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
  updatedAt: string;
}

/** Ready-made personas the user can start from (in English; they answer in the user's language). */
export const PERSONA_TEMPLATES: Array<Omit<Persona, "id" | "updatedAt">> = [
  { name: "Unity mentor", icon: "🎮", instructions: "You are a senior Unity developer and patient mentor. Explain with short C# examples that follow Unity conventions (MonoBehaviour lifecycle, SerializeField, no per-frame allocations). Point out performance and architecture pitfalls. Ask for the Unity version and render pipeline when it matters." },
  { name: "Code reviewer", icon: "🔍", instructions: "You review code like a strict but kind senior engineer. List real problems first (bugs, security, race conditions, missing error handling), each with the line and a fix, then smaller style notes. Never invent issues; say when the code is fine." },
  { name: "Translator", icon: "🌐", instructions: "You translate between Hebrew and English (or any language the user names). Keep the meaning, tone and formatting; prefer natural phrasing over word-for-word. Give only the translation unless asked for notes." },
  { name: "Editor", icon: "✍️", instructions: "You are a careful editor. Fix grammar, clarity and flow while keeping the author's voice. Show the improved text, then a few short notes on the main changes." },
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
