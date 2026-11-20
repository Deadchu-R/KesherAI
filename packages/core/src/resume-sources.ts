import type { ResumeItem, ResumeSource } from "./resume-board.js";
import { chatKindForTool } from "./resume-board.js";

/**
 * The areas of the "Continue what was running" card (resume-board.ts), each built from the few things it needs, so
 * they can be tested without a whole server. The downloads area registers itself in routes/downloads.ts, where its
 * pending list lives.
 */

/** Now, for an item's time. */
const nowIso = () => new Date().toISOString();

/** What the chat area needs. */
export interface ChatResumeDeps {
  /** Chats working right now. */
  working: () => string[];
  /** The tool a working chat is in. */
  runningTool: (id: string) => string | undefined;
  /** Chats a close stopped (kept by the conversations themselves). */
  interrupted: () => Promise<Array<{ id: string; at: string }>>;
  /** Continues one (the agent checks what was done first), or only takes it off the list. */
  resume: (id: string, dismiss: boolean) => Promise<boolean>;
  title: (id: string) => string | undefined;
  /** A chat that another area brings back by itself (self-work's chat), so it is not offered twice. */
  skip?: () => string | undefined;
}

/**
 * Chat turns cut off in the middle (a tool, a picture or video job, a render): Continue tells the agent to check what
 * was already done and go on; Drop leaves the chat as it is.
 *
 * @param d - The conversations.
 * @returns The source.
 */
export function chatResumeSource(d: ChatResumeDeps): ResumeSource {
  const item = (id: string, at: string, tool?: string): ResumeItem => ({
    id: `chat:${id}`,
    source: "chat",
    kind: chatKindForTool(tool),
    title: (d.title(id) || id).slice(0, 200),
    ...(tool ? { detail: tool.slice(0, 100) } : {}),
    at,
    auto: false,
    link: `#/c/${id}`,
    ref: id,
  });
  return {
    snapshot: () => d.working().filter((id) => id !== d.skip?.()).map((id) => item(id, nowIso(), d.runningTool(id))),
    found: async () => (await d.interrupted()).filter((x) => x.id !== d.skip?.()).map((x) => item(x.id, x.at)),
    alive: async (i) => (await d.interrupted()).some((x) => x.id === i.ref),
    continue: async (i) => {
      if (!(await d.resume(i.ref, false))) throw new Error("This chat is no longer waiting to continue.");
    },
    drop: async (i) => {
      await d.resume(i.ref, true);
    },
  };
}

/** What the helper area needs. */
export interface HelperResumeDeps {
  /** The runs that went on by themselves after the start. */
  resumed: () => Array<{ id: string; chatId: string; title: string }>;
  /** A run's state now. */
  state: (id: string) => string | undefined;
  stop: (id: string) => boolean;
}

/**
 * Background helpers a close stopped: they already continue by themselves (2e9a75f, the user started them), so the
 * card shows them going, with Drop to stop one.
 *
 * @param d - The chat helpers.
 * @returns The source.
 */
export function helperResumeSource(d: HelperResumeDeps): ResumeSource {
  const going = (id: string) => ["waiting", "asking", "running"].includes(d.state(id) ?? "");
  return {
    found: () =>
      d.resumed().filter((r) => going(r.id)).map((r) => ({ id: `helper:${r.id}`, source: "helper", kind: "helper" as const, title: r.title.slice(0, 200), at: nowIso(), auto: true, link: `#/c/${r.chatId}`, ref: r.id })),
    alive: (i) => going(i.ref),
    continue: async () => undefined,
    drop: async (i) => {
      d.stop(i.ref);
    },
  };
}

/** What the task inbox area needs. */
export interface InboxResumeDeps {
  running: () => { id: string; title: string } | undefined;
  /** A task's status now (undefined: gone). */
  status: (id: string) => Promise<string | undefined>;
  /** Runs it on this computer (the user's Run). */
  runHere: (id: string) => Promise<unknown>;
  /** Asks the user on the phone "Run this task in Antigravity?" (the rule for a Run from afar). */
  ask: (id: string) => Promise<unknown>;
}

