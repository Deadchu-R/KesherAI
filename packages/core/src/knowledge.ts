import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { documentText, type AgentTool } from "@kesher/agent";

/**
 * Knowledge bases: folders of documents and web pages that the models can
 * search and answer from, with the source of each passage. KesherAI keeps
 * each folder's index up to date (it re-reads files that changed).
 *
 * Search is BM25 over passages of about a thousand characters, with light
 * handling of Hebrew prefixes (ו, ה, ב, ל, מ, ש, כ), so it works without an
 * embedding model and in any language.
 */

/** A knowledge base. */
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  folders: string[];
  urls: string[];
  createdAt: string;
}

/** One searchable passage. */
interface Passage {
  /** File path relative to its folder, or the URL. */
  source: string;
  /** Page (PDF) or part number. */
  page: number;
  text: string;
}

interface FileEntry {
  mtime: number;
  size: number;
  passages: Passage[];
}

interface Index {
  files: Record<string, FileEntry>;
  indexedAt?: string;
  error?: string;
}

/** A search result. */
export interface KnowledgeHit {
  base: string;
  source: string;
  page: number;
  text: string;
  score: number;
}

const DOC_EXT = new Set([".pdf", ".docx", ".md", ".markdown", ".txt", ".csv", ".html", ".htm", ".json", ".rtf", ".cs", ".ts", ".js", ".py", ".cpp", ".h", ".java", ".go", ".rs", ".yaml", ".yml", ".xml", ".ini", ".log"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "Library", "Temp", "obj", "bin", "Binaries", "Intermediate", "DerivedDataCache", "Saved", "dist", "build", ".venv", "venv", "__pycache__"]);
const MAX_FILE = 60 * 1024 * 1024;
const HEB_PREFIX = /^[והבלמשכ]/;
const HEBREW = /^[\u0590-\u05FF]+$/;

/**
 * Splits text into search words: lower case, numbers kept, and Hebrew words
 * also without their prefixes (ו, ה, ב, ל, מ, ש, כ).
 *
 * @param text - Any text.
 * @returns The words.
 */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []) {
    if (w.length < 2 || w.length > 40) continue;
    out.push(w);
    // "והמשחק" is also found as "המשחק" and "משחק"; "בית" stays "בית".
    let rest = w;
    for (let i = 0; i < 2 && HEBREW.test(rest) && HEB_PREFIX.test(rest) && rest.length > 3; i++) {
      rest = rest.slice(1);
      out.push(rest);
    }
  }
  return out;
}

/**
 * Cuts a page into passages of about `size` characters, at paragraph or sentence ends.
 *
 * @param text - The page.
 * @param size - About how long each passage is.
 * @returns The passages.
 */
export function passagesOf(text: string, size = 1000): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(". ", size) + 1;
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    // A little overlap, so a sentence cut in two is still found.
    rest = rest.slice(Math.max(0, cut - 120));
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * Ranks passages for a question with BM25.
 *
 * @param passages - What to search.
 * @param query - The question.
 * @param k - How many to return.
 * @returns The best passages with their score.
 */
