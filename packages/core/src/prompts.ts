import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The prompt library: saved prompts the user runs by typing `/name` in any
 * message box. `{{input}}` in a prompt is replaced by what follows the
 * command ("/translate good morning").
 */

/** A saved prompt. */
export interface SavedPrompt {
  id: string;
  /** The command, without the slash: lower case letters, digits, - and _ (Hebrew too). */
  command: string;
  title: string;
  text: string;
  updatedAt: string;
}

/** Prompts the user can add with one click. */
export const PROMPT_TEMPLATES: Array<Pick<SavedPrompt, "command" | "title" | "text">> = [
  { command: "summarize", title: "Summarize", text: "Summarize this in 5 short bullet points, then one sentence with the main takeaway:\n\n{{input}}" },
  { command: "translate", title: "Translate (Hebrew ⇄ English)", text: "Translate this to English if it is in Hebrew, or to Hebrew otherwise. Keep the tone and formatting. Only the translation:\n\n{{input}}" },
  { command: "fix", title: "Fix the bug", text: "Find the cause of this bug, explain it in two sentences, then fix it with the smallest change:\n\n{{input}}" },
  { command: "explain", title: "Explain simply", text: "Explain this simply, as to a smart beginner, with one concrete example:\n\n{{input}}" },
  { command: "email", title: "Write an email", text: "Write a short, clear and polite email about the following. Give a subject line first:\n\n{{input}}" },
  { command: "review", title: "Review code", text: "Review this code: real bugs and risks first (with the fix), then smaller improvements. Say clearly if it is fine:\n\n{{input}}" },
];

/**
 * Makes a command name from what the user typed.
 *
 * @param s - Any text.
 * @returns A command like `fix-bug`.
 */
export function commandName(s: string): string {
  return s.trim().toLowerCase().replace(/^\/+/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * Fills a prompt with what the user wrote after the command.
 *
 * @param text - The prompt.
 * @param input - What follows the command.
 * @returns The message to send.
 */
export function fillPrompt(text: string, input: string): string {
  const rest = input.trim();
  if (text.includes("{{input}}")) return text.replaceAll("{{input}}", rest).trim();
  return rest ? `${text.trim()}\n\n${rest}` : text.trim();
}

/** Keeps saved prompts in a JSON file. */
export class Prompts {
  private items: SavedPrompt[] = [];
  private loaded?: Promise<void>;

  /** @param file - prompts.json in KesherAI's data folder. */
  constructor(private readonly file: string) {}

  /** Reads the file (once). */
  load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then(
      (t) => void (this.items = (JSON.parse(t) as SavedPrompt[]).filter((p) => p && p.id && p.command)),
      () => undefined,
    );
    return this.loaded;
  }

  /** @returns All prompts, by command. */
  async list(): Promise<SavedPrompt[]> {
    await this.load();
    return [...this.items].sort((a, b) => a.command.localeCompare(b.command));
  }

  /**
   * Creates or changes a prompt.
   *
   * @param input - Command, title and text.
   * @returns The saved prompt.
   * @throws Error when the command is empty or taken by another prompt.
   */
  async save(input: Partial<SavedPrompt> & { command: string; text: string }): Promise<SavedPrompt> {
    await this.load();
    const command = commandName(input.command);
    if (!command) throw new Error("Give the prompt a command name, like summarize.");
    if (!input.text.trim()) throw new Error("The prompt is empty.");
    if (this.items.some((p) => p.command === command && p.id !== input.id)) throw new Error(`/${command} already exists.`);
    const old = input.id ? this.items.find((p) => p.id === input.id) : undefined;
    const p: SavedPrompt = { id: old?.id ?? randomUUID(), command, title: input.title?.trim().slice(0, 80) || command, text: input.text.trim().slice(0, 20_000), updatedAt: new Date().toISOString() };
    this.items = old ? this.items.map((x) => (x.id === p.id ? p : x)) : [...this.items, p];
    await this.persist();
    return p;
  }

  /** Deletes a prompt. */
  async remove(id: string): Promise<void> {
    await this.load();
    this.items = this.items.filter((p) => p.id !== id);
    await this.persist();
  }

  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2));
  }
}
