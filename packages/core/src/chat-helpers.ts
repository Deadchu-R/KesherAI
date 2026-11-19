import type { AgentSession } from "@kesher/agent";
import type { HelperKind, HelperRunInfo } from "@kesher/shared";
import type { AgentDef } from "./agents.js";
import type { ConversationDeps } from "./conversation-deps.js";
import { reportFor, type HelperModel } from "./delegate.js";
import { engineIdOf, helperLimit, maySwap, pickHelperModel, shortModelName, type HelperModelPick, type LocalModel } from "./helper-model.js";
import { HelperRuns, type HelperControl } from "./helper-runs.js";
import type { LoadReason } from "./llamacpp.js";
import { outsideAgent } from "./acp-chat.js";

/**
 * The chat side of helpers (docs/RESEARCH_LOG.md, "Helper agents in the chat"): one queue for every chat, live
 * `helpers` events to the chat's page (the phone in remote gets them on the same stream), a background helper's
 * report handed to the chat's model at its next turn, each helper's model chosen for this computer and made ready
 * (loaded beside the chat's model, or a build's one swap and back), the once-per-project question before a cloud
 * helper reads the project, and the outside agent (Antigravity) as a helper that only the user starts.
 */

/** The built-in engine, as helpers need it (wired in server/build-conversations.ts). */
export interface HelperEngine {
  /** The main engine's loaded file. */
  loaded(): { running: boolean; path?: string };
  /** The largest graphics card's memory, GiB (0 = none). */
  vramGiB(): Promise<number>;
  /** Chat model files (GGUF) on this computer. */
  localModels(): Promise<LocalModel[]>;
  /** Loads a file as the main model (a build helper's swap and the way back). @returns Its model id. */
  loadMain(path: string, why: LoadReason): Promise<string>;
  /** Loads a file beside the main model (a small helper model). @returns Its model id. */
  loadBeside(path: string): Promise<string>;
  /** The file loaded beside the main model now, with its id. */
  beside(): { path?: string; modelId?: string };
}

/** A worker's copy of the project (a git worktree) and its diff. */
export type WorktreeMaker = { make(name: string): Promise<{ path: string; finish(): Promise<string> }> };

/** What the helpers need from the conversation manager. */
export interface ChatHelpersHost {
  deps: ConversationDeps;
  session(id: string): AgentSession | undefined;
  workspace(id: string): string | undefined;
  /** A git worktree maker, in a code chat on a git project. */
  worktree(id: string): WorktreeMaker | undefined;
  /** The chat's model now. */
  leadModel(id: string): string | undefined;
}

