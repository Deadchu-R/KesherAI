import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Pages: documents written together with the agent (LobeHub's Pages). Each
 * is Markdown in its own file under `<data>/pages`, so it is easy to find,
 * copy and back up.
 */
export interface Page {
  id: string;
  title: string;
  /** Markdown. */
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Stores pages. */
export class Pages {
  /** @param dir - The pages folder. */
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Bad page id");
    return join(this.dir, `${id}.json`);
  }

  /** @returns Every page without its content, newest first. */
  async list(): Promise<Array<Omit<Page, "content"> & { words: number }>> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const pages = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.get(n.slice(0, -5)).catch(() => undefined)));
    return pages
      .filter((p): p is Page => !!p)
      .map(({ content, ...rest }) => ({ ...rest, words: content.split(/\s+/).filter(Boolean).length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** @returns The page, or undefined. */
  async get(id: string): Promise<Page | undefined> {
    const raw = await readFile(this.file(id), "utf8").catch(() => undefined);
    return raw ? (JSON.parse(raw) as Page) : undefined;
  }

  /**
   * Saves a page (new when it has no id).
   *
   * @param p - Title and content, and the id of an existing page.
   * @returns The saved page.
   */
  async save(p: { id?: string; title?: string; content?: string }): Promise<Page> {
    await mkdir(this.dir, { recursive: true });
    const old = p.id ? await this.get(p.id) : undefined;
    const now = new Date().toISOString();
    const page: Page = {
      id: old?.id ?? p.id ?? randomUUID(),
      title: (p.title ?? old?.title ?? "Untitled").slice(0, 200),
      content: p.content ?? old?.content ?? "",
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    await writeFile(this.file(page.id), JSON.stringify(page));
    return page;
  }

  /** Deletes a page. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}

/** What the writing buttons ask the model for. */
export const PAGE_ACTIONS: Record<string, string> = {
  rewrite: "Rewrite the selected text so it reads better. Keep its meaning, its language and its Markdown.",
  shorter: "Make the selected text shorter (about half), keeping every important point, its language and its Markdown.",
  longer: "Expand the selected text with more detail and examples that fit the page. Keep its language and its Markdown.",
  fix: "Fix spelling, grammar and punctuation in the selected text. Change nothing else.",
  formal: "Rewrite the selected text in a more formal, professional tone. Keep its language and its Markdown.",
  simple: "Rewrite the selected text in simpler words that anyone can follow. Keep its language and its Markdown.",
  translate: "Translate the selected text: Hebrew to English, anything else to Hebrew. Keep its Markdown.",
};

/**
 * The messages for one writing request.
 *
 * @param page - The page (its title and the whole text, for context).
 * @param o - `action` (a key of PAGE_ACTIONS) or `instruction` (the user's words); `selection` (the part to change, if any).
 * @returns The messages; the answer replaces the selection (or is inserted at the cursor when there is none).
 */
export function pagePrompt(page: Pick<Page, "title" | "content">, o: { action?: string; instruction?: string; selection?: string }): Array<{ role: "system" | "user"; content: string }> {
  const ask = o.action && PAGE_ACTIONS[o.action] ? PAGE_ACTIONS[o.action]! : (o.instruction ?? "").trim();
  const doc = page.content.length > 24_000 ? `${page.content.slice(0, 12_000)}\n…\n${page.content.slice(-12_000)}` : page.content;
  return [
    {
      role: "system",
      content: `You help write a document called "${page.title}". The user asks for a change or for new text. Answer with ONLY the text to put in the document, in Markdown, with no remarks before or after it and no code fence around it. Write in the document's language unless asked otherwise.`,
    },
    {
      role: "user",
      content: o.selection
        ? `The document:\n<<<\n${doc}\n>>>\n\nThe selected text:\n<<<\n${o.selection}\n>>>\n\n${ask || "Improve the selected text."}\nAnswer with the new text for the selection only.`
        : `The document so far:\n<<<\n${doc || "(empty)"}\n>>>\n\n${ask || "Continue the document with the next section."}\nAnswer with the new text only (it goes where the cursor is).`,
    },
  ];
}
