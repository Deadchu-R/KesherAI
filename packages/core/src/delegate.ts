import { randomUUID } from "node:crypto";
import { AgentSession, type AgentTool, type ModelTurn } from "@kesher/agent";
import type { AgentMessage, HelperKind, HelperRunInfo } from "@kesher/shared";
import { builtinHelpers, HELPER_STEPS, type AgentDef } from "./agents.js";
import { HelperRuns, NOTE_CHARS, type HelperControl, type HelperJob, type NoteFrom, type SavedHelperRun } from "./helper-runs.js";

/**
 * Helpers: the chat's model hands independent parts of a job to other
 * models at the same time, each with read-only tools, and gets their
 * findings back.
 *
 * How others do it (researched first): Claude Code's subagents (an
 * "Explore" agent that only reads, on a cheaper model, several at once,
 * returning a summary so the main context stays small); Cursor 3's async
 * subagents for /multitask (a task split into chunks run in parallel);
 * local-model routing guides (LiteLLM's complexity router, Ollama with two
 * models loaded): small models for extraction and searching, the big one
 * for judgment. KesherAI: the lead model keeps deciding and writing; the
 * helpers only look (files, search, web, knowledge) and report, so nothing
 * they do needs the user's approval, and a smaller or other computer's
 * model can do the legwork while the big one keeps its context for the
 * real work. Splitting text across computers stays split_across_computers.
 *
 * Helper types (docs/RESEARCH_LOG.md, "Helper agents in the chat"): `lookup`, `research` and `build`, each with its
 * model (helper-model.ts), steps and time cap; a part may run in the background (the lead goes on and gets the report
 * at its next turn, or asks with helper_result / helper_wait); the runs queue under a limit (helper-runs.ts) and show
 * in the chat's helpers strip. A helper never starts helpers.
 */

/** Tools a helper never gets: anything that changes, controls the screen, or starts more helpers. */
const NEVER =
  /^(computer_|browser_|delegate$|helper_|split_across_computers$|ask_member$|remember$|learn_skill|generate_|make_|drive_|android_|unreal_(write|compile|python|package|create|open)|unity_(write|script|build|create|play))/;

/** The tools a cloud helper keeps when it may not read the project (the question only, and the web). */
const WEB_ONLY = /^(web_search|web_fetch)$/;

/** A helper's model, chosen and made ready by the conversation (helper-model.ts on this computer). */
export interface HelperModel {
  /** The model id it runs on (after `prepare`, the id `prepare` returns). */
  modelId: string;
  /** Its short name, for the card. */
  label: string;
  /** Why this model, for the card (English, and Hebrew). */
  note?: string;
  noteHe?: string;
  cloud?: boolean;
  /** It uses this computer's graphics card (counts against the helpers' limit). */
  local: boolean;
  /** Loads it (beside the chat's model, or a build's one swap) before the first step. @returns The id to run on. */
  prepare?: (ctl: HelperControl, title: string) => Promise<string>;
  /** After the run: the chat's model back after a swap. */
  release?: (ctl: HelperControl, title: string) => Promise<void>;
}

/** What the delegate tool needs from the conversation. */
export interface DelegateOptions {
  /** The chat's tools now (only its read-only ones are given to helpers). */
  tools: () => AgentTool[];
  /** The chat's model, used when a part names none. */
  currentModel: () => string | undefined;
  /** A model's turn function; throws for an unknown model. */
  turnFor: (modelId: string) => ModelTurn;
  /** The models a part may name (for the tool's description). */
  models: () => string[];
  workspace?: () => string | undefined;
  contextTokens?: (modelId: string) => number;
  /** Named agents a part may name (personas with "when to use", a project's agent files). */
  agents?: () => AgentDef[];
  /**
   * A worker agent's own copy of the project (a git worktree), when this chat has a git project. `finish` returns
   * its changes as a diff and removes the copy.
   */
  worktree?: () => { make(name: string): Promise<{ path: string; finish(): Promise<string> }> } | undefined;
  /** The helper runs (queue, limit, stop, the strip); without them a private queue is used (tests). */
  runs?: HelperRuns;
  /** This chat's id, for the runs. */
  chatId?: string;
  /** The model for a part with no model of its own (Settings > Helpers); absent = the chat's model. */
  modelFor?: (p: { kind: HelperKind; agent?: AgentDef }) => Promise<HelperModel> | HelperModel;
  /** Steps per type and the time cap (Settings > Helpers). */
  limits?: () => { steps?: Partial<Record<"lookup" | "research" | "build", number>>; minutes?: number };
  /**
   * Whether a cloud helper may read this project's files: true / false once the user answered for this project,
   * undefined before (the helper asks once, on its card).
   */
  cloudFiles?: { get(): boolean | undefined; set(yes: boolean): void };
}