/** One lock: the work runs after the ones before it (swaps and loads beside, one at a time). */
function lock(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The chats' helpers. */
export class ChatHelpers {
  readonly runs: HelperRuns;
  private vram = 0;
  private vramAt = 0;
  private readonly swapLock = lock();
  private readonly besideLock = lock();

  /** @param host - The conversation manager's side. */
  constructor(private readonly host: ChatHelpersHost) {
    this.runs = new HelperRuns({ limit: () => helperLimit(this.vram, this.host.deps.config.helpers.atOnce) });
    this.runs.on("change", (chatId: string) => this.host.session(chatId)?.helpersChanged(this.runs.list(chatId)));
    // A background helper's report reaches the chat's model at its next turn, unless it already asked for it
    // (helper_wait resolves in the same tick, so the check waits one turn of the event loop).
    this.runs.on("end", (info: HelperRunInfo & { chatId: string }) => {
      setImmediate(() => {
        if (!this.runs.pending(info.id)) return;
        this.runs.delivered(info.id);
        this.host.session(info.chatId)?.deliver(`A background helper ended. Its report:\n${reportFor(this.runs.get(info.id) ?? info)}`);
      });
    });
    void this.cardMemory();
  }

  /** @returns The card's memory, read again every 10 minutes (the limit uses the last value). */
  async cardMemory(): Promise<number> {
    if (this.host.deps.helperEngine && Date.now() - this.vramAt > 10 * 60_000) {
      this.vramAt = Date.now();
      this.vram = await this.host.deps.helperEngine.vramGiB().catch(() => this.vram);
    }
    return this.vram;
  }

  /** Steps per type and the time cap, from Settings > Helpers. */
  limits(): { steps: { lookup: number; research: number; build: number }; minutes: number } {
    const h = this.host.deps.config.helpers;
    return { steps: { ...h.steps }, minutes: h.minutes };
  }

  /**
   * Whether a cloud helper may read this chat's project, asked once per project folder.
   *
   * @param id - The chat.
   */
  cloudFiles(id: string): { get(): boolean | undefined; set(yes: boolean): void } {
    const cfg = this.host.deps.config.helpers;
    return {
      get: () => {
        const ws = this.host.workspace(id);
        return ws ? cfg.cloudProjects[ws] : undefined;
      },
      set: (yes) => {
        const ws = this.host.workspace(id);
        if (!ws) return;
        cfg.cloudProjects[ws] = yes;
        void Promise.resolve(this.host.deps.saveConfig?.()).catch(() => undefined);
      },
    };
  }

  /**
   * What `pickHelperModel` sees on this computer for a chat's model.
   *
   * @param lead - The chat's model id.
   */
  private async inputs(lead: string): Promise<{ vramGiB: number; lead: { modelId: string; path?: string; sizeGiB?: number }; local: LocalModel[]; cloud: (id: string) => boolean }> {
    const eng = this.host.deps.helperEngine;
    const vramGiB = await this.cardMemory();
    const local = eng ? await eng.localModels().catch(() => []) : [];
    const st = eng?.loaded();
    // The engine serves one file; the chat's model is that file when it is an engine model.
    const path = st?.running && st.path && lead.startsWith("llamacpp/") ? st.path : undefined;
    const size = path ? local.find((m) => m.path === path)?.sizeGiB : undefined;
    const cloud = (id: string) => {
      try {
        return this.host.deps.registry.resolve(id).provider.location === "cloud";
      } catch {
        return false;
      }
    };
    return { vramGiB, lead: { modelId: lead, ...(path ? { path } : {}), ...(size ? { sizeGiB: size } : {}) }, local, cloud };
  }

  /**
   * The choice for each built-in type on this computer, for Settings > Helpers ("Auto → Qwen3-4B, fits beside…").
   *
   * @param lead - The chat model to plan for (default: the active chat model).
   */
  async explain(lead = this.host.deps.config.activeModels.chat ?? ""): Promise<{ vramGiB: number; lead: string; atOnce: number; picks: Record<"lookup" | "research" | "build", HelperModelPick> }> {
    const i = await this.inputs(lead);
    const models = this.host.deps.config.helpers.models;
    const pick = (kind: "lookup" | "research" | "build") => pickHelperModel({ kind, choice: models[kind], vramGiB: i.vramGiB, lead: i.lead, local: i.local, cloud: i.cloud(models[kind]) ? [models[kind]] : [] });
    return { vramGiB: i.vramGiB, lead, atOnce: helperLimit(i.vramGiB, this.host.deps.config.helpers.atOnce), picks: { lookup: pick("lookup"), research: pick("research"), build: pick("build") } };
  }

  /**
   * Chooses and readies a helper's model (the delegate tool's `modelFor`).
   *
   * @param id - The chat.
   * @param kind - The helper's type.
   * @param agent - A named helper, with its own tier.
   */
  async modelFor(id: string, kind: HelperKind, agent?: AgentDef): Promise<HelperModel> {
    const lead = this.host.leadModel(id) ?? "";
    const i = await this.inputs(lead);
    const settings = this.host.deps.config.helpers.models;
    const choice = agent && agent.source !== "builtin" ? (agent.tier ?? "inherit") : kind === "external" ? "inherit" : settings[kind];
    const pick = pickHelperModel({ kind, choice, vramGiB: i.vramGiB, lead: i.lead, local: i.local, cloud: i.cloud(choice) ? [choice] : [] });
    const note = pick.why.en;
    const noteHe = pick.why.he;
    if (pick.how === "inherit") return { modelId: pick.modelId, label: shortModelName(pick.modelId), note, noteHe, local: !i.cloud(pick.modelId), cloud: i.cloud(pick.modelId) };
    if (pick.how === "id") return { modelId: pick.modelId, label: shortModelName(pick.modelId), note, noteHe, cloud: pick.cloud, local: !pick.cloud };
    const eng = this.host.deps.helperEngine!;
    if (pick.how === "beside") {
      return {
        modelId: SIDE_PENDING,
        label: pick.name,
        note,
        noteHe,
        local: true,
        prepare: () =>
          this.besideLock(async () => {
            const b = eng.beside();
            return b.path === pick.path && b.modelId ? b.modelId : eng.loadBeside(pick.path);
          }),
      };
    }
    // A build's one swap: the chat's model leaves the card for the helper's, and comes back when it ends.
    if (!maySwap(kind)) throw new Error("Only a build helper may swap the model.");
    const from = i.lead.path!;
    let release: (() => void) | undefined;
    return {
      modelId: engineIdOf(pick.path),
      label: pick.name,
      note,
      noteHe,
      local: true,
      prepare: async (ctl: HelperControl, title: string) => {
        await new Promise<void>((held) => void this.swapLock(() => new Promise<void>((free) => { release = free; held(); })));
        ctl.update({ swap: { from: shortModelName(from), to: pick.name, phase: "loading", sizeGiB: Math.round(pick.sizeGiB * 10) / 10 } });
        try {
          const modelId = await eng.loadMain(pick.path, { kind: "helper", helper: title, helperKind: kind });
          ctl.update({ swap: { from: shortModelName(from), to: pick.name, phase: "running", sizeGiB: Math.round(pick.sizeGiB * 10) / 10 } });
          return modelId;
        } catch (err) {
          release?.();
          release = undefined;
          throw err;
        }
      },
      release: async (ctl: HelperControl, title: string) => {
        if (!release) return;
        const started = Date.now();
        ctl.update({ swap: { from: shortModelName(from), to: pick.name, phase: "back", sizeGiB: Math.round(pick.sizeGiB * 10) / 10 } });
        try {
          await eng.loadMain(from, { kind: "helper", back: true, helper: title, helperKind: kind });
          ctl.update({ swap: { from: shortModelName(from), to: pick.name, phase: "done", backMs: Date.now() - started, sizeGiB: Math.round(pick.sizeGiB * 10) / 10 } });
        } finally {
          release?.();
          release = undefined;
        }
      },
    };
  }

  /**
   * Asks "Run this in Antigravity?" before each message to it (wired to the task inbox, server.ts): the same ask on
   * the PC, the phone and the hub, one ask per message, counted against the same daily limit. Unset: nothing is sent.
   */
  askAntigravity?: (info: { title: string; text: string; where: string }) => { ask: { requestId: string; until: number; left: number }; answer: Promise<"allow" | "deny" | "timeout">; cancel: () => void };

  /**
   * Starts the outside agent (Antigravity) as a helper, in its own copy of the project, after the user's Run on its ask. Only the user starts it
   * (the composer's `@antigravity`); the chat's model never does, so nothing runs on the user's Google account by itself.
   *
   * @param id - The chat (a code chat on a git project).
   * @param task - What it should do.
   * @param start - Starts the agent (tests pass an in-process one).
   * @returns Its run.
   */
  startExternal(id: string, task: string, start?: Parameters<typeof outsideAgent>[2]): HelperRunInfo {
    const wt = this.host.worktree(id);
    if (!wt) throw new Error("An outside agent works only in a code chat on a git project (it gets its own copy). (בעברית: סוכן חיצוני עובד רק בצ׳אט קוד על פרויקט git, והוא מקבל עותק משלו.)");
    const text = task.trim();
    if (!text) throw new Error("Give it a task.");
    const minutes = this.host.deps.config.helpers.minutes;
    return this.runs.start({
      chatId: id,
      kind: "external",
      title: text.split("\n")[0]!.slice(0, 120),
      background: true,
      maxSteps: 60,
      timeMs: Math.max(minutes, 20) * 60_000,
      local: false,
      model: "Antigravity CLI",
      run: async (ctl) => {
        // Google's terms for a personal plan: every message to Antigravity is the user's own tap, so each one asks.
        if (!this.askAntigravity) throw new Error("Antigravity asks before each message, and the ask is not available here. (בעברית: Antigravity שואל לפני כל הודעה, והשאלה לא זמינה כאן.)");
        const where = (this.host.workspace(id) ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "project";
        const asked = this.askAntigravity({ title: `@antigravity: ${text.split("\n")[0]!.slice(0, 100)}`, text, where });
        ctl.update({ runAsk: { ...asked.ask, text: text.slice(0, 600) } });
        let said: "allow" | "deny" | "timeout";
        try {
          said = await ctl.hold(asked.answer, "Waits for Run in Antigravity");
        } catch (e) {
          asked.cancel();
          throw e;
        } finally {
          ctl.update({ runAsk: undefined });
        }
        if (said !== "allow") throw new Error(said === "timeout" ? "Not run: the ask expired after 30 minutes. (לא רץ: השאלה פגה אחרי 30 דקות.)" : "Not run: you chose Not now. (לא רץ: בחרת לא עכשיו.)");
        const copy = await wt.make(`helper-antigravity-${Date.now().toString(36)}`);
        let finished = false;
        const agent = outsideAgent("agent/antigravity", copy.path, start, () => "auto-edit");
        let answer = "";
        try {
          await agent!.turn(text, {
            text: (d) => void (answer += d),
            tool: (st) => {
              if (st.ok !== undefined) ctl.step(st.name);
            },
            plan: () => undefined,
            // No one is there to answer: in its own copy edits need no question (accept-edits), and commands are refused.
            approve: async () => "deny",
          }, ctl.signal);
          const diff = await copy.finish();
          finished = true;
          return { report: answer.trim() || "(no answer)", diff };
        } finally {
          agent?.close();
          if (!finished) await copy.finish().catch(() => "");
        }
      },
    });
  }
}

/** A placeholder id until a model beside the main one is loaded (`prepare` returns the real one). */
const SIDE_PENDING = "llamacpp-beside/pending";
