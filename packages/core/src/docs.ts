/**
 * Documents (design DocEditor): KesherAI's own documents, kept as Markdown, edited by her in a block editor and by the
 * model through the "document" tool; every change tells the open pages; the last 20 versions are kept.
 */
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { replaceFile } from "./replace-file.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";

const ID = /^[\w-]{1,80}$/;
const MAX = 2 * 1024 * 1024;

/** A document. */
export interface Doc {
  id: string;
  title: string;
  /** The text, as Markdown. */
  body: string;
  convId?: string;
  rev: number;
  updatedAt: string;
  versions?: Array<{ rev: number; at: string; title: string; body: string }>;
}

/** The documents. */
export class DocStore extends EventEmitter {
  private writes = Promise.resolve();

  /** @param dir - Where the files are. */
  constructor(private readonly dir: string) {
    super();
    this.setMaxListeners(100);
  }

  private file(id: string): string {
    if (!ID.test(id)) throw Object.assign(new Error("Bad document id."), { statusCode: 400 });
    return join(this.dir, `${id}.json`);
  }

  /** Every document, newest first (without the text). */
  async list(): Promise<Array<{ id: string; title: string; words: number; convId?: string; updatedAt: string }>> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const docs = await Promise.all(names.map((n) => this.get(n.slice(0, -5)).catch(() => undefined)));
    return docs
      .filter((d): d is Doc => !!d)
      .map((d) => ({ id: d.id, title: d.title, words: d.body.split(/\s+/).filter(Boolean).length, ...(d.convId ? { convId: d.convId } : {}), updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One document, or undefined. */
  async get(id: string): Promise<Doc | undefined> {
    const text = await readFile(this.file(id), "utf8").catch(() => undefined);
    return text ? (JSON.parse(text) as Doc) : undefined;
  }

  /** A new document (a chat's own when convId is given; its existing one is returned). */
  async create(p: { title: string; body?: string; convId?: string }): Promise<Doc> {
    const id = p.convId ? `chat-${p.convId}` : randomUUID();
    const had = p.convId ? await this.get(id) : undefined;
    if (had) return had;
    const d: Doc = { id, title: p.title.trim().slice(0, 160) || "Document", body: String(p.body ?? "").slice(0, MAX), ...(p.convId ? { convId: p.convId } : {}), rev: 0, updatedAt: new Date().toISOString() };
    await this.write(d);
    return d;
  }

  /** Changes a document under its lock (keeping the version before), saves it and tells the open pages. */
  async update(id: string, fn: (d: Doc) => void): Promise<Doc> {
    let out!: Doc;
    const run = this.writes.then(async () => {
      const d = await this.get(id);
      if (!d) throw Object.assign(new Error("No such document."), { statusCode: 404 });
      const before = { rev: d.rev, at: d.updatedAt, title: d.title, body: d.body };
      fn(d);
      if (d.body.length > MAX) throw Object.assign(new Error("This document is too long (2 MB)."), { statusCode: 413 });
      // Small edits while typing make one version a minute, not one per keystroke.
      const last = d.versions?.at(-1);
      if (!last || Date.parse(before.at) - Date.parse(last.at) > 60_000) d.versions = [...(d.versions ?? []), before].slice(-20);
      d.rev++;
      d.updatedAt = new Date().toISOString();
      await this.write(d);
      out = d;
    });
    this.writes = run.catch(() => undefined);
    await run;
    this.emit(`change:${id}`, out.rev);
    return out;
  }

  /** The open page's save, from the revision it started at (an older one is refused). */
  save(id: string, p: { title?: unknown; body?: unknown; rev: number }): Promise<Doc> {
    if (typeof p.body !== "string") throw Object.assign(new Error("body must be text."), { statusCode: 400 });
    const body = p.body;
    return this.update(id, (d) => {
      if (p.rev !== d.rev) throw Object.assign(new Error("The document changed; load it and save again."), { statusCode: 409 });
      d.body = body;
      if (typeof p.title === "string" && p.title.trim()) d.title = p.title.trim().slice(0, 160);
    });
  }

  /** Back to an earlier version. */
  restore(id: string, rev: number): Promise<Doc> {
    return this.update(id, (d) => {
      const v = d.versions?.find((x) => x.rev === rev);
      if (!v) throw Object.assign(new Error("No such version."), { statusCode: 404 });
      d.title = v.title;
      d.body = v.body;
    });
  }

  /**
   * Brings in the older "Pages" documents (one JSON each, Markdown in `content`) once: each one not here yet becomes
   * a document with the same id, so its old #/pages link opens it. The old files stay where they are.
   *
   * @param pagesDir - The old pages folder.
   * @returns How many were brought in.
   */
  async importPages(pagesDir: string): Promise<number> {
    let n = 0;
    for (const name of (await readdir(pagesDir).catch(() => [] as string[])).filter((x) => x.endsWith(".json"))) {
      const id = name.slice(0, -5);
      if (!ID.test(id) || (await this.get(id).catch(() => undefined))) continue;
      type Old = { title?: unknown; content?: unknown; updatedAt?: unknown } | null;
      let p: Old;
      try {
        p = JSON.parse(await readFile(join(pagesDir, name), "utf8")) as Old;
      } catch {
        continue; // A broken or unreadable file is skipped, not the rest.
      }
      if (!p || typeof p.content !== "string") continue;
      await this.write({ id, title: String(p.title ?? "").trim().slice(0, 160) || "Document", body: p.content.slice(0, MAX), rev: 0, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : new Date().toISOString() });
      n++;
    }
    return n;
  }

  /** Deletes a document. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    this.emit(`change:${id}`, -1);
  }

  private async write(d: Doc): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.file(d.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(d), { mode: 0o600 });
    await replaceFile(tmp, file);
  }
}

/**
 * A section of Markdown by its heading: from the heading line to the next heading of the same or a higher level.
 *
 * @param body - The document.
 * @param heading - The heading's text (without #).
 * @returns Where it starts and ends, or undefined.
 */
export function findSection(body: string, heading: string): { start: number; end: number } | undefined {
  const lines = body.split("\n");
  const want = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  let at = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (at < 0 && m[2]!.trim().toLowerCase() === want) {
      at = i;
      level = m[1]!.length;
    } else if (at >= 0 && m[1]!.length <= level) {
      return { start: lines.slice(0, at).join("\n").length + (at ? 1 : 0), end: lines.slice(0, i).join("\n").length + 1 };
    }
  }
  return at < 0 ? undefined : { start: lines.slice(0, at).join("\n").length + (at ? 1 : 0), end: body.length };
}

const stores = new Map<string, DocStore>();

/** The one document store of a data folder (the routes and the chats' tool share it). */
export function docStoreFor(dir: string): DocStore {
  let s = stores.get(dir);
  if (!s) stores.set(dir, (s = new DocStore(dir)));
  return s;
}

/**
 * The chat's "document" tool: writes and edits the chat's own document, which the user sees and edits in KesherAI.
 *
 * @param store - The documents.
 * @param convId - The chat.
 * @param title - The chat's title.
 */
export function docTools(store: DocStore, convId: string, title: () => string): AgentTool[] {
  const id = `chat-${convId}`;
  const own = async (t?: string, other?: unknown) => {
    // A document opened in KesherAI (its "✨ ask" sends its id), or else this chat's own.
    if (typeof other === "string" && other && other !== id) {
      const d = await store.get(other).catch(() => undefined);
      if (!d) throw new Error(`No document "${other}".`);
      return d;
    }
    return (await store.get(id)) ?? store.create({ title: t || title() || "Document", convId });
  };
  return [
    {
      risk: "read",
      spec: {
        name: "document",
        description:
          "This chat's document, which the user sees and edits in KesherAI (no Word needed): use it when the user wants a document, summary, report, essay outline, letter or notes to keep. Markdown: # headings, lists, > quotes, tables, code. action 'read' returns it. 'write' replaces it all (title, body). 'append' adds text at the end. 'section' replaces the section under a heading (heading: its text; body: the new section, including its heading line); a heading not found is added at the end. Write in the user's language. Read first when the user may have edited it. id: another document's id (when the user names one, as in #/docs/<id>); leave it out for this chat's own.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write", "append", "section"] },
            id: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            heading: { type: "string" },
          },
          required: ["action"],
        },
      },
      async run(input) {
        const action = String(input.action ?? "read");
        const d = await own(typeof input.title === "string" ? input.title : undefined, input.id);
        if (action === "read") return { output: `# ${d.title}\n\n${d.body || "(empty)"}` };
        const body = typeof input.body === "string" ? input.body.replace(/\r/g, "") : "";
        if (!body.trim()) throw new Error("Give the text (body).");
        const saved = await store.update(d.id, (x) => {
          if (action === "write") {
            x.body = body;
            if (typeof input.title === "string" && input.title.trim()) x.title = input.title.trim().slice(0, 160);
          } else if (action === "append") x.body = `${x.body.trimEnd()}${x.body.trim() ? "\n\n" : ""}${body}`;
          else if (action === "section") {
            const at = findSection(x.body, String(input.heading ?? ""));
            x.body = at ? `${x.body.slice(0, at.start)}${body.trimEnd()}\n\n${x.body.slice(at.end)}`.replace(/\n{3,}/g, "\n\n").trimEnd() : `${x.body.trimEnd()}\n\n${body}`;
          } else throw new Error(`Unknown action "${action}".`);
        });
        return { output: `Saved (${saved.body.split(/\s+/).filter(Boolean).length} words). The user sees it at #/docs/${saved.id}.` };
      },
    },
  ];
}
