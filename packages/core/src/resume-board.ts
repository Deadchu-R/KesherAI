import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { replaceFile } from "./replace-file.js";

/**
 * "Continue what was running" after a restart (work list: "Pause running commands and tasks on restart, update or
 * shutdown and resume where stopped, for all kinds"; extends the helper resume of 2e9a75f).
 *
 * How others do it: VS Code restores its terminals and asks before running a task again; JetBrains' "Restore
 * running configurations" after an update; browsers offer "Restore pages" once, with each tab listed. KesherAI takes
 * the browser's way: one card after the start lists every piece of work the close cut off, each with Continue and
 * Drop. Work the user started that already knows how to go on by itself (a download, a background helper, self-work
 * within its time) keeps doing so and shows on the card with Drop only. Nothing the user did not start runs again by
 * itself: Antigravity still runs only on the user's Run, an engine sync waits for Continue.
 *
 * Each area registers a {@link ResumeSource}. On shutdown or before an update {@link ResumeBoard.save} asks every
 * source what is running now (live state, e.g. the tool a chat is in) and writes one record in the data folder; after
 * the start {@link ResumeBoard.start} reads it back and adds what each area's own store kept (chats on the
 * interrupted list, pending downloads, helpers that continue). An item leaves the card when the user acts on it, or
 * when its area says it is no longer there (the chat was continued from its own banner, the download finished).
 */

/** What kind of work an item is (the card's icon and label). */
export type ResumeKind = "chat" | "media" | "render" | "helper" | "inbox" | "self-work" | "download" | "engine-sync";

/** Every kind, for checking what the record file holds. */
const KINDS = new Set<ResumeKind>(["chat", "media", "render", "helper", "inbox", "self-work", "download", "engine-sync"]);

/** One piece of work a close cut off. */
export interface ResumeItem {
  /** Unique on the card: `<source>:<its own id>`. */
  id: string;
  /** The registered source that owns it. */
  source: string;
  kind: ResumeKind;
  /** What it is (a chat's title, a file's name, a task's title). */
  title: string;
  /** Where it stood (the tool a chat was in, the project of a sync). */
  detail?: string;
  /** When it stopped (ISO). */
  at: string;
  /** It continues by itself (the user started it before the close): the card offers Drop only. */
  auto: boolean;
  /** The app page that shows it (a hash such as `#/c/<id>`). */
  link?: string;
  /** The source's own reference (a chat id, a task id, a project folder). */
  ref: string;
}

/** Who asks to continue: some kinds follow their own rules (an Antigravity task runs only on this computer's Run). */
export interface ResumeContext {
  /** The request came from this computer (not the phone in remote). */
  local: boolean;
}

/** One area's part of the card. */
export interface ResumeSource {
  /** At shutdown or before an update: what is running now that this area can bring back. */
  snapshot?(): Promise<ResumeItem[]> | ResumeItem[];
  /**
   * After the start: the items this area's own store kept. Receives the record's items of this source, so it can
   * keep their detail (the record knows which tool a chat was in; the chat's interrupted list does not).
   */
  found?(saved: ResumeItem[]): Promise<ResumeItem[]> | ResumeItem[];
  /** Whether the item is still waiting (false takes it off the card: done elsewhere, or gone). */
  alive?(item: ResumeItem): Promise<boolean> | boolean;
  /** Continues it. Throws with a message the card shows when it cannot. */
  continue(item: ResumeItem, ctx: ResumeContext): Promise<void>;
  /** Drops it: stops what continues by itself, or only takes it off the card (never deletes the user's work). */
  drop(item: ResumeItem): Promise<void>;
}

/** Why the record was written. */
export type ResumeReason = "shutdown" | "update" | "restart";

/** The record on disk. */
interface Saved {
  reason?: ResumeReason;
  at?: string;
  items: ResumeItem[];
}

/** The most items kept (a close rarely cuts off more than a handful). */
const MAX_ITEMS = 40;
/** How long one source may take to answer at shutdown (a slow one must not hold the close). */
const SNAPSHOT_MS = 2000;

/**
 * Checks one item read from the record file (written by KesherAI, but a damaged file must not reach the card).
 *
 * @param x - What the file held.
 * @returns Whether it is a whole item.
 */
export function isResumeItem(x: unknown): x is ResumeItem {
  if (!x || typeof x !== "object") return false;
  const i = x as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  return (
    text(i.id, 300) &&
    text(i.source, 40) &&
    KINDS.has(i.kind as ResumeKind) &&
    text(i.title, 300) &&
    text(i.at, 40) &&
    text(i.ref, 1000) &&
    typeof i.auto === "boolean" &&
    (i.detail === undefined || text(i.detail, 300)) &&
    (i.link === undefined || (text(i.link, 300) && (i.link as string).startsWith("#/")))
  );
}

/**
 * Which kind a chat turn is, by the tool it was in when the close came.
 *
 * @param tool - The tool's name (none: the model was writing).
 * @returns `media` for picture, video, sound and 3D jobs, `render` for renders, exports and packaging, else `chat`.
 */
export function chatKindForTool(tool: string | undefined): ResumeKind {
  if (!tool) return "chat";
  if (/render|export_video|package|bake|build_game/i.test(tool)) return "render";
  if (/^(generate_|comfy|music|sound|speech_|voice_|image_|video_|pbr|upscale|make_3d|text_to_3d|lipsync)/i.test(tool)) return "media";
  return "chat";
}