/**
 * The task inbox run a close cut off. The inbox's rules stay: Antigravity runs only on the user's Run, so Continue
 * on this computer is that Run, and Continue from the phone sends the usual "Run this task?" approval. Drop leaves
 * the task in the inbox as it is (failed, with the reason).
 *
 * @param d - The task inbox.
 * @returns The source.
 */
export function inboxResumeSource(d: InboxResumeDeps): ResumeSource {
  return {
    snapshot: () => {
      const t = d.running();
      return t ? [{ id: `inbox:${t.id}`, source: "inbox", kind: "inbox" as const, title: t.title.slice(0, 200), at: nowIso(), auto: false, link: "#/task-inbox", ref: t.id }] : [];
    },
    alive: async (i) => ["failed", "partial", "waiting", "deferred-quota"].includes((await d.status(i.ref).catch(() => undefined)) ?? ""),
    continue: async (i, ctx) => {
      await (ctx.local ? d.runHere(i.ref) : d.ask(i.ref));
    },
    drop: async () => undefined,
  };
}

/** What the self-work area needs. */
export interface SelfWorkResumeDeps {
  /** The run now (undefined: none). */
  current: () => { status: string; goal: string } | undefined;
  resume: () => Promise<unknown>;
  stop: () => Promise<unknown>;
}

/**
 * Self-work a close cut off. Within its time it goes on by itself after the start (the user started it), and the
 * card offers Drop (stop); past its time it waits for Continue (two more hours, the panel's default).
 *
 * @param d - Self-work.
 * @returns The source.
 */
export function selfWorkResumeSource(d: SelfWorkResumeDeps): ResumeSource {
  const going = () => ["running", "waiting"].includes(d.current()?.status ?? "");
  return {
    snapshot: () => {
      const r = d.current();
      return r && going() ? [{ id: "self-work:run", source: "self-work", kind: "self-work" as const, title: r.goal.split("\n")[0]!.slice(0, 200) || "Self-work", at: nowIso(), auto: false, link: "#/self-work", ref: "run" }] : [];
    },
    found: (saved) => saved.map((i) => ({ ...i, auto: going() })),
    alive: (i) => (i.auto ? going() : !!d.current() && !going()),
    continue: async (i) => {
      if (!i.auto) await d.resume();
    },
    drop: async (i) => {
      if (i.auto && going()) await d.stop();
    },
  };
}

/** What the engine sync area needs. */
export interface EngineSyncResumeDeps {
  /** Syncs running now: the engine and its project (Unreal: its name; Unity: its folder). */
  running: () => Promise<Array<{ engine: "unreal" | "unity"; project: string }>>;
  /** Changes still waiting for that project. */
  waiting: (engine: "unreal" | "unity", project: string) => Promise<number>;
  sync: (engine: "unreal" | "unity", project: string) => Promise<unknown>;
}

/**
 * Engine syncs a close cut off: the changes not yet applied stay queued (Game projects); Continue syncs again,
 * Drop only takes it off the card (the queued changes are never thrown away from here).
 *
 * @param d - The Unreal bridge and the Unity CLI.
 * @returns The source.
 */
export function engineSyncResumeSource(d: EngineSyncResumeDeps): ResumeSource {
  const split = (ref: string) => {
    const at = ref.indexOf(":");
    return { engine: ref.slice(0, at) as "unreal" | "unity", project: ref.slice(at + 1) };
  };
  return {
    snapshot: async () =>
      (await d.running()).map((r) => ({
        id: `engine-sync:${r.engine}:${r.project}`,
        source: "engine-sync",
        kind: "engine-sync" as const,
        title: (r.project.split(/[\\/]/).filter(Boolean).pop() || r.project).slice(0, 200),
        detail: r.engine === "unreal" ? "Unreal" : "Unity",
        at: nowIso(),
        auto: false,
        link: "#/games",
        ref: `${r.engine}:${r.project}`,
      })),
    alive: async (i) => {
      const { engine, project } = split(i.ref);
      return (await d.waiting(engine, project).catch(() => 0)) > 0;
    },
    continue: async (i) => {
      const { engine, project } = split(i.ref);
      void d.sync(engine, project).catch(() => undefined);
    },
    drop: async () => undefined,
  };
}
