/**
 * "Auto" in a chat (model-router.ts has the decisions): gathers the user's models with their strengths, asks the
 * classifier what a message needs, picks the model, shows the reason line, swaps the big local model when the pick
 * needs it, and keeps each chat's choice for the next turns of the same task.
 */
import { isMarkedGone } from "./model-gone.js";
import type { ModelInfo } from "@kesher/shared";
import type { ProviderRegistry } from "@kesher/providers";
import type { HelperEngine } from "./chat-helpers.js";
import { engineIdOf, loadSeconds, shortModelName } from "./helper-model.js";
import { SIDE_PROVIDER } from "./side-engine.js";
import type { AskJson } from "./tool-router.js";
import { decideModel, defaultStrengths, NeedClassifier, nextSticky, NOT_CHAT, type ModelPick, type NeedContext, type RouteCandidate, type StickyChoice, type Strength } from "./model-router.js";

/** What Auto needs from the app (wired in conversations.ts). */
export interface AutoModelDeps {
  registry(): ProviderRegistry;
  /** Settings › Models › Auto (config.autoRoute). */
  settings(): { strengths: Record<string, Strength[]>; cloudKinds: Strength[] };
  /** The built-in engine: what is loaded, the model files, loading one as the main model. */
  engine(): HelperEngine | undefined;
  /** The small model beside the main one as a JSON call, when one is loaded. */
  besideAsk?(): AskJson | undefined;
  /** The loaded main model as a JSON call, when one is loaded. */
  mainAsk?(): AskJson | undefined;
}

/** One message as Auto reads it. */
export interface AutoInput extends NeedContext {
  text: string;
  /** The chat's previous user message (its topic). */
  recent?: string;
  /** The chat's model now. */
  current: string;
  /** An incognito chat: never the cloud. */
  noCloud: boolean;
}

/** A model Auto may use, as Settings › Models › Auto lists it. */
export interface AutoModelRow {
  id: string;
  name: string;
  where: "local" | "server" | "cloud";
  strengths: Strength[];
  /** The user changed its strengths (else they come from its family). */
  custom: boolean;
  /** For a local file: its path (loaded on a swap). */
  path?: string;
  loaded: boolean;
  /** For a local file: about how long its load takes (seconds). */
  loadSec?: number;
}

/** Local files that are helpers, not chat models: routers, translators, embeddings, projectors. */
const NOT_A_CHAT_FILE = /mmproj|embed|rerank|translat|whisper|tts/i;
/** Files this small are routers or helpers (GiB): never swapped in as the chat's model. */
const MIN_CHAT_GIB = 2;

/**
 * The best other model for a gone one: most shared strengths, then a ready one, then the same provider.
 *
 * @param rows - The models Auto may pick (the gone one and marked ones already left out).
 * @param failed - The gone model's id.
 * @param wanted - Its strengths.
 * @returns The id, or undefined when there is no row.
 */
export function pickAlternative(rows: readonly AutoModelRow[], failed: string, wanted: readonly string[]): string | undefined {
  const provider = failed.split("/")[0];
  const score = (r: AutoModelRow) => r.strengths.filter((s) => wanted.includes(s)).length * 4 + (r.loaded ? 2 : 0) + (r.id.split("/")[0] === provider ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a))[0]?.id;
}

/** Auto for every chat of one conversation manager. */
export class AutoModel {
  private readonly classifier = new NeedClassifier();
  private readonly sticky = new Map<string, StickyChoice>();
  /** Load times measured on this computer, per file (seconds): better than the estimate next time. */
  private readonly measured = new Map<string, number>();
  private listing?: { at: number; models: ModelInfo[] };

  /** @param deps - See {@link AutoModelDeps}. */
  constructor(private readonly deps: AutoModelDeps) {}