/** File tools a worker gets besides the read-only ones (only inside its own copy of the project). */
const WORKER_TOOLS = /^(write_file|edit_file)$/;

/** The read-only tools a helper may use. */
export function helperTools(tools: AgentTool[]): AgentTool[] {
  return tools.filter(
    (t) => (t.risk === "read" || t.risk === "safe") && !NEVER.test(t.spec.name),
  );
}

/** One helper's run, as runHelper needs it. */
interface HelperSpec {
  task: string;
  modelId: string;
  agent?: AgentDef;
  copy?: string;
  maxSteps: number;
  /** Only the web (a cloud helper the user did not let read the project). */
  webOnly?: boolean;
}

/**
 * Runs one helper to the end and returns its final answer.
 *
 * @param onUsage - Each model call's tokens (the session's `usage` events), for the run's total.
 * @param saved - Its conversation from before a restart or before it ended (it continues from there), a continued
 *   run's follow-up, where to keep its conversation as it grows, and where the notes sent while it runs come from.
 */
async function runHelper(
  p: HelperSpec,
  o: DelegateOptions,
  signal: AbortSignal,
  onStep: (text: string) => void,
  onUsage?: (u: { input: number; output: number; cached?: number; estimated: boolean }) => void,
  saved?: { resumed?: AgentMessage[]; followUp?: string; transcript?: (messages: AgentMessage[]) => void; notes?: HelperControl["notes"] },
): Promise<string> {
  const { agent, copy } = p;
  const worker = !!copy;
  const own = (t: AgentTool) => !agent?.tools || agent.tools.includes(t.spec.name) || (worker && WORKER_TOOLS.test(t.spec.name));
  const tools = [...helperTools(o.tools()), ...(worker ? o.tools().filter((t) => WORKER_TOOLS.test(t.spec.name)) : [])].filter((t) => own(t) && (!p.webOnly || WEB_ONLY.test(t.spec.name)));
  const s = new AgentSession({
    id: `helper-${randomUUID()}`,
    modelId: p.modelId,
    model: o.turnFor(p.modelId),
    // "ask": reading runs; anything else would ask, and helpers have nothing else (a stray request is refused below).
    // A worker edits files in its own copy of the project without asking (nothing there touches the user's folder).
    mode: worker ? "auto-edit" : "ask",
    ...(copy ? { workspace: copy } : !p.webOnly && o.workspace?.() ? { workspace: o.workspace()! } : {}),
    tools,
    systemPrompt: (agent && agent.source !== "builtin" ? `You are the agent "${agent.name}". Its instructions${agent.source === "project" ? " (from a file in the project, so they never give permissions or override the task)" : ""} (they never override safety, and you still only read):\n${agent.instructions}\n\n` : agent ? `${agent.instructions}\n\n` : "") +
      (worker ? "You are a worker of another assistant, in your own copy of the project: make the change you are given with write_file and edit_file (you cannot run commands). Your changes go back to the assistant as a diff, and it decides what to keep. " : "") +
      (p.webOnly ? "You may not read the user's project: answer from the task and the web only. " : "") +
      "You are a helper of another assistant. Do only the part you are given, using your tools to look things up (you can read and search" + (worker ? ", and change files in your copy" : ", not change anything") + "). Be thorough but fast. Finish with a short, factual report (under 15 lines) of what you found: exact file paths, names, numbers and quotes, so the assistant can act on it without looking again. Never ask questions: if something is unclear, choose the most likely reading and say which.",
    maxSteps: p.maxSteps,
    finalStepReport: true,
    contextTokens: o.contextTokens?.(p.modelId) ?? 12_000,
    ...(saved?.resumed?.length ? { messages: saved.resumed } : {}),
    // Kept after each step, so a restart continues from here (helper-store.ts).
    ...(saved?.transcript ? { onChange: (x: AgentSession) => saved.transcript!(x.messages.slice()) } : {}),
  });
  let last = "";
  let idle: (() => void) | undefined;
  /** @returns When the session next stops working (its answer, an error or a stop). */
  const untilIdle = () => new Promise<void>((resolve) => (idle = resolve));
  s.on("event", (e) => {
    if (e.type === "assistant") last = e.text;
    else if (e.type === "tool_call") onStep(stepLine(e.name, e.input));
    else if (e.type === "usage") onUsage?.({ input: e.input, output: e.output, ...(e.cached !== undefined ? { cached: e.cached } : {}), estimated: e.estimated });
    else if (e.type === "question")
      s.answer(
        e.questionId,
        "(No one can answer: decide yourself and say what you chose.)",
      );
    else if (e.type === "approval_request")
      s.approve(e.requestId, "deny", "Helpers only read.");
    else if (
      e.type === "status" &&
      (e.status === "idle" || e.status === "error")
    )
      idle?.();
  });
  // Notes the user or the lead send while it works go into its next model turn (after the tool it runs now).
  const sent: string[] = [];
  saved?.notes?.((note) => {
    sent.push(note);
    s.deliver(note);
  });
  const unread = () => sent.filter((n) => !s.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(n)));
  const stop = () => s.stop();
  if (signal.aborted) throw new Error("Stopped.");
  signal.addEventListener("abort", stop, { once: true });
  try {
    let done = untilIdle();
    s.send(saved?.followUp ?? (saved?.resumed?.length ? RESUME_NOTE : p.task));
    await done;
    // A note that came while it wrote its last answer was not read yet: one more round with it (at most twice).
    for (let round = 0; round < 2 && !signal.aborted && unread().length; round++) {
      done = untilIdle();
      s.send(LATE_NOTE);
      await done;
    }
    // Its whole conversation, with the last answer, kept for a follow-up ("Continue with…").
    saved?.transcript?.(s.messages.slice());
  } finally {
    saved?.notes?.(undefined);
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw new Error("Stopped.");
  return last.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

/** What a helper reads when it continues after a restart (like the chat's own "resume" in conversations.ts). */
export const RESUME_NOTE =
  "KesherAI restarted (an update or a restart) while you were working on this. Continue the same task from where you stopped. First look at the last tool results above to see what was already done, and do not repeat finished steps.";

/** What a helper reads when a note came while it wrote its report (the note itself follows in the same turn). */
export const LATE_NOTE = "A note reached you while you wrote your report. Read it below, do what it asks, and write your report again.";

/** What a helper run needs to be built again after a restart or for a follow-up (saved with it, JSON only). */
type HelperResume = {
  task: string;
  kind: Exclude<HelperKind, "external">;
  /** A named agent (a built-in type's, a persona, a project's agent file). */
  agent?: string;
  /** A model the part asked for (otherwise the type's model is chosen again). */
  model?: string;
  maxSteps: number;
  write: boolean;
};

/**
 * A helper run's work: the once-per-project cloud ask, its model made ready, its own copy for a builder, the helper
 * itself, and the model released after.
 *
 * @param o - The conversation's side.
 * @param job - The part: its task and title, type, agent, model, steps, and whether it changes files.
 * @param progress - Each step, for the `delegate` call's live output (absent after a restart).
 * @returns The run's work, for `HelperRuns`.
 */
function helperWork(
  o: DelegateOptions,
  job: { task: string; title: string; kind: Exclude<HelperKind, "external">; agent?: AgentDef; model: HelperModel | (() => Promise<HelperModel>); maxSteps: number; write: boolean },
  progress?: (text: string) => void,
): HelperJob["run"] {
  const { task, title, kind, agent, maxSteps, write } = job;
  return async (ctl) => {
    // After a restart the model is chosen again (what was loaded is gone), and the card shows it.
    const m = typeof job.model === "function" ? await job.model() : job.model;
    if (typeof job.model === "function") ctl.update({ model: m.label, modelNote: m.note, modelNoteHe: m.noteHe, cloud: m.cloud || undefined });
    // A cloud helper asks once per project before it reads the project's files.
    let webOnly = false;
    if (m.cloud && o.workspace?.()) {
      let yes = o.cloudFiles?.get();
      if (yes === undefined) {
        yes = await ctl.ask("cloud-files");
        o.cloudFiles?.set(yes);
      }
      webOnly = !yes;
      ctl.update({ cloudFiles: yes });
      if (webOnly && write) throw new Error("A cloud helper may not read this project's files, so it cannot build here (Settings > Helpers).");
    }
    let copy: { path: string; finish(): Promise<string> } | undefined;
    let modelId = m.modelId;
    try {
      if (m.prepare) modelId = await m.prepare(ctl, title);
      ctl.signal.throwIfAborted();
      if (write) copy = await o.worktree!()!.make(`helper-${(agent?.name ?? kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30) || "worker"}-${randomUUID().slice(0, 6)}`);
      // A builder's copy is new after a restart or a follow-up: its earlier edits are in its conversation, not in the new
      // copy (after a follow-up the assistant already has the earlier diff, but the new diff must hold the whole change).
      const fresh = ctl.followUp
        ? "(You are in a fresh copy of the project: your earlier file changes are not in it. Make them again together with what the follow-up asks, so your new diff holds the whole change.)"
        : "(Your earlier file changes were lost with the restart: you are in a fresh copy of the project, so make them again.)";
      const resumed = ctl.resumed && write ? [...ctl.resumed, { role: "user" as const, content: fresh }] : ctl.resumed;
      const report = await runHelper({ task, modelId, ...(agent ? { agent } : {}), ...(copy ? { copy: copy.path } : {}), maxSteps, webOnly }, o, ctl.signal, (step) => {
        ctl.step(step);
        progress?.(`${agent && agent.source !== "builtin" ? agent.name : kind} (${m.label}): ${step}\n`);
      }, (u) => ctl.usage(u), { ...(resumed ? { resumed } : {}), ...(ctl.followUp ? { followUp: ctl.followUp } : {}), transcript: (msgs) => ctl.transcript(msgs), notes: (sink) => ctl.notes(sink) });
      const diff = copy ? await copy.finish().catch((e: Error) => `(could not read its changes: ${e.message})`) : undefined;
      copy = undefined;
      return { report, ...(diff !== undefined ? { diff } : {}) };
    } finally {
      await copy?.finish().catch(() => "");
      await m.release?.(ctl, title).catch(() => undefined);
    }
  };
}

/**
 * Builds a helper run's work again from what was saved with it (after a restart, or for a follow-up): the same task,
 * type, named agent and model choice.
 *
 * @param o - The chat's side.
 * @param saved - The run as it was saved.
 * @returns Its work, or undefined when it cannot be built again (an outside agent, a builder without a git project).
 */
function workFromSaved(o: DelegateOptions, saved: SavedHelperRun): HelperJob["run"] | undefined {
  const r = saved.resume as Partial<HelperResume> | undefined;
  if (!r || typeof r.task !== "string" || !r.kind || !["lookup", "research", "build"].includes(r.kind)) return undefined;
  const write = !!r.write;
  if (write && !o.worktree?.()) return undefined;
  const agent = r.agent ? [...(o.agents?.() ?? []), ...builtinHelpers(o.limits?.().steps)].find((a) => a.name === r.agent) : undefined;
  const kind = r.kind;
  const asked = r.model;
  const model = async (): Promise<HelperModel> => {
    if (asked) {
      try {
        o.turnFor(asked);
        return { modelId: asked, label: asked.split("/").pop() ?? asked, local: saved.local };
      } catch {
        // Gone since (a cloud key removed, a model deleted): the type's model below.
      }
    }
    if (o.modelFor) return o.modelFor({ kind, ...(agent ? { agent } : {}) });
    const fallback = o.currentModel();
    if (!fallback) throw new Error("No model to run it.");
    return { modelId: fallback, label: fallback.split("/").pop() ?? fallback, local: false };
  };
  return helperWork(o, { task: r.task, title: saved.info.title, kind, ...(agent ? { agent } : {}), model, maxSteps: r.maxSteps ?? saved.info.maxSteps, write });
}

/**
 * Continues a helper run that a restart paused (helper-store.ts): its work is built again from what was saved with it,
 * and it goes on from its saved conversation.
 *
 * @param o - The chat's side (with its runs).
 * @param saved - The run as it was saved.
 * @returns Whether it was queued again (false when it was not paused or cannot be built again).
 */
export function resumeHelperRun(o: DelegateOptions, saved: SavedHelperRun): boolean {
  const work = o.runs ? workFromSaved(o, saved) : undefined;
  return !!work && o.runs!.resume(saved.info.id, work);
}

/**
 * Continues an ended helper with a follow-up ("Continue with…" on its card, or the lead's helper_continue): it goes on
 * from its kept conversation, on the same model and role, in the background.
 *
 * @param o - The chat's side (with its runs).
 * @param id - The run.
 * @param text - The follow-up.
 * @param from - Who sends it.
 * @returns Its info, now waiting or running.
 * @throws Error when it is still going, ended too long ago (its conversation is no longer kept) or cannot continue.
 */
export function continueHelperRun(o: DelegateOptions, id: string, text: string, from: NoteFrom): HelperRunInfo {
  const runs = o.runs;
  const r = runs?.get(id);
  if (!runs || !r || (o.chatId && r.chatId !== o.chatId)) throw new Error(`No sub-agent ${id} in this chat.`);
  if (!text.trim()) throw new Error("Write what it should do next.");
  if (r.state === "waiting" || r.state === "running" || r.state === "asking") throw new Error(`${id} is still working: send it a note instead (helper_message).`);
  if (!r.canContinue) throw new Error(`${id} cannot be continued (an outside agent, or its conversation is no longer kept: only the newest ended sub-agents keep it). Start a new one with delegate.`);
  const info = runs.continueRun(id, text, from, (saved) => workFromSaved(o, saved));
  if (!info) throw new Error(`${id} cannot be continued here (a build agent needs this chat's git project).`);
  return info;
}

/** A step for the card: the tool and what it got (a path, a query, a page). */
function stepLine(name: string, input: Record<string, unknown>): string {
  const what = [input.path, input.query, input.pattern, input.url].find((v) => typeof v === "string" && v.trim());
  return what ? `${name}: ${String(what).slice(0, 100)}` : name;
}

/** The type of a part: its agent's, or what the part says, or research (the chat's model, read only). */
function kindOf(part: Record<string, unknown>, agent: AgentDef | undefined): Exclude<HelperKind, "external"> {
  if (agent?.kind && agent.kind !== "external") return agent.kind;
  if (agent) return agent.write ? "build" : "lookup";
  const t = String(part.type ?? "").toLowerCase();
  return t === "lookup" || t === "build" ? t : "research";
}

/** A run's report as the chat's model reads it. */
export function reportFor(r: HelperRunInfo, n?: number): string {
  const who = `${n !== undefined ? `Part ${n} — ` : ""}${r.agent && !["lookup", "research", "build"].includes(r.agent) ? `agent ${r.agent}` : r.kind} — ${r.model}${r.modelNote?.startsWith("asked for") ? ` (${r.modelNote})` : ""} (id ${r.id})`;
  if (r.state === "done") {
    const diff = r.diff !== undefined ? `\n\nIts changes, made in its own copy (nothing is in the user's folder yet; make the ones you want with your own edit tools, which the user approves):\n\`\`\`diff\n${r.diff || "(no changes)"}\n\`\`\`` : "";
    return `## ${who}\n${r.report || "(no answer)"}${r.cut ? "\n(cut: the user can open the whole report on its card)" : ""}${diff}`;
  }
  if (r.state === "stopped") return `## ${who}\nStopped by the user after ${r.step} steps.${r.report ? `\n${r.report}` : ""}`;
  if (r.state === "failed") return `## ${who}\nFailed: ${r.error ?? "unknown"}`;
  return `## ${who}\nStill ${r.state === "waiting" ? "waiting in the queue" : r.state === "asking" ? "waiting for the user's answer" : `running (step ${r.step} of ${r.maxSteps})`}.`;
}

/**
 * The `delegate` tool, and with the runs store, `helper_result`, `helper_wait` and `helper_stop` for background parts.
 *
 * @param o - What the tools need from the conversation.
 * @returns The tools: `delegate` first.
 */
export function helperToolsFor(o: DelegateOptions): AgentTool[] {
  const d = delegateTool(o);
  if (!o.runs || !o.chatId) return [d];
  const runs = o.runs;
  const chatId = o.chatId;
  const mine = (id: unknown) => {
    const r = typeof id === "string" ? runs.get(id.trim()) : undefined;
    if (!r || r.chatId !== chatId) throw new Error(`No helper ${String(id)} in this chat. Its id is in delegate's answer.`);
    return r;
  };
  const ids = { type: "array", items: { type: "string" }, description: "Helper ids from delegate's answer." };
  return [
    d,
    {
      risk: "safe",
      spec: { name: "helper_result", description: "A background helper's state, and its report when it has ended (then it is not handed to you again).", inputSchema: { type: "object", properties: { id: { type: "string", description: "The helper's id." } }, required: ["id"] } },
      run: async (input) => {
        const r = mine(input.id);
        if (r.state === "done" || r.state === "failed" || r.state === "stopped") runs.delivered(r.id);
        return { output: reportFor(r) };
      },
    },
    {
      risk: "safe",
      spec: { name: "helper_wait", description: "Waits until these background helpers end and returns their reports. Use it when you cannot go on without them.", inputSchema: { type: "object", properties: { ids }, required: ["ids"] } },
      run: async (input, ctx) => {
        const list = (Array.isArray(input.ids) ? input.ids : []).slice(0, 8).map((id) => mine(id).id);
        if (!list.length) throw new Error("Give the helpers' ids.");
        const done = await runs.wait(list, ctx.signal);
        return { output: done.map((r) => reportFor(r)).join("\n\n") };
      },
    },
    {
      risk: "safe",
      spec: { name: "helper_stop", description: "Stops a helper that is no longer needed (a waiting one leaves the queue).", inputSchema: { type: "object", properties: { id: { type: "string", description: "The helper's id." } }, required: ["id"] } },
      run: async (input) => {
        const r = mine(input.id);
        return { output: runs.stop(r.id) ? `Stopped ${r.id}.` : `${r.id} had already ended (${r.state}).` };
      },
    },
    {
      risk: "safe",
      spec: {
        name: "helper_message",
        description: "Sends a running helper a note to change or add to its task (it reads it at its next step, after the tool it runs now). Use it to redirect a helper instead of stopping it and starting again.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "The helper's id." }, text: { type: "string", description: `The note, everything it needs (up to ${NOTE_CHARS} characters).` } }, required: ["id", "text"] },
      },
      run: async (input) => {
        const r = mine(input.id);
        const text = typeof input.text === "string" ? input.text : "";
        if (!text.trim()) throw new Error("Write the note.");
        if (runs.message(r.id, text, "lead")) return { output: `Sent to ${r.id}: it reads it at its next step.` };
        throw new Error(r.state === "waiting" || r.state === "running" || r.state === "asking" ? `${r.id} cannot take notes (an outside agent).` : `${r.id} has ended (${r.state}): continue it with helper_continue instead.`);
      },
    },
    {
      risk: "safe",
      spec: {
        name: "helper_continue",
        description: "Continues a helper that ended (done, failed or stopped) with a follow-up: it goes on from its own conversation, on the same model and role, in the background. Its new report reaches you at your next turn, or ask with helper_result / helper_wait. Cheaper than a new helper when the follow-up builds on its work.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "The helper's id." }, text: { type: "string", description: `What to do next (up to ${NOTE_CHARS} characters).` } }, required: ["id", "text"] },
      },
      run: async (input) => {
        const r = mine(input.id);
        const info = continueHelperRun(o, r.id, typeof input.text === "string" ? input.text : "", "lead");
        return { output: `Continued ${info.id} in the background${info.state === "waiting" ? " (waiting in the queue)" : ""}. Its new report reaches you at your next turn, or ask with helper_result / helper_wait.` };
      },
    },
  ];
}

/** The `delegate` tool. */
export function delegateTool(o: DelegateOptions): AgentTool {
  const models = o.models().slice(0, 12);
  const agents = (o.agents?.() ?? []).slice(0, 12);
  const runs = o.runs ?? new HelperRuns({ limit: () => 4 });
  const chatId = o.chatId ?? `chat-${randomUUID().slice(0, 6)}`;
  const background = !!o.runs;
  return {
    risk: "safe",
    spec: {
      name: "delegate",
      description: `Hand independent parts of a job to helpers that run at the same time, each in its own clean context, and get their short reports back. Helper types: "lookup" (find where something is, read and quote files; a small fast model), "research" (read code and the web on one question; your own model), "build" (make one change in its own copy of the project, comes back as a diff for you to apply; only in a code chat on a git project). Use it for legwork that would fill your context. Give each part everything it needs (helpers do not see the chat) and ask for a report under 15 lines with paths and numbers. Up to 4 parts; more wait in a queue. A part may name a model${models.length ? ` (${models.join(", ")})` : ""}; otherwise the type's model from Settings is used. Helpers never change the user's files: you make the changes yourself after.${background ? ' Set "background": true on a part to go on working meanwhile: delegate answers at once with its id, its report reaches you at your next turn, or ask with helper_result / helper_wait.' : ""} They all run on this computer: to split work across the user's other computers (My devices), use split_across_computers instead.${agents.length ? `\n\nNamed agents (set "agent" on a part when one fits the job, or when the user names or @-mentions it; it brings its own instructions and model):\n${agents.map((a) => `- ${a.name}${a.source === "project" ? " (this project's)" : ""}: ${a.description.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}` : ""}`,
      inputSchema: {
        type: "object",
        properties: {
          parts: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                task: {
                  type: "string",
                  description: "The whole instruction for this helper.",
                },
                title: { type: "string", description: "The task in a few words, for the user's screen." },
                type: { type: "string", enum: ["lookup", "research", "build"], description: "The helper's type (default research)." },
                model: { type: "string", description: "Optional model id." },
                ...(background ? { background: { type: "boolean", description: "Run in the background: go on working, the report comes later." } } : {}),
                ...(agents.length ? { agent: { type: "string", enum: agents.map((a) => a.name), description: "Optional: a named agent to do this part." } } : {}),
              },
              required: ["task"],
            },
          },
        },
        required: ["parts"],
      },
    },
    run: async (input, ctx) => {
      const parts = (
        Array.isArray(input.parts)
          ? (input.parts as Array<Record<string, unknown>>)
          : []
      )
        .filter((p) => typeof p?.task === "string" && p.task.trim())
        .slice(0, 4);
      if (!parts.length) throw new Error("Give at least one part with a task.");
      const fallback = o.currentModel();
      const started = Date.now();
      const limits = o.limits?.() ?? {};
      const builtin = builtinHelpers(limits.steps);
      const results: Array<string | { id: string; n: number; background: boolean }> = [];
      for (const [i, p] of parts.entries()) {
        const named = typeof p.agent === "string" ? [...(o.agents?.() ?? []), ...builtin].find((a) => a.name.toLowerCase() === String(p.agent).trim().toLowerCase()) : undefined;
        const kind = kindOf(p, named);
        const agent = named ?? (kind === "research" && !p.type ? undefined : builtin.find((b) => b.kind === kind));
        const asked = typeof p.model === "string" && p.model.trim() ? p.model.trim() : agent?.model;
        // The model: one the part or its agent names, else the type's choice in Settings, else the chat's.
        let model: HelperModel | undefined;
        if (asked) {
          let id = asked;
          try {
            o.turnFor(asked);
          } catch {
            if (!fallback) {
              results.push(`## Part ${i + 1}\nModel ${asked} is not available.`);
              continue;
            }
            id = fallback;
          }
          model = { modelId: id, label: id.split("/").pop() ?? id, local: false, ...(id !== asked ? { note: `asked for ${asked}, not available` } : {}) };
        } else if (o.modelFor) model = await o.modelFor({ kind, ...(agent ? { agent } : {}) });
        else if (fallback) model = { modelId: fallback, label: fallback.split("/").pop() ?? fallback, local: false };
        if (!model) {
          results.push(`## Part ${i + 1}\nNo model to run it.`);
          continue;
        }
        // A builder works in its own copy of the project (a git worktree), so it never touches the user's folder.
        const write = kind === "build" || !!agent?.write;
        if (write && !o.worktree?.()) {
          results.push(`## Part ${i + 1}${agent ? ` — agent ${agent.name}` : ""}\nNot run: this agent changes files, so it works only in a code chat whose folder is a git project (it gets its own copy there).`);
          continue;
        }
        const title = (typeof p.title === "string" && p.title.trim() ? p.title : String(p.task)).split("\n")[0]!.slice(0, 120);
        const m = model;
        const maxSteps = agent?.maxTurns ?? limits.steps?.[kind] ?? HELPER_STEPS[kind];
        const bg = background && (p.background === true || agent?.background === true);
        const info = runs.start({
          chatId,
          kind,
          title,
          ...(agent && agent.source !== "builtin" ? { agent: agent.name } : {}),
          ...(ctx.callId ? { callId: ctx.callId } : {}),
          background: bg,
          maxSteps,
          timeMs: (agent?.maxMinutes ?? limits.minutes ?? 10) * 60_000,
          local: m.local,
          model: m.label,
          ...(m.note ? { modelNote: m.note } : {}),
          ...(m.noteHe ? { modelNoteHe: m.noteHe } : {}),
          ...(m.cloud ? { cloud: true } : {}),
          // What builds its work again: a background part after a restart (a part the chat waits for ends with the
          // chat's turn), and any part for a follow-up after it ended.
          resume: { task: String(p.task), kind, ...(agent ? { agent: agent.name } : {}), ...(asked && !m.note ? { model: m.modelId } : {}), maxSteps, write } satisfies HelperResume,
          run: helperWork(o, { task: String(p.task), title, kind, ...(agent ? { agent } : {}), model: m, maxSteps, write }, (text) => ctx.progress?.(text)),
        });
        results.push({ id: info.id, n: i + 1, background: info.background });
      }
      // The chat's Stop stops the parts it waits for (background ones too: the chat's Stop stops all its helpers).
      const waitFor = results.flatMap((r) => (typeof r === "object" && !r.background ? [r.id] : []));
      const stopAll = () => {
        for (const r of results) if (typeof r === "object") runs.stop(r.id);
      };
      ctx.signal.addEventListener("abort", stopAll, { once: true });
      try {
        await runs.wait(waitFor);
      } finally {
        ctx.signal.removeEventListener("abort", stopAll);
      }
      const lines = results.map((r) => {
        if (typeof r === "string") return r;
        const info = runs.get(r.id)!;
        if (r.background) return `## Part ${r.n} — ${info.kind} — ${info.model} (id ${info.id})\nStarted in the background${info.state === "waiting" ? " (waiting in the queue)" : ""}. Go on with your work: its report reaches you at your next turn, or ask with helper_result / helper_wait.`;
        return reportFor(info, r.n);
      });
      const ran = results.filter((r) => typeof r === "object").length;
      return {
        output: `${lines.join("\n\n")}\n\n(${ran} helper${ran === 1 ? "" : "s"}, ${Math.round((Date.now() - started) / 1000)} s)`,
      };
    },
  };
}