/** Waits at most `ms` for a promise; a late or failed one gives `fallback`. */
async function within<T>(p: Promise<T> | T, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve(p).catch(() => fallback), new Promise<T>((ok) => { timer = setTimeout(() => ok(fallback), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The card's items, kept across a restart. */
export class ResumeBoard {
  private readonly sources = new Map<string, ResumeSource>();
  private saved: Saved = { items: [] };
  private started?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  /** @param file - The record file (in the data folder). */
  constructor(private readonly file: string) {}

  /**
   * Registers an area.
   *
   * @param name - The source's name (the first part of its items' ids).
   * @param source - What it can save, find, continue and drop.
   */
  add(name: string, source: ResumeSource): void {
    this.sources.set(name, source);
  }

  /**
   * Writes the record: what every source says is running now, beside the items still waiting from an earlier close.
   * Called on shutdown and before an update installs.
   *
   * @param reason - Why KesherAI closes.
   * @returns How many items the record holds.
   */
  async save(reason: ResumeReason): Promise<number> {
    await this.loadFile();
    const now: ResumeItem[] = [];
    for (const [name, src] of this.sources) {
      if (!src.snapshot) continue;
      const items = await within(src.snapshot(), SNAPSHOT_MS, [] as ResumeItem[]);
      now.push(...items.filter((i) => i.source === name && isResumeItem(i)));
    }
    const fresh = new Set(now.map((i) => i.id));
    this.saved = { reason, at: new Date().toISOString(), items: [...now, ...this.saved.items.filter((i) => !fresh.has(i.id))].slice(0, MAX_ITEMS) };
    await this.write();
    return this.saved.items.length;
  }

  /** After the start, once: reads the record and adds what each area's own store kept. */
  start(): Promise<void> {
    this.started ??= (async () => {
      await this.loadFile();
      const merged = new Map(this.saved.items.map((i) => [i.id, i]));
      for (const [name, src] of this.sources) {
        if (!src.found) continue;
        const mine = this.saved.items.filter((i) => i.source === name);
        const found = await within(src.found(mine), 10_000, [] as ResumeItem[]);
        for (const f of found) {
          if (f.source !== name || !isResumeItem(f)) continue;
          const before = merged.get(f.id);
          merged.set(f.id, before ? { ...f, detail: f.detail ?? before.detail, kind: before.kind !== "chat" && f.kind === "chat" ? before.kind : f.kind } : f);
        }
      }
      this.saved.items = [...merged.values()].slice(0, MAX_ITEMS);
      await this.write();
    })();
    return this.started;
  }

  /**
   * What the card shows: the waiting items (the ones their area says are gone leave the record).
   *
   * @returns The items, newest first, and why and when the last close came.
   */
  async list(): Promise<{ reason?: ResumeReason; at?: string; items: ResumeItem[] }> {
    await this.start();
    const keep: ResumeItem[] = [];
    for (const i of this.saved.items) {
      const src = this.sources.get(i.source);
      if (!src) continue;
      if (!src.alive || (await within(src.alive(i), 3000, true))) keep.push(i);
    }
    if (keep.length !== this.saved.items.length) {
      this.saved.items = keep;
      await this.write();
    }
    return { ...(this.saved.reason ? { reason: this.saved.reason } : {}), ...(this.saved.at ? { at: this.saved.at } : {}), items: [...keep].sort((a, b) => b.at.localeCompare(a.at)) };
  }

  /**
   * Continues or drops one item, then takes it off the card.
   *
   * @param id - The item.
   * @param action - Continue or drop.
   * @param ctx - Who asks.
   * @returns False when there is no such item.
   * @throws The source's reason when it cannot continue (the item stays on the card).
   */
  async act(id: string, action: "continue" | "drop", ctx: ResumeContext): Promise<boolean> {
    await this.start();
    const item = this.saved.items.find((i) => i.id === id);
    const src = item && this.sources.get(item.source);
    if (!item || !src) return false;
    if (action === "continue") await src.continue(item, ctx);
    else await src.drop(item);
    this.saved.items = this.saved.items.filter((i) => i.id !== id);
    await this.write();
    return true;
  }

  /**
   * Drops every item that waits for the user (the ones that continue by themselves are left going).
   *
   * @returns How many were dropped.
   */
  async dropWaiting(): Promise<number> {
    const { items } = await this.list();
    let n = 0;
    for (const i of items) if (!i.auto && (await this.act(i.id, "drop", { local: true }).catch(() => false))) n++;
    return n;
  }

  /** Reads the record file once (a missing or damaged file is an empty record). */
  private loaded = false;
  private async loadFile(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<Saved>;
      const reason = raw.reason === "shutdown" || raw.reason === "update" || raw.reason === "restart" ? raw.reason : undefined;
      this.saved = {
        ...(reason ? { reason } : {}),
        ...(typeof raw.at === "string" ? { at: raw.at } : {}),
        items: (Array.isArray(raw.items) ? raw.items : []).filter(isResumeItem).slice(0, MAX_ITEMS),
      };
    } catch {
      this.saved = { items: [] };
    }
  }

  /** Writes the record (whole file, one write at a time, through a temporary file). */
  private write(): Promise<void> {
    const text = JSON.stringify(this.saved);
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, text, "utf8");
      await replaceFile(tmp, this.file);
    }).catch(() => undefined);
    return this.writes;
  }
}