export function rank<T extends { text: string }>(passages: T[], query: string, k = 8): Array<T & { score: number }> {
  const q = [...new Set(words(query))];
  if (!q.length || !passages.length) return [];
  const docs = passages.map((p) => words(p.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) if (q.includes(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const k1 = 1.4;
  const b = 0.75;
  const scored = passages.map((p, i) => {
    const d = docs[i]!;
    let score = 0;
    for (const w of q) {
      const n = df.get(w);
      if (!n) continue;
      const tf = d.filter((x) => x === w).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
    }
    // Passages that contain the words close together, or the whole phrase, first.
    if (q.length > 1 && p.text.toLowerCase().includes(query.toLowerCase().trim())) score *= 1.5;
    return { ...p, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, c) => c.score - a.score).slice(0, k);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Keeps the knowledge bases and their indexes. */
export class Knowledge {
  private bases: KnowledgeBase[] = [];
  private indexes = new Map<string, Index>();
  private indexing = new Map<string, Promise<void>>();
  private watchers = new Map<string, FSWatcher[]>();
  private dirty = new Map<string, NodeJS.Timeout>();
  private loaded?: Promise<void>;

  /** @param dir - The knowledge folder in KesherAI's data. */
  constructor(private readonly dir: string) {}

  /** Reads the bases and starts keeping them up to date (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.bases = JSON.parse(await readFile(join(this.dir, "bases.json"), "utf8")) as KnowledgeBase[];
      } catch {
        this.bases = [];
      }
      for (const b of this.bases) {
        try {
          this.indexes.set(b.id, JSON.parse(await readFile(join(this.dir, `${b.id}.json`), "utf8")) as Index);
        } catch {
          this.indexes.set(b.id, { files: {} });
        }
        this.watch(b);
        void this.reindex(b.id).catch(() => undefined);
      }
    })();
    return this.loaded;
  }

  private async saveBases() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "bases.json"), JSON.stringify(this.bases, null, 2));
  }

  /** @returns The bases with their status. */
  async list() {
    await this.load();
    return this.bases.map((b) => {
      const ix = this.indexes.get(b.id) ?? { files: {} };
      const files = Object.keys(ix.files).length;
      const passages = Object.values(ix.files).reduce((n, f) => n + f.passages.length, 0);
      return { ...b, files, passages, indexing: this.indexing.has(b.id), indexedAt: ix.indexedAt ?? null, error: ix.error ?? null };
    });
  }

  /**
   * Creates or changes a base, then indexes it.
   *
   * @param input - Name, folders, web pages.
   * @returns The base.
   */
  async save(input: Partial<KnowledgeBase> & { name: string }): Promise<KnowledgeBase> {
    await this.load();
    const old = input.id ? this.bases.find((b) => b.id === input.id) : undefined;
    const base: KnowledgeBase = {
      id: old?.id ?? randomUUID(),
      name: input.name.trim().slice(0, 80) || "Knowledge",
      ...(input.description?.trim() ? { description: input.description.trim().slice(0, 300) } : {}),
      folders: [...new Set((input.folders ?? old?.folders ?? []).map((f) => f.trim()).filter(Boolean))],
      urls: [...new Set((input.urls ?? old?.urls ?? []).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u)))],
      createdAt: old?.createdAt ?? new Date().toISOString(),
    };
    this.bases = old ? this.bases.map((b) => (b.id === base.id ? base : b)) : [...this.bases, base];
    if (!this.indexes.has(base.id)) this.indexes.set(base.id, { files: {} });
    await this.saveBases();
    this.watch(base);
    void this.reindex(base.id).catch(() => undefined);
    return base;
  }

  /** Deletes a base and its index (never the documents). */
  async remove(id: string): Promise<void> {
    await this.load();
    this.unwatch(id);
    this.bases = this.bases.filter((b) => b.id !== id);
    this.indexes.delete(id);
    await this.saveBases();
    await rm(join(this.dir, `${id}.json`), { force: true });
  }

  private unwatch(id: string) {
    for (const w of this.watchers.get(id) ?? []) w.close();
    this.watchers.delete(id);
  }

  /** Re-reads changed files soon after something in the folders changes. */
  private watch(b: KnowledgeBase) {
    this.unwatch(b.id);
    const list: FSWatcher[] = [];
    for (const f of b.folders) {
      try {
        const w = watch(f, { recursive: true, persistent: false }, () => {
          clearTimeout(this.dirty.get(b.id));
          const t = setTimeout(() => void this.reindex(b.id).catch(() => undefined), 5000);
          t.unref?.();
          this.dirty.set(b.id, t);
        });
        w.on("error", () => undefined);
        list.push(w);
      } catch {
        /* recursive watching is not available here: the index refreshes when searched */
      }
    }
    this.watchers.set(b.id, list);
  }

  /**
   * Brings a base's index up to date: new and changed files are read,
   * deleted ones dropped, web pages fetched again.
   *
   * @param id - The base.
   */
  reindex(id: string): Promise<void> {
    const running = this.indexing.get(id);
    if (running) return running;
    const p = (async () => {
      const b = this.bases.find((x) => x.id === id);
      if (!b) return;
      const ix = this.indexes.get(id) ?? { files: {} };
      const seen = new Set<string>();
      try {
        for (const folder of b.folders) {
          for await (const file of walk(folder)) {
            const key = file;
            seen.add(key);
            const st = await stat(file).catch(() => undefined);
            if (!st || st.size > MAX_FILE) continue;
            const old = ix.files[key];
            if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
            try {
              const doc = await documentText(await readFile(file), file);
              const rel = relative(folder, file) || file;
              const passages = doc.pages.flatMap((page, i) => passagesOf(extname(file) === ".html" || extname(file) === ".htm" ? htmlToText(page) : page).map((text) => ({ source: rel, page: i + 1, text })));
              ix.files[key] = { mtime: st.mtimeMs, size: st.size, passages };
            } catch {
              ix.files[key] = { mtime: st.mtimeMs, size: st.size, passages: [] };
            }
          }
        }
        for (const url of b.urls) {
          seen.add(url);
          const old = ix.files[url];
          if (old && Date.now() - old.mtime < 24 * 3600_000) continue; // web pages: once a day
          try {
            const res = await fetch(url, { headers: { "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) });
            if (!res.ok) continue;
            const type = res.headers.get("content-type") ?? "";
            const text = /pdf/.test(type) ? (await documentText(new Uint8Array(await res.arrayBuffer()), "page.pdf")).pages.join("\n\n") : htmlToText(await res.text());
            ix.files[url] = { mtime: Date.now(), size: text.length, passages: passagesOf(text).map((t, i) => ({ source: url, page: i + 1, text: t })) };
          } catch {
            /* offline: keep the old copy */
          }
        }
        for (const key of Object.keys(ix.files)) if (!seen.has(key)) delete ix.files[key];
        ix.indexedAt = new Date().toISOString();
        delete ix.error;
      } catch (e) {
        ix.error = (e as Error).message;
      }
      this.indexes.set(id, ix);
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${id}.json`), JSON.stringify(ix));
    })().finally(() => this.indexing.delete(id));
    this.indexing.set(id, p);
    return p;
  }

  /**
   * Searches one base, or all of them.
   *
   * @param query - The question or words.
   * @param baseName - A base's name or id, or empty for all.
   * @param k - How many passages.
   * @returns The best passages, with source and page.
   */
  async search(query: string, baseName?: string, k = 8): Promise<KnowledgeHit[]> {
    await this.load();
    const pick = baseName?.trim().toLowerCase();
    const bases = pick ? this.bases.filter((b) => b.id === pick || b.name.toLowerCase() === pick || b.name.toLowerCase().includes(pick)) : this.bases;
    const all: Array<Passage & { base: string }> = [];
    for (const b of bases) for (const f of Object.values(this.indexes.get(b.id)?.files ?? {})) for (const p of f.passages) all.push({ ...p, base: b.name });
    return rank(all, query, k).map(({ base, source, page, text, score }) => ({ base, source, page, text, score: Math.round(score * 100) / 100 }));
  }

  /** @returns The bases as loaded now (empty before `load()`). */
  current(): KnowledgeBase[] {
    return this.bases;
  }

  /** Stops watching folders. */
  close(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 15) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, depth + 1);
    } else if (e.isFile() && DOC_EXT.has(extname(e.name).toLowerCase())) yield full;
  }
}

/**
 * The `search_knowledge` tool: the model searches the user's knowledge bases.
 *
 * @param k - The knowledge bases.
 * @returns The tool, or nothing when there are no bases yet.
 */
export function knowledgeTools(k: Knowledge): AgentTool[] {
  const bases = k.current();
  if (!bases.length) return [];
  return [
    {
      risk: "read",
      spec: {
        name: "search_knowledge",
        description: `Search the user's knowledge bases (their own documents and saved web pages) and answer from what you find. Always cite the source of each fact, like (handbook.pdf, p. 3). Search again with other words if the first results miss. Bases: ${bases.map((b) => `"${b.name}"${b.description ? ` (${b.description})` : ""}`).join(", ")}.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words to look for (in the documents' language)." },
            base: { type: "string", description: "Only this base (its name). Leave out to search all." },
          },
          required: ["query"],
        },
      },
      async run(input) {
        const hits = await k.search(String(input.query ?? ""), typeof input.base === "string" ? input.base : undefined);
        if (!hits.length) return { output: `Nothing found for "${String(input.query)}". Try other words or a synonym.` };
        return { output: hits.map((h, i) => `[${i + 1}] ${h.source}${/^https?:/.test(h.source) ? "" : `, p. ${h.page}`} (${h.base})\n${h.text}`).join("\n\n") };
      },
    },
  ];
}
