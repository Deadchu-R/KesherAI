/**
 * Slide decks (design DeckEditor): one JSON file each, edited by the open page (whole saves, with the revision it
 * started from) and by the model through the "slides" tool; every change tells the open pages, and the last 20
 * versions are kept.
 */
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";
import { DECK_THEMES, cleanSlide, describeDeck, type Deck, type DeckTheme } from "@kesher/shared";

const ID = /^[\w-]{1,80}$/;
const MAX_SLIDES = 80;
const MAX_BYTES = 20 * 1024 * 1024;

/** A deck in the list. */
export interface DeckSummary { id: string; title: string; slides: number; convId?: string; updatedAt: string }

/** The decks. */
export class DeckStore extends EventEmitter {
  private writes = Promise.resolve();

  /** @param dir - Where the deck files are. */
  constructor(private readonly dir: string) {
    super();
    this.setMaxListeners(100);
  }

  private file(id: string): string {
    if (!ID.test(id)) throw Object.assign(new Error("Bad deck id."), { statusCode: 400 });
    return join(this.dir, `${id}.json`);
  }

  /** Every deck, newest first. */
  async list(): Promise<DeckSummary[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const docs = await Promise.all(names.map((n) => this.get(n.slice(0, -5)).catch(() => undefined)));
    return docs
      .filter((d): d is Deck => !!d)
      .map((d) => ({ id: d.id, title: d.title, slides: d.slides.length, ...(d.convId ? { convId: d.convId } : {}), updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One deck, or undefined. */
  async get(id: string): Promise<Deck | undefined> {
    const text = await readFile(this.file(id), "utf8").catch(() => undefined);
    return text ? (JSON.parse(text) as Deck) : undefined;
  }

  /**
   * A new deck (a chat's own when convId is given: its id is the chat's, and an existing one is returned).
   *
   * @param p - Its title and slides.
   */
  async create(p: { title: string; slides?: unknown[]; theme?: string; convId?: string }): Promise<Deck> {
    const id = p.convId ? `chat-${p.convId}` : randomUUID();
    const had = p.convId ? await this.get(id) : undefined;
    if (had) return had;
    const deck: Deck = {
      id,
      title: p.title.trim().slice(0, 120) || "Slides",
      theme: p.theme && p.theme in DECK_THEMES ? (p.theme as DeckTheme) : "night",
      slides: (p.slides ?? []).slice(0, MAX_SLIDES).map((x, i) => cleanSlide(x, `s${i + 1}`)),
      ...(p.convId ? { convId: p.convId } : {}),
      rev: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.write(deck);
    return deck;
  }

  /**
   * Changes a deck under its lock (keeping the version before), saves it and tells the open pages.
   *
   * @param id - The deck.
   * @param fn - Changes it in place; may throw to refuse.
   */
  async update(id: string, fn: (d: Deck) => void): Promise<Deck> {
    let out!: Deck;
    const run = this.writes.then(async () => {
      const d = await this.get(id);
      if (!d) throw Object.assign(new Error("No such deck."), { statusCode: 404 });
      const before = { rev: d.rev, at: d.updatedAt, slides: d.slides, theme: d.theme, title: d.title };
      fn(d);
      if (d.slides.length > MAX_SLIDES) throw Object.assign(new Error(`A deck holds at most ${MAX_SLIDES} slides.`), { statusCode: 413 });
      d.versions = [...(d.versions ?? []), before].slice(-20);
      d.rev++;
      d.updatedAt = new Date().toISOString();
      if (Buffer.byteLength(JSON.stringify(d)) > MAX_BYTES) throw Object.assign(new Error("This deck is too big (20 MB): use smaller pictures."), { statusCode: 413 });
      await this.write(d);
      out = d;
    });
    this.writes = run.catch(() => undefined);
    await run;
    this.emit(`change:${id}`, out.rev);
    return out;
  }

  /**
   * What the open page saves: the whole deck, from the revision it started at (an older one is refused: the page
   * loads the newer one and tries again).
   */
  save(id: string, p: { title?: unknown; theme?: unknown; slides?: unknown; rev: number }): Promise<Deck> {
    if (!Array.isArray(p.slides)) throw Object.assign(new Error("slides must be a list."), { statusCode: 400 });
    const slides = p.slides as unknown[];
    return this.update(id, (d) => {
      if (p.rev !== d.rev) throw Object.assign(new Error("The deck changed; load it and save again."), { statusCode: 409 });
      d.slides = slides.slice(0, MAX_SLIDES).map((x, i) => cleanSlide(x, `s${Date.now().toString(36)}${i}`));
      if (typeof p.title === "string" && p.title.trim()) d.title = p.title.trim().slice(0, 120);
      if (typeof p.theme === "string" && p.theme in DECK_THEMES) d.theme = p.theme as DeckTheme;
    });
  }

  /** Back to an earlier version (itself kept as a version). */
  restore(id: string, rev: number): Promise<Deck> {
    return this.update(id, (d) => {
      const v = d.versions?.find((x) => x.rev === rev);
      if (!v) throw Object.assign(new Error("No such version."), { statusCode: 404 });
      d.slides = v.slides;
      d.theme = v.theme;
      d.title = v.title;
    });
  }

  /** Deletes a deck. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    this.emit(`change:${id}`, -1);
  }

  private async write(d: Deck): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.file(d.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(d), { mode: 0o600 });
    await rename(tmp, file);
  }
}

/**
 * The chat's "slides" tool: makes and edits the chat's own deck, which the user sees and edits on the canvas.
 *
 * @param store - The decks.
 * @param convId - The chat.
 * @param title - The chat's title (a new deck's name when none is given).
 */
export function deckTools(store: DeckStore, convId: string, title: () => string): AgentTool[] {
  const id = `chat-${convId}`;
  const own = async (t?: string) => (await store.get(id)) ?? store.create({ title: t || title() || "Slides", convId });
  return [
    {
      risk: "read",
      spec: {
        name: "slides",
        description:
          "This chat's slide deck, which the user sees, edits and presents in KesherAI (no PowerPoint needed). Use it whenever the user wants a presentation or slides. action 'read' shows the slides (ids, layouts, text). 'write' replaces the whole deck: title, theme (night, paper, ocean, sunset, forest) and slides. 'change' replaces one slide by id. 'add' adds slides (after the slide id in 'after', or at the end). 'delete' removes slides by id. A slide: {id (short, yours), layout: title | bullets | two | quote | picture, title, bullets: [short points, a few words each, at most 6], more: [the second column for 'two', the source for 'quote', the caption for 'picture'], image: an https picture URL for 'picture', notes: what the presenter says}. Write in the user's language. Read first when the user may have edited it.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write", "change", "add", "delete"] },
            title: { type: "string" },
            theme: { type: "string", enum: Object.keys(DECK_THEMES) },
            slides: { type: "array", items: { type: "object" }, description: "For 'write' and 'add'." },
            slide: { type: "object", description: "For 'change': the slide, with its id." },
            after: { type: "string", description: "For 'add': the slide id to add after." },
            ids: { type: "array", items: { type: "string" }, description: "For 'delete'." },
          },
          required: ["action"],
        },
      },
      async run(input) {
        const action = String(input.action ?? "read");
        const d = await own(typeof input.title === "string" ? input.title : undefined);
        if (action === "read") return { output: describeDeck(d) };
        const stamp = Date.now().toString(36);
        const saved = await store.update(d.id, (x) => {
          if (action === "write") {
            const slides = Array.isArray(input.slides) ? (input.slides as unknown[]) : [];
            if (!slides.length) throw new Error("Give the slides.");
            x.slides = slides.slice(0, MAX_SLIDES).map((s, i) => cleanSlide(s, `s${stamp}${i}`));
            if (typeof input.title === "string" && input.title.trim()) x.title = input.title.trim().slice(0, 120);
            if (typeof input.theme === "string" && input.theme in DECK_THEMES) x.theme = input.theme as DeckTheme;
          } else if (action === "change") {
            const s = cleanSlide(input.slide, "");
            const i = x.slides.findIndex((y) => y.id === s.id);
            if (i < 0) throw new Error(`No slide "${s.id}": read the deck for the ids.`);
            x.slides[i] = s;
          } else if (action === "add") {
            const slides = (Array.isArray(input.slides) ? (input.slides as unknown[]) : []).map((s, i) => cleanSlide(s, `s${stamp}${i}`));
            if (!slides.length) throw new Error("Give the slides to add.");
            const at = typeof input.after === "string" ? x.slides.findIndex((y) => y.id === input.after) : -1;
            x.slides.splice(at >= 0 ? at + 1 : x.slides.length, 0, ...slides);
          } else if (action === "delete") {
            const ids = new Set(Array.isArray(input.ids) ? (input.ids as unknown[]).map(String) : []);
            x.slides = x.slides.filter((y) => !ids.has(y.id));
          } else throw new Error(`Unknown action "${action}".`);
        });
        return { output: `Saved: ${saved.slides.length} slides. The user sees it at #/slides/${saved.id}.\n${describeDeck(saved)}` };
      },
    },
  ];
}

const stores = new Map<string, DeckStore>();

/** The one deck store of a data folder (the routes and the chats' tool share it). */
export function deckStoreFor(dir: string): DeckStore {
  let s = stores.get(dir);
  if (!s) stores.set(dir, (s = new DeckStore(dir)));
  return s;
}