  /**
   * The user's chat models Auto may pick, with their strengths: models the app lists now (the loaded local model, a
   * server's, the cloud's) and the local model files that a swap can load.
   *
   * @returns One row per model, local first.
   */
  async models(): Promise<AutoModelRow[]> {
    const { strengths } = this.deps.settings();
    if (!this.listing || Date.now() - this.listing.at > 60_000) {
      const l = await this.deps.registry().listAllModels(3000).catch(() => ({ models: [] as ModelInfo[] }));
      this.listing = { at: Date.now(), models: l.models };
    }
    const row = (id: string, name: string, where: AutoModelRow["where"], extra: Partial<AutoModelRow> = {}): AutoModelRow => {
      const own = strengths[id];
      return { id, name, where, strengths: own ?? defaultStrengths(id, name), custom: !!own, loaded: true, ...extra };
    };
    const rows: AutoModelRow[] = this.listing.models
      .filter((m) => (m.category ?? "chat") === "chat" && !isMarkedGone(m.id) && !m.id.startsWith("agent/") && !m.providerId.startsWith("device-") && m.providerId !== SIDE_PROVIDER && !NOT_CHAT.test(m.id) && !/embed/i.test(m.name))
      .map((m) => row(m.id, shortModelName(m.name || m.id), m.location === "cloud" ? "cloud" : m.location === "server" ? "server" : "local"));
    const loaded = this.deps.engine()?.loaded();
    const files = (await this.deps.engine()?.localModels().catch(() => [])) ?? [];
    for (const f of files) {
      if (NOT_A_CHAT_FILE.test(f.name) || f.sizeGiB < MIN_CHAT_GIB) continue;
      const id = engineIdOf(f.path);
      const isLoaded = !!loaded?.running && loaded.path === f.path;
      const have = rows.find((r) => r.id === id);
      if (have) Object.assign(have, { path: f.path, loaded: isLoaded || have.loaded });
      else rows.push(row(id, shortModelName(f.name), "local", { path: f.path, loaded: isLoaded, ...(isLoaded ? {} : { loadSec: this.measured.get(f.path) ?? loadSeconds(f.sizeGiB) }) }));
    }
    // A local id the registry still lists after its model was unloaded is not ready.
    for (const r of rows) if (r.path && !(loaded?.running && loaded.path === r.path)) Object.assign(r, { loaded: false, loadSec: this.measured.get(r.path) ?? r.loadSec ?? 20 });
    const order = { local: 0, server: 1, cloud: 2 };
    return rows.sort((a, b) => order[a.where] - order[b.where]);
  }

  /**
   * The model to retry on when a model is gone: the listed model that shares most of its strengths (a cloud one only
   * when allowed), a ready one first, never a model marked gone.
   *
   * @param failed - The gone model's id.
   * @param noCloud - Privacy: never a cloud model.
   * @returns Its id, or undefined when nothing else fits.
   */
  async alternativeTo(failed: string, noCloud: boolean): Promise<string | undefined> {
    this.listing = undefined;
    const rows = (await this.models()).filter((r) => r.id !== failed && !isMarkedGone(r.id) && r.loaded && (!noCloud || r.where !== "cloud"));
    return pickAlternative(rows, failed, this.deps.settings().strengths[failed] ?? defaultStrengths(failed));
  }

  /**
   * Picks the model for one message and updates the chat's kept choice.
   *
   * @param chatId - The chat.
   * @param m - The message, its context and the chat's model now.
   * @param signal - The user's Stop.
   * @returns The pick, and the row of the picked model (for its path on a swap).
   */
  async pick(chatId: string, m: AutoInput, signal?: AbortSignal): Promise<{ pick: ModelPick; row?: AutoModelRow }> {
    const rows = await this.models();
    // The tiny call goes to the small model beside the main one, else to the loaded main model (never a swap to route).
    const ask = this.deps.besideAsk?.() ?? this.deps.mainAsk?.();
    const need = await this.classifier.classify(m.text, m, ask, m.recent, signal);
    const candidates: RouteCandidate[] = rows.map((r) => ({ id: r.id, name: r.name, where: r.where, strengths: r.strengths, ready: r.loaded, ...(r.loadSec ? { loadSec: r.loadSec } : {}) }));
    const pick = decideModel({ ...need, candidates, current: m.current, noCloud: m.noCloud, cloudKinds: this.deps.settings().cloudKinds, ...(this.sticky.has(chatId) ? { sticky: this.sticky.get(chatId)! } : {}) });
    const kept = nextSticky(this.sticky.get(chatId), pick, need.strong);
    if (kept) this.sticky.set(chatId, kept);
    else this.sticky.delete(chatId);
    const row = rows.find((r) => r.id === pick.modelId);
    return { pick, ...(row ? { row } : {}) };
  }

  /**
   * Loads a local file as the main model for a pick that swaps (the earlier model is unloaded), measuring the time.
   *
   * @param path - The file.
   * @param chatTitle - The chat that needs it (named on the Models page's "loaded for" line).
   * @returns The model id the engine gave it.
   */
  async load(path: string, chatTitle: string): Promise<string> {
    const engine = this.deps.engine();
    if (!engine) throw new Error("No built-in engine.");
    const at = Date.now();
    const id = await engine.loadMain(path, { kind: "chat", chats: [chatTitle] });
    this.measured.set(path, Math.max(3, Math.round((Date.now() - at) / 1000)));
    this.listing = undefined;
    return id;
  }

  /** Forgets a chat's kept choice (the user picked a model, or the chat was deleted). */
  forget(chatId: string): void {
    this.sticky.delete(chatId);
  }
}
