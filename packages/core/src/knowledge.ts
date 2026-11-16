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
  /** Its meaning as a vector, from the embedding model in `Index.vecModel` (kept on disk in `<id>.vec`). */
  vec?: Float32Array;
  /** Where its vector is in `<id>.vec` (on disk only). */
  vi?: number;
}

interface FileEntry {
  mtime: number;
  size: number;
  passages: Passage[];
}

interface Index {
  files: Record<string, FileEntry>;
  /** The vectors' length, when they are kept in `<id>.vec` (float32, one after another). */
  dim?: number;
  /** The embedding model the vectors come from. */
  vecModel?: string;
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

/** Pictures, described by the local vision model so they can be found (Msty Studio 2.9 describes its library's pictures too). */
const PIC_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
/** Pictures described per pass (each is a call to the model; the rest come in the next pass). */
const PICTURES_PER_PASS = 12;
const MAX_PICTURE = 8 * 1024 * 1024;

const DOC_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".md", ".markdown", ".txt", ".csv", ".html", ".htm", ".json", ".rtf", ".cs", ".ts", ".js", ".py", ".cpp", ".h", ".hpp", ".rst", ".mdx", ".gd", ".java", ".go", ".rs", ".yaml", ".yml", ".xml", ".ini", ".log"]);
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

/** An embedding model for search by meaning. */
export interface Embedder {
  /** The model's id (vectors are made again when it changes). */
  id: string;
  /** Vectors for texts; `query` for a question, `doc` for a passage (some models word them differently). */
  embed(texts: string[], kind: "query" | "doc"): Promise<number[][]>;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Writes an index: the text in `<id>.json`, the vectors as float32 in `<id>.vec` (a base with tens of thousands of
 * passages used to be a JSON file of half a gigabyte, and every base was read at start: the app ran out of memory).
 *
 * @param dir - The knowledge folder.
 * @param id - The base.
 * @param ix - Its index.
 */
export async function writeIndex(dir: string, id: string, ix: Index): Promise<void> {
  let dim = 0;
  let count = 0;
  for (const f of Object.values(ix.files)) for (const p of f.passages) if (p.vec?.length) {
    dim ||= p.vec.length;
    if (p.vec.length === dim) count++;
  }
  const vecs = new Float32Array(count * dim);
  let n = 0;
  const files: Record<string, FileEntry> = {};
  for (const [key, f] of Object.entries(ix.files)) {
    files[key] = {
      ...f,
      passages: f.passages.map(({ vec, vi: _old, ...rest }) => {
        if (!vec?.length || vec.length !== dim) return rest;
        vecs.set(vec, n * dim);
        return { ...rest, vi: n++ };
      }),
    };
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.vec`), Buffer.from(vecs.buffer, vecs.byteOffset, vecs.byteLength));
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ ...ix, files, ...(dim ? { dim } : {}) }));
}

/**
 * Reads an index written by {@link writeIndex}, or an old one with its vectors inside the JSON (made smaller as it is
 * read, and written again in the new shape).
 *
 * @returns The index, and whether it was the old shape.
 */
export async function readIndex(dir: string, id: string): Promise<{ ix: Index; old: boolean }> {
  const ix = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Omit<Index, "files"> & { files: Record<string, { mtime: number; size: number; passages: Array<Omit<Passage, "vec"> & { vec?: number[] | Float32Array }> }> };
  let old = false;
  let all: Float32Array | undefined;
  if (ix.dim) {
    const buf = await readFile(join(dir, `${id}.vec`)).catch(() => undefined);
    if (buf) all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  for (const f of Object.values(ix.files)) {
    for (const p of f.passages) {
      if (Array.isArray(p.vec)) {
        old = true;
        p.vec = Float32Array.from(p.vec);
      } else if (all && ix.dim && typeof p.vi === "number" && (p.vi + 1) * ix.dim <= all.length) {
        p.vec = all.subarray(p.vi * ix.dim, (p.vi + 1) * ix.dim);
      }
      delete p.vi;
    }
  }
  return { ix: ix as Index, old };
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
  /** Pictures still waiting for a description (a later pass takes them). */
  private later = new Map<string, NodeJS.Timeout>();

  /**
   * @param dir - The knowledge folder in KesherAI's data.
   * @param embedder - Search by meaning, when a model for it is set.
   * @param seeing - Describes a picture with a vision model on this computer, when one is loaded (never a cloud model:
   *   the user's pictures stay here), and whether a chat is working now (pictures then wait, so chats stay fast).
   */
  constructor(
    private readonly dir: string,
    private readonly embedder: () => Embedder | undefined = () => undefined,
    private readonly seeing: { describe?: () => Promise<((data: Buffer, mime: string) => Promise<string>) | undefined>; busy?: () => boolean } = {},
  ) {}

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
          const { ix, old } = await readIndex(this.dir, b.id);
          this.indexes.set(b.id, ix);
          // An old index (vectors inside the JSON): written again in the small shape now.
          if (old) await writeIndex(this.dir, b.id, ix).catch(() => undefined);
        } catch {
          this.indexes.set(b.id, { files: {} });
        }
        this.watch(b);
      }
      // One base at a time: all of them at once held every big index in memory together.
      void (async () => {
        for (const b of this.bases) await this.reindex(b.id).catch(() => undefined);
      })();
    })();
    return this.loaded;
  }

  private async saveBases() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "bases.json"), JSON.stringify(this.bases, null, 2));
  }

  /** @returns The size on disk of a base's index (its .json and .vec files; a missing one counts as 0). */
  async baseSize(id: string): Promise<number> {
    const size = (f: string) => stat(join(this.dir, f)).then((s) => s.size, () => 0);
    return (await size(`${id}.json`)) + (await size(`${id}.vec`));
  }

  /** @returns The bases with their status. */
  async list() {
    await this.load();
    return Promise.all(this.bases.map(async (b) => {
      const ix = this.indexes.get(b.id) ?? { files: {} };
      const files = Object.keys(ix.files).length;
      const passages = Object.values(ix.files).reduce((n, f) => n + f.passages.length, 0);
      const e = this.embedder();
      const embedded = e && ix.vecModel === e.id ? Object.values(ix.files).reduce((n, f) => n + f.passages.filter((p) => p.vec).length, 0) : 0;
      return { ...b, files, passages, embedded, indexing: this.indexing.has(b.id), indexedAt: ix.indexedAt ?? null, error: ix.error ?? null, size: await this.baseSize(b.id) };
    }));
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
    await rm(join(this.dir, `${id}.vec`), { force: true });
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
      let describe: ((data: Buffer, mime: string) => Promise<string>) | null | undefined;
      let described = 0;
      let pending = 0;
      try {
        for (const folder of b.folders) {
          for await (const file of walk(folder)) {
            const key = file;
            seen.add(key);
            const st = await stat(file).catch(() => undefined);
            if (!st || st.size > MAX_FILE) continue;
            const old = ix.files[key];
            if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
            const mime = PIC_EXT[extname(file).toLowerCase()];
            if (mime) {
              // A picture: described once by the local vision model, then searched like text. Without one, or while a
              // chat works, or past this pass's share, it waits (not recorded, so a later pass takes it).
              if (st.size > MAX_PICTURE) continue;
              if (described >= PICTURES_PER_PASS || this.seeing.busy?.()) {
                pending++;
                continue;
              }
              describe ??= (await this.seeing.describe?.().catch(() => undefined)) ?? null;
              if (!describe) continue;
              try {
                const text = (await describe(await readFile(file), mime)).trim();
                described++;
                const rel = relative(folder, file) || file;
                if (text) ix.files[key] = { mtime: st.mtimeMs, size: st.size, passages: passagesOf(`Picture ${rel}: ${text}`).map((t) => ({ source: rel, page: 1, text: t })) };
              } catch {
                pending++;
              }
              continue;
            }
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
        // Search by meaning: vectors for passages that have none yet (all of them when the model changed).
        const e = this.embedder();
        if (e) {
          if (ix.vecModel !== e.id) for (const f of Object.values(ix.files)) for (const p of f.passages) delete p.vec;
          ix.vecModel = e.id;
          const todo = Object.values(ix.files).flatMap((f) => f.passages.filter((p) => !p.vec));
          for (let i = 0; i < todo.length; i += 16) {
            const batch = todo.slice(i, i + 16);
            const vecs = await e.embed(batch.map((p) => p.text), "doc");
            batch.forEach((p, j) => (p.vec = Float32Array.from(normalize(vecs[j] ?? []))));
            // Save as it goes, so a long first run is not lost (every 3,200 passages: each save writes the whole base).
            if (i > 0 && i % 3200 === 0) await writeIndex(this.dir, id, ix).catch(() => undefined);
          }
        }
        ix.indexedAt = new Date().toISOString();
        delete ix.error;
        // Pictures left for later: another pass in ten minutes.
        clearTimeout(this.later.get(id));
        if (pending) {
          const t = setTimeout(() => void this.reindex(id).catch(() => undefined), 10 * 60_000);
          t.unref?.();
          this.later.set(id, t);
        }
      } catch (e) {
        ix.error = (e as Error).message;
      }
      this.indexes.set(id, ix);
      await writeIndex(this.dir, id, ix);
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
    const e = this.embedder();
    const all: Array<Passage & { base: string }> = [];
    // Vectors count only when they come from the active embedding model: a base still being indexed again after the
    // model changed keeps the old model's vectors, which mean nothing next to the new model's question.
    for (const b of bases) {
      const ix = this.indexes.get(b.id);
      const sameModel = !!e && ix?.vecModel === e.id;
      for (const f of Object.values(ix?.files ?? {})) for (const p of f.passages) all.push({ ...p, ...(sameModel ? {} : { vec: undefined }), base: b.name });
    }
    const words = rank(all, query, Math.max(k * 4, 30));
    const withVec = e ? all.filter((p) => p.vec?.length) : [];
    if (!e || !withVec.length) return words.slice(0, k).map(({ base, source, page, text, score }) => ({ base, source, page, text, score: Math.round(score * 100) / 100 }));
    // Both ways: by words (BM25) and by meaning (vectors), joined by rank (reciprocal rank fusion).
    let qv: number[];
    try {
      qv = normalize((await e.embed([query], "query"))[0] ?? []);
    } catch {
      return words.slice(0, k).map(({ base, source, page, text, score }) => ({ base, source, page, text, score: Math.round(score * 100) / 100 }));
    }
    const meaning = withVec
      .filter((p) => p.vec!.length === qv.length)
      .map((p) => ({ p, s: dot(qv, p.vec!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(k * 4, 30));
    const fused = new Map<Passage & { base: string }, number>();
    words.forEach((w, i) => {
      const orig = all.find((p) => p.text === w.text && p.source === w.source && p.page === w.page)!;
      fused.set(orig, (fused.get(orig) ?? 0) + 1 / (60 + i));
    });
    meaning.forEach((m, i) => fused.set(m.p, (fused.get(m.p) ?? 0) + 1 / (60 + i)));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([p, sc]) => ({ base: p.base, source: p.source, page: p.page, text: p.text, score: Math.round(sc * 10_000) / 100 }));
  }

  /** @returns The bases as loaded now (empty before `load()`). */
  current(): KnowledgeBase[] {
    return this.bases;
  }

  /** Indexes every base again (e.g. for new vectors after the embedding model changed). */
  async reindexAll(): Promise<void> {
    await this.load();
    for (const b of this.bases) await this.reindex(b.id).catch(() => undefined);
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
    } else if (e.isFile() && (DOC_EXT.has(extname(e.name).toLowerCase()) || PIC_EXT[extname(e.name).toLowerCase()])) yield full;
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
