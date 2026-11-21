import { randomBytes } from "node:crypto";
import { AGENT_GIT_IDENTITY } from "@kesher/agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { INBOX_GIT_MISSING, type InboxApprovalAsk, type InboxBusy, type InboxRunAsk, type InboxCheck, type InboxSettings, type InboxState, type InboxStatus, type InboxTaskSpec, type InboxTaskView } from "@kesher/shared";
import type { AcpAgent, AcpHandlers, AcpPermission } from "./acp.js";
import { optionFor } from "./acp-chat.js";
import { changesVersion, checkPaths, decideStep, scanDiff } from "./inbox-policy.js";
import { createSessionWorktree, excludeWorktrees, type Git } from "./session-worktrees.js";
import type { TaskBoard } from "./task-board.js";
import { agentPrompt, boardSizeFor, branchFor, checkParts, INBOX_DEFAULTS, parseTaskFile, pushRef, resultFileText, routeTask, slugOf, taskFileText, validBranchName, validTaskId } from "./task-inbox.js";

/**
 * The task inbox on the PC (docs/RESEARCH_LOG.md, "A task inbox", plan steps 2, 4 and 6): fetches the `kesher-inbox`
 * branch, puts each new task in the queue and on the shared task board, and runs an Antigravity task **only when the
 * user presses Run on this computer**, one task per press, one prompt per task, never in parallel (Roee's decision and
 * Google's terms for a personal plan; see the 2026-11-19 terms entry). The agent works in its own worktree with no
 * secrets; KesherAI answers its permission requests by the inbox policy, then checks the work itself (paths, secrets
 * and privacy, version fields, the allowed check commands), commits it, and pushes only that `agy/*` branch and the
 * result file on the inbox branch. Local-model tasks go to self-work through the board; Opus tasks stay for Claude.
 */

/**
 * Runs a command: arguments as a list, never through a shell. For {@link TaskInboxDeps.git} the list holds only git's
 * arguments (`["fetch", …]`, without "git"); for {@link TaskInboxDeps.run} the program comes first.
 */
export type RunCmd = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** What the inbox needs from KesherAI (injected, so it can be tested with a local bare repo and a fake agent). */
export interface TaskInboxDeps {
  /** Settings > Task inbox (already filled with defaults). */
  settings: () => Partial<InboxSettings>;
  /** Where the queue is kept (KesherAI's data folder). */
  file: string;
  /** Runs git with these arguments (the program is git itself; the list starts with the git command, e.g. "fetch"). */
  git: RunCmd;
  /** Runs one check command (an argument list), at low priority. */
  run: RunCmd;
  /** Starts the unmodified `agy acp` in the folder (it signs in by itself; no token passes through KesherAI). */
  startAgent: (cwd: string, h: AcpHandlers) => Promise<AcpAgent>;
  board?: TaskBoard;
  notify: (title: string, body: string) => void;
  busy: () => Promise<InboxBusy>;
  /** This computer's user name and home folder, which the privacy scan looks for. */
  me?: { username?: string; home?: string };
  /**
   * Small research tasks with the user's free "gemini" provider (route B; absent: none can run). `ready` says whether
   * that provider is configured; `run` writes the report for a question (deep-research.ts `researchReport`) and throws
   * the provider's own error, so a quota or billing error can be told apart here.
   */
  research?: { ready: () => boolean; run: (question: string, signal: AbortSignal) => Promise<string> };
  now?: () => number;
  /** How long an asked step waits before it is denied (default 30 minutes). */
  approvalMs?: number;
}

/** The commit author for everything the inbox commits (never the user's own name or email). */
const AUTHOR = ["-c", `user.name=${AGENT_GIT_IDENTITY.GIT_AUTHOR_NAME}`, "-c", `user.email=${AGENT_GIT_IDENTITY.GIT_AUTHOR_EMAIL}`, "-c", "commit.gpgsign=false"];

/** What is kept in the queue file. */
interface Saved {
  tasks: InboxTaskView[];
  today: { date: string; used: number };
  quota?: InboxState["quota"];
  /** The free Gemini key's limit ran out: no free-Gemini task starts before this (ms since epoch). */
  geminiUntil?: number;
  lastFetch?: number;
  lastError?: string;
}

/** What a message ask shows: the agent's task in a few words, the message, and where it runs. */
export interface MessageAskInfo {
  title: string;
  text: string;
  /** The project or copy it runs in (a name, never a full path). */
  where: string;
}

/** An error with an HTTP status for the route. */
const fail = (msg: string, code: number) => Object.assign(new Error(msg), { code });

/** Statuses a task can be Run from. */
const RUNNABLE = new Set<InboxStatus>(["waiting", "failed", "partial", "deferred-quota"]);

/** The run in progress. */
interface Active {
  id: string;
  agent?: AcpAgent;
  why?: "stop" | "time";
  answer?: (decision: "allow" | "deny" | "timeout") => void;
  done: Promise<void>;
}

/**
 * When the plan's quota resets, from the agent's error text ("retry in 1h35m", "try again in 20 minutes").
 *
 * @param msg - The error.
 * @param now - The time.
 * @returns The time, and whether it is a guess (an hour) because the text did not say.
 */
export function quotaUntil(msg: string, now: number): { until: number; estimated: boolean } {
  const after = /(?:retry|try again|resets?|available)([\s\S]{0,40})/i.exec(msg)?.[1] ?? "";
  const h = Number(/(\d{1,2})\s*h/i.exec(after)?.[1] ?? 0);
  const min = Number(/(\d{1,3})\s*m/i.exec(after)?.[1] ?? 0);
  if (h || min) return { until: now + (h * 60 + min) * 60_000, estimated: false };
  return { until: now + 60 * 60_000, estimated: true };
}

/**
 * Whether an agent's or provider's error is its plan's quota or rate limit, or an offer to pay (credits, an upgrade,
 * billing). Never paid for, ever (Roee, 2026-11-21): the task is deferred to the reset instead of failing or buying.
 * The free Gemini key must stay without a billing account, so it can never charge.
 */
export function isQuotaError(msg: string): boolean {
  return /quota|rate.?limit|resource.?exhausted|\b429\b|usage limit|limit reached|exceeded your|ai credits?|(buy|purchase|top.?up|add|get)\s+(more\s+)?credits?|\bpurchase\b|upgrade\s+(your\s+|to\s+|the\s+)?(a\s+)?(plan|subscription|pro|ultra|tier)|\bbilling\b/i.test(msg);
}

/** The queue, its runs and the inbox branch. */
export class TaskInbox {
  private saved: Saved = { tasks: [], today: { date: "", used: 0 } };
  private loaded = false;
  private active?: Active;
  /** Tasks the user pressed Run on while another ran: each starts, in order, when the one before ends (one press each). */
  private queue: Array<{ id: string; how: { here: boolean } | { approvedBy: string } }> = [];
  private timer?: ReturnType<typeof setInterval>;
  /** Asks for one message to Antigravity from a chat's agent (kept in memory: a restart drops them, nothing runs). */
  private readonly messageAsks = new Map<string, { ask: InboxRunAsk; info: MessageAskInfo; done: (a: "allow" | "deny" | "timeout") => void }>();
  private saving: Promise<void> = Promise.resolve();
  private syncing?: Promise<void>;
  /** The free-Gemini research loop (one task at a time) and the stop for its current model call. */
  private geminiRun?: Promise<void>;
  private geminiStop?: AbortController;

  /** @param d - What it needs from KesherAI. */
  constructor(private readonly d: TaskInboxDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private get s(): InboxSettings {
    // Unset fields (lists the user never changed) keep the defaults.
    const given = Object.fromEntries(Object.entries(this.d.settings()).filter(([, v]) => v !== undefined));
    return { ...INBOX_DEFAULTS, ...given } as InboxSettings;
  }

  /** Reads the queue file once; a run cut off by a restart is marked failed (its worktree stays for a look). */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.d.file, "utf8")) as Saved;
      this.saved = { tasks: Array.isArray(raw.tasks) ? raw.tasks : [], today: raw.today ?? { date: "", used: 0 }, ...(raw.quota ? { quota: raw.quota } : {}), ...(raw.geminiUntil ? { geminiUntil: raw.geminiUntil } : {}), ...(raw.lastFetch ? { lastFetch: raw.lastFetch } : {}) };
    } catch {
      this.saved = { tasks: [], today: { date: "", used: 0 } };
    }
    for (const t of this.saved.tasks) {
      if (t.status === "running" || t.status === "needs-approval") {
        t.status = "failed";
        t.note = "KesherAI restarted during the run.";
        delete t.pending;
      }
    }
  }

  private readonly listeners = new Set<() => void>();

  /**
   * Calls back after every change of the queue (the hub's live agent activity watches it).
   *
   * @param cb - The callback (must not throw).
   * @returns A function that stops it.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The tasks as they are now, oldest first, without their diffs. */
  async list(): Promise<InboxTaskView[]> {
    await this.load();
    return this.saved.tasks.map(({ diff: _d, ...t }) => ({ ...t }));
  }

  /** Writes the queue file (one write at a time, write then rename). */
  private save(): Promise<void> {
    for (const cb of this.listeners) cb();
    const body = JSON.stringify(this.saved, null, 1);
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.d.file);
    }).catch(() => undefined);
    return this.saving;
  }

  /** Today's Antigravity count, reset at midnight. */
  private today(): { date: string; used: number } {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (this.saved.today.date !== date) this.saved.today = { date, used: 0 };
    return this.saved.today;
  }

  private find(id: string): InboxTaskView {
    const t = this.saved.tasks.find((x) => x.id === id);
    if (!t) throw fail("No such task.", 404);
    return t;
  }

  /** A git wrapper that rejects on failure (for session-worktrees.ts). */
  private gitStrict: Git = async (cwd, args) => {
    const r = await this.d.git(cwd, args);
    if (r.code !== 0) throw new Error(r.out.slice(0, 400));
    return r.out;
  };

  /**
   * The queue and its state for the page.
   *
   * @param here - The request comes from this computer itself (Run works only then).
   */
  async state(here: boolean): Promise<InboxState> {
    await this.load();
    const busy = await this.d.busy().catch(() => ({ free: true, reasons: [] }) as InboxBusy);
    const quota = this.saved.quota && this.saved.quota.until > this.now() ? this.saved.quota : undefined;
    this.expireAsks();
    return {
      settings: this.s,
      today: { ...this.today() },
      // Newest first; the diff is only on the task page.
      tasks: [...this.saved.tasks].reverse().map(({ diff: _d, ...t }) => t),
      busy,
      ...(this.saved.lastFetch ? { lastFetch: this.saved.lastFetch } : {}),
      ...(this.saved.lastError ? { lastError: this.saved.lastError } : {}),
      ...(quota ? { quota } : {}),
      runHere: here,
      ...(this.s.repo ? { project: basename(this.s.repo) } : {}),
    };
  }

  /** Resolves when no run is going on (its result written). */
  async idle(): Promise<void> {
    await this.active?.done;
    await this.geminiRun;
  }

  /**
   * The task running now, for the "Continue what was running" record written on shutdown (after the start it is
   * marked failed, and runs again only on the user's Run).
   *
   * @returns Its id and title, or undefined when none runs.
   */
  runningTask(): { id: string; title: string } | undefined {
    const t = this.active && this.saved.tasks.find((x) => x.id === this.active!.id);
    return t ? { id: t.id, title: t.title } : undefined;
  }

  /** One task with its diff. */
  async task(id: string): Promise<InboxTaskView> {
    await this.load();
    return this.find(id);
  }

  /** Starts fetching every few minutes while the inbox is on (Settings); call again after a settings change. */
  start(): void {
    void this.load();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const s = this.s;
    if (!s.enabled || s.paused || !s.repo) return;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), Math.max(1, s.fetchMinutes) * 60_000);
    this.timer.unref?.();
    void this.sync().catch(() => undefined);
  }

  /** Stops fetching (Off is the kill switch: it also stops a run). */
  async stopAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.geminiStop?.abort();
    if (this.active) await this.stop(this.active.id).catch(() => undefined);
  }

  /** The inbox branch, checked. */
  private branch(): string {
    const b = this.s.branch || "kesher-inbox";
    if (!validBranchName(b) || b.includes("/") || ["main", "master", "release"].includes(b)) throw fail("The inbox branch name is not allowed.", 400);
    return b;
  }

  /** The project folder, checked. */
  private repo(): string {
    const r = this.s.repo;
    if (!r || !existsSync(join(r, ".git"))) throw fail("Pick the git project for the inbox in Settings > Task inbox.", 400);
    return r;
  }

  /**
   * Fetches the inbox branch, adds new tasks to the queue (and the board), follows self-work's board items, and
   * writes results that were not written yet. Only reads `tasks/*.md` through git (nothing is checked out from it).
   */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  /**
   * Claude's work list (`docs/WORK_LIST.md` on `main` of the inbox's project), for "Tasks on all your devices"
   * (work-list-sync.ts). Fetches only `main` into its remote-tracking ref and reads the file through git (nothing is
   * checked out).
   *
   * @returns The file's text, or undefined when there is no project, the fetch failed or the file is missing or over 512 KB.
   */
  async workList(): Promise<string | undefined> {
    await this.load();
    let repo: string;
    try {
      repo = this.repo();
    } catch {
      return undefined;
    }
    const ref = "refs/remotes/origin/main";
    const fetched = await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/main:${ref}`], 60_000);
    // Offline: the last fetched copy still counts (it is what the PC knew).
    if (fetched.code !== 0 && (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", ref])).code !== 0) return undefined;
    const size = await this.d.git(repo, ["cat-file", "-s", `${ref}:docs/WORK_LIST.md`]);
    if (size.code !== 0 || Number(size.out.trim()) > 512 * 1024) return undefined;
    const body = await this.d.git(repo, ["show", `${ref}:docs/WORK_LIST.md`]);
    return body.code === 0 ? body.out : undefined;
  }

  private async doSync(): Promise<void> {
    await this.load();
    const s = this.s;
    if (!s.enabled) return;
    const repo = this.repo();
    const br = this.branch();
    const fetched = await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${br}:refs/remotes/origin/${br}`], 60_000);
    this.saved.lastFetch = this.now();
    if (fetched.code !== 0) {
      // No inbox branch yet is not an error: nothing was sent.
      // Git itself missing comes first: its message would otherwise read as "no inbox branch yet".
      this.saved.lastError = fetched.out === INBOX_GIT_MISSING ? INBOX_GIT_MISSING : /couldn't find remote ref|not found/i.test(fetched.out) ? undefined : `git fetch: ${fetched.out.slice(0, 200)}`;
      if (!this.saved.lastError) delete this.saved.lastError;
    } else {
      delete this.saved.lastError;
      const ls = await this.d.git(repo, ["ls-tree", "--name-only", `refs/remotes/origin/${br}`, "tasks/"]);
      const names = ls.code === 0 ? ls.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^tasks\/[a-z0-9-]+\.md$/.test(l)).slice(0, 200) : [];
      for (const name of names) {
        const id = name.slice(6, -3);
        if (!validTaskId(id) || this.saved.tasks.some((t) => t.id === id)) continue;
        const size = await this.d.git(repo, ["cat-file", "-s", `refs/remotes/origin/${br}:${name}`]);
        if (size.code !== 0 || Number(size.out.trim()) > 32 * 1024) {
          this.declined(id, "The task file is bigger than 32 KB.");
          continue;
        }
        const body = await this.d.git(repo, ["show", `refs/remotes/origin/${br}:${name}`]);
        if (body.code !== 0) continue;
        const parsed = parseTaskFile(body.out, id, s);
        if ("error" in parsed) this.declined(id, parsed.error);
        else await this.enqueue(parsed.spec);
      }
    }
    await this.followBoard();
    for (const t of this.saved.tasks) if (isEnded(t.status) && !t.resultWritten && t.from !== "hub") await this.writeResult(t).catch(() => undefined);
    await this.save();
    void this.pumpGemini().catch(() => undefined);
  }

  /** A task file that could not be read: shown as declined, with why. */
  private declined(id: string, note: string): void {
    this.saved.tasks.push({ id, title: id, executor: "auto", risk: "high", from: "claude", base: "", allowedPaths: [], forbiddenPaths: [], check: "", maxMinutes: 0, maxFiles: 0, goal: "", status: "declined", runBy: "opus", branch: "", note, resultWritten: false });
  }

  /** Adds a checked task to the queue and the board. */
  private async enqueue(spec: InboxTaskSpec, boardId?: string): Promise<InboxTaskView> {
    const runBy = routeTask(spec);
    const t: InboxTaskView = {
      ...spec,
      runBy,
      branch: branchFor(spec, runBy),
      status: runBy === "antigravity" || runBy === "gemini" ? "waiting" : "queued",
      ...(runBy === "opus" ? { note: "Claude runs it with its own Opus agent." } : runBy === "local" ? { note: "Self-work takes it from the task board." } : runBy === "gemini" ? { note: "Runs by itself with the free Gemini key." } : {}),
    };
    if (boardId) t.boardId = boardId;
    else if (this.d.board) {
      const b = await this.d.board.change("claude", [{ op: "add", title: `[Inbox ${spec.id}] ${spec.title}`, details: [`From the task inbox (tasks/${spec.id}.md on ${this.s.branch}).`, `Executor: ${runBy}${runBy === "antigravity" ? " (waits for Run on the PC)" : runBy === "gemini" ? " (automatic, free Gemini)" : ""}.`, ...(runBy === "gemini" ? [] : [`Branch: ${t.branch}`])].join("\n"), size: boardSizeFor(spec, runBy) }]).catch(() => undefined);
      const added = b?.tasks.at(-1);
      if (added) {
        t.boardId = added.id;
        if (runBy === "local") await this.d.board.change("roee", [{ op: "edit", id: added.id, forKesher: true }]).catch(() => undefined);
        // "local ok": the cooldown hand-off may give it to the local model while Claude is cooling down.
        else if (spec.localOk && runBy === "opus") await this.d.board.change("roee", [{ op: "edit", id: added.id, localOk: true }]).catch(() => undefined);
      }
    }
    this.saved.tasks.push(t);
    if (this.saved.tasks.length > 300) this.saved.tasks = this.saved.tasks.slice(-300);
    // An Antigravity task: the PC asks right away (on the PC and the phone); it starts only on the user's tap.
    if (runBy !== "antigravity" || !this.makeAsk(t)) this.d.notify("📥 A new task in the inbox", `${spec.id}: ${spec.title}`);
    return t;
  }

  /** Local-model tasks end when self-work marks their board item done or blocked. */
  private async followBoard(): Promise<void> {
    if (!this.d.board) return;
    const board = await this.d.board.read().catch(() => undefined);
    if (!board) return;
    for (const t of this.saved.tasks) {
      if (t.runBy !== "local" || t.status !== "queued" || !t.boardId) continue;
      const item = board.tasks.find((x) => x.id === t.boardId);
      if (item && (item.status === "open" || item.status === "claimed")) {
        // Shown on the hub: open = waits for the local agent, claimed = it is working on it.
        if (t.boardState !== item.status) t.boardState = item.status;
        continue;
      }
      if (!item || (item.status !== "done" && item.status !== "blocked")) continue;
      t.status = item.status === "done" ? "done" : "failed";
      t.summary = (item.result ?? "").slice(0, 2000);
      t.endedAt = this.now();
      t.resultWritten = false;
    }
  }

  /**
   * A task from the Kesher Cloud hub that targets Antigravity: prepared in the queue (linked to its board item, whose
   * result goes back to the hub), and it waits for Run on the PC like every Antigravity task. The phone may see it,
   * never start it.
   *
   * @param t - The hub's task (its spec is data).
   * @param boardId - The board item hub-client.ts made for it.
   */
  async fromHub(t: { taskId: string; title: string; spec: string }, boardId: string | undefined): Promise<void> {
    await this.load();
    const id = `h-${slugOf(t.taskId).slice(0, 40)}`;
    if (!validTaskId(id) || this.saved.tasks.some((x) => x.id === id)) return;
    const s = this.s;
    await this.enqueue({ id, title: t.title.slice(0, 200), executor: "antigravity", risk: "medium", from: "hub", base: "origin/main", allowedPaths: [...s.allowedPaths], forbiddenPaths: [...s.forbiddenPaths], check: "", maxMinutes: s.maxMinutes, maxFiles: 15, goal: t.spec.slice(0, 6000) }, boardId);
    await this.save();
  }

  /**
   * A task another of the user's devices wrote to Google Drive (tasks-sync.ts): checked like a task file and queued
   * once (an id already in the queue is left alone), marked as from `device`. Nothing the PC runs by itself may take
   * it (security scan 167: anyone holding the Drive app-folder token could write one): it goes to Antigravity, which
   * waits for the user's Run on the PC or the phone, or, when Claude was asked, stays for Claude (the PC never runs
   * those). Self-work (the local model) never takes it by itself.
   *
   * @param t - The queue id (made by tasks sync), title, goal and the executor the device asked for (data only).
   * @returns Whether it was added.
   */
  async fromDrive(t: { id: string; title: string; goal: string; executor: string }): Promise<boolean> {
    await this.load();
    if (!validTaskId(t.id) || this.saved.tasks.some((x) => x.id === t.id)) return false;
    const s = this.s;
    const executor: InboxTaskSpec["executor"] = t.executor === "claude" || t.executor === "opus" ? "opus" : "antigravity";
    const spec: InboxTaskSpec = { id: t.id, title: t.title.trim().slice(0, 200) || "Task", executor, risk: "medium", from: "device", base: "origin/main", allowedPaths: [...s.allowedPaths], forbiddenPaths: [...s.forbiddenPaths], check: "", maxMinutes: s.maxMinutes, maxFiles: 15, goal: t.goal.trim().slice(0, 6000) || t.title.trim().slice(0, 200) };
    const parsed = parseTaskFile(taskFileText(spec), spec.id, s);
    if ("error" in parsed) return false;
    await this.enqueue(parsed.spec);
    await this.save();
    return true;
  }

  /**
   * A task the user writes in the app ("+ Task", also from the phone): added to the queue and written to the inbox
   * branch so Claude sees it too.
   *
   * @param input - Title, goal and the rest; paths and limits default to Settings. `extraPaths`: more folders the task
   *   may change, only `integrations/<engine>/<folder>/**` (an engine plugin's AI-converted copy, engine-support.ts). `maxFiles`: 1–60 (default 15).
   */
  async add(input: { title: string; goal: string; executor?: string; risk?: string; check?: string; acceptance?: string; extraPaths?: string[]; maxFiles?: number }): Promise<InboxTaskView> {
    await this.load();
    const s = this.s;
    const title = String(input.title ?? "").trim().slice(0, 200);
    const goal = String(input.goal ?? "").trim().slice(0, 6000);
    if (!title || !goal) throw fail("A task needs a title and a goal.", 400);
    const day = new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, "");
    let n = 1;
    while (this.saved.tasks.some((t) => t.id === `r-${day}-${String(n).padStart(2, "0")}`)) n++;
    const executor = ["auto", "antigravity", "local", "opus"].includes(String(input.executor)) ? (input.executor as InboxTaskSpec["executor"]) : "auto";
    const risk = ["low", "medium", "high"].includes(String(input.risk)) ? (input.risk as InboxTaskSpec["risk"]) : "medium";
    const spec: InboxTaskSpec = { id: `r-${day}-${String(n).padStart(2, "0")}`, title, executor, risk, from: "roee", base: "origin/main", allowedPaths: [...s.allowedPaths, ...(input.extraPaths ?? []).filter((x) => /^integrations\/[a-z]+\/[\w.-]+\/\*\*$/.test(x) && !x.includes("..")).slice(0, 2)], forbiddenPaths: [...s.forbiddenPaths], check: String(input.check ?? "").trim().slice(0, 300), maxMinutes: s.maxMinutes, maxFiles: Math.min(60, Math.max(1, Math.round(Number(input.maxFiles) || 15))), goal, ...(input.acceptance?.trim() ? { acceptance: input.acceptance.trim().slice(0, 3000) } : {}) };
    // The same checks as a file from git (the text is data either way).
    const parsed = parseTaskFile(taskFileText(spec), spec.id, s);
    if ("error" in parsed) throw fail(parsed.error, 400);
    const t = await this.enqueue(parsed.spec);
    await this.save();
    void this.pumpGemini().catch(() => undefined);
    if (s.enabled && s.repo) await this.commitToInbox([[`tasks/${spec.id}.md`, taskFileText(parsed.spec)]], `inbox: task ${spec.id}`).catch((e) => {
      this.saved.lastError = `Could not write the task to ${s.branch}: ${(e as Error).message.slice(0, 160)}`;
    });
    return t;
  }

  /**
   * Writes files to the inbox branch in its own worktree (`.kesher/worktrees/inbox`), commits them as KesherAI and
   * pushes that one branch. One writer per file (Claude writes tasks/, KesherAI results/), so a rebase never conflicts.
   */
  private async commitToInbox(files: Array<[string, string]>, message: string): Promise<void> {
    const repo = this.repo();
    const br = this.branch();
    const wt = join(repo, ".kesher", "worktrees", "inbox");
    const remote = (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${br}`])).code === 0;
    if (!existsSync(wt)) {
      await excludeWorktrees(repo, this.gitStrict);
      await mkdir(dirname(wt), { recursive: true });
      await this.d.git(repo, ["worktree", "prune"]);
      const local = (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${br}`])).code === 0;
      const made = local ? await this.d.git(repo, ["worktree", "add", wt, br]) : remote ? await this.d.git(repo, ["worktree", "add", "-b", br, wt, `refs/remotes/origin/${br}`]) : await this.d.git(repo, ["worktree", "add", "--orphan", "-b", br, wt]);
      if (made.code !== 0) throw new Error(made.out.slice(0, 300));
    }
    if (remote) await this.d.git(wt, ["-c", "rebase.autoStash=true", ...AUTHOR, "pull", "--quiet", "--rebase", "origin", br], 60_000);
    for (const [path, text] of files) {
      if (!/^(tasks|results)\/[a-z0-9-]+\.md$/.test(path)) throw new Error("Bad inbox path.");
      const reasons = scanDiff(text.split("\n").map((l) => `+${l}`).join("\n"), this.d.me);
      if (reasons.length) throw new Error(`The file would show ${reasons.map((r) => r.kind).join(", ")}; not written.`);
      await mkdir(dirname(join(wt, path)), { recursive: true });
      await writeFile(join(wt, path), text);
      await this.d.git(wt, ["add", "--", path]);
    }
    const c = await this.d.git(wt, [...AUTHOR, "commit", "--quiet", "--no-verify", "-m", message]);
    if (c.code !== 0 && !/nothing to commit|no changes added/i.test(c.out)) throw new Error(c.out.slice(0, 300));
    await pushRef(this.d.git, wt, br, br);
  }

  /**
   * Runs the free-Gemini research tasks (route B) by themselves, one at a time: no Run press is needed, because the
   * free Gemini key is the user's own API key and not an agent's account. A task waits with a note when no "gemini"
   * provider is configured. When the key's limit is reached the run stops and the task is deferred to the reset; it
   * gets at most one automatic retry after that, never a loop.
   *
   * @returns Resolves when no task is left to run now.
   */
  pumpGemini(): Promise<void> {
    this.geminiRun ??= this.doGemini().finally(() => {
      this.geminiRun = undefined;
    });
    return this.geminiRun;
  }

  private async doGemini(): Promise<void> {
    await this.load();
    const s = this.s;
    if (!s.enabled || s.paused) return;
    for (;;) {
      const now = this.now();
      const due = (x: InboxTaskView) => x.runBy === "gemini" && (x.status === "waiting" || (x.status === "deferred-quota" && !x.autoRetried && x.retryAt !== undefined && x.retryAt <= now));
      const t = this.saved.tasks.find(due);
      if (!t || (this.saved.geminiUntil ?? 0) > now) return;
      const r = this.d.research;
      if (!r?.ready()) {
        const note = "Waiting for a Gemini connection: add Google Gemini with a free AI Studio key (Settings > Connections).";
        if (t.note !== note) {
          t.note = note;
          await this.save();
        }
        return;
      }
      await this.runGemini(t, r);
    }
  }

  /** One free-Gemini research run, to its end (done, failed or deferred by the quota). */
  private async runGemini(t: InboxTaskView, r: NonNullable<TaskInboxDeps["research"]>): Promise<void> {
    if (t.status === "deferred-quota") t.autoRetried = true;
    Object.assign(t, { status: "running" as InboxStatus, startedAt: this.now(), resultWritten: false });
    for (const k of ["endedAt", "note", "summary", "retryAt", "researchReport"] as const) delete t[k];
    await this.save();
    this.d.notify("✦ Research started (free Gemini)", `${t.id}: ${t.title}`);
    const stop = (this.geminiStop = new AbortController());
    const timer = setTimeout(() => stop.abort(), t.maxMinutes * 60_000);
    let status: InboxStatus = "done";
    try {
      const question = [t.title, t.goal, t.acceptance ? `Acceptance:\n${t.acceptance}` : "", t.outOfScope ? `Out of scope:\n${t.outOfScope}` : ""].filter(Boolean).join("\n\n");
      // The time limit holds even if a search or a page read ignores the signal (a run once hung for two hours).
      const report = (await Promise.race([
        r.run(question, stop.signal),
        new Promise<never>((_, rej) => stop.signal.addEventListener("abort", () => rej(new Error("Stopped at the time limit.")), { once: true })),
      ])).trim();
      if (!report) throw new Error("The model wrote no report.");
      t.researchReport = report;
      t.summary = report.slice(0, 2000);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (isQuotaError(msg)) {
        // A limit, quota or billing offer: stop here and wait for the reset. Never retried in a loop, never paid.
        const q = quotaUntil(msg, this.now());
        this.saved.geminiUntil = q.until;
        status = "deferred-quota";
        if (!t.autoRetried) t.retryAt = q.until;
        t.note = `The free Gemini limit was reached; ${t.autoRetried ? "run it again later." : `it tries once more after ${new Date(q.until).toISOString()}.`}`;
      } else if (!stop.signal.aborted && /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|try again later/i.test(msg)) {
        // Google busy (the free tier answers 503 "overloaded" at peak hours): not a failure, wait and try once more.
        status = "deferred-quota";
        if (!t.autoRetried) t.retryAt = this.now() + 15 * 60_000;
        t.note = `Gemini is busy right now (${/\b(5\d\d)\b/.exec(msg)?.[1] ?? "busy"}); ${t.autoRetried ? "run it again later." : "it tries once more in 15 minutes."}`;
      } else {
        status = "failed";
        t.note = stop.signal.aborted ? `Stopped at the ${t.maxMinutes}-minute limit or by you.` : `The research failed: ${msg.slice(0, 300)}`;
      }
    } finally {
      clearTimeout(timer);
      this.geminiStop = undefined;
    }
    t.status = status;
    t.endedAt = this.now();
    await this.save();
    if (t.boardId && this.d.board) {
      const line = `${status}${t.note ? ` — ${t.note}` : ""}`.slice(0, 1000);
      await this.d.board.change("kesher", [status === "done" ? { op: "done", id: t.boardId, result: `done: report in results/${t.id}.md` } : status === "deferred-quota" ? { op: "note", text: line, task: t.boardId } : { op: "block", id: t.boardId, result: line }]).catch(() => undefined);
    }
    if (t.from !== "hub") await this.writeResult(t).catch((e) => {
      this.saved.lastError = `Could not write the result: ${(e as Error).message.slice(0, 160)}`;
    });
    await this.save();
    this.d.notify(`${status === "done" ? "✓" : status === "deferred-quota" ? "⏸" : "✕"} ${t.id} ${status}`, t.title);
  }

  /** Writes a task's result file to the inbox branch. */
  private async writeResult(t: InboxTaskView, checkTail = ""): Promise<void> {
    if (!this.s.enabled || !this.s.repo || !validTaskId(t.id)) return;
    await this.commitToInbox([[`results/${t.id}.md`, resultFileText(t, checkTail)]], `inbox: result ${t.id} (${t.status})`);
    t.resultWritten = true;
  }

  /**
   * Why an Antigravity task cannot start now, or undefined when it can (the busy check aside).
   *
   * @param t - The task.
   */
  /** Starts the next task the user already pressed Run on, if any (a stopped or limited one is skipped with its reason). */
  private async runNext(): Promise<void> {
    while (this.queue.length && !this.active) {
      const next = this.queue.shift()!;
      try {
        await this.run(next.id, next.how);
        return;
      } catch (e) {
        const t = this.saved.tasks.find((x) => x.id === next.id);
        if (t) {
          t.note = `Not started from the queue: ${(e as Error).message}`;
          await this.save();
        }
      }
    }
  }

  /** @param ignoreActive - For a press that will wait in the queue: everything but "another task is running". */
  private cannotRun(t: InboxTaskView, ignoreActive = false): { msg: string; code: number } | undefined {
    const s = this.s;
    if (!s.enabled) return { msg: "The inbox is off (Settings > Task inbox).", code: 409 };
    if (s.paused) return { msg: "The inbox is paused.", code: 409 };
    if (t.runBy !== "antigravity") return { msg: t.runBy === "local" ? "Self-work runs this task from the board." : t.runBy === "gemini" ? "This research runs by itself with the free Gemini key." : "Claude runs this task.", code: 409 };
    if (this.active && !ignoreActive) return { msg: "Another task is running. One at a time.", code: 409 };
    if (!RUNNABLE.has(t.status)) return { msg: "This task cannot be run now.", code: 409 };
    if (this.saved.quota && this.saved.quota.until > this.now()) return { msg: `Antigravity's quota ran out; it can run again at ${new Date(this.saved.quota.until).toISOString()}.`, code: 429 };
    if (this.today().used >= s.dailyCap) return { msg: `Today's limit of ${s.dailyCap} Antigravity tasks is reached (Settings > Task inbox).`, code: 429 };
    return undefined;
  }

  /** Drops asks whose 30 minutes are over. */
  private expireAsks(): void {
    for (const t of this.saved.tasks) if (t.runAsk && t.runAsk.until <= this.now()) delete t.runAsk;
  }

  /** Makes a fresh ask for a task and tells the phone; false when the task cannot run now. */
  private makeAsk(t: InboxTaskView): boolean {
    if (this.cannotRun(t)) return false;
    const now = this.now();
    t.runAsk = { requestId: randomBytes(12).toString("hex"), at: now, until: now + (this.d.approvalMs ?? 30 * 60_000), left: Math.max(0, this.s.dailyCap - this.today().used) };
    this.d.notify("✦ Run this task in Antigravity?", `${t.id}: ${t.title} · ${t.runAsk.left} left today`);
    return true;
  }

  /**
   * Asks again "Run this task in Antigravity?" (the earlier ask expired or was answered "Not now").
   *
   * @param id - The task.
   * @returns The task with its new ask.
   */
  async askRun(id: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    const no = this.cannotRun(t);
    if (no) throw fail(no.msg, no.code);
    this.makeAsk(t);
    await this.save();
    return t;
  }

  /** The open asks, for the hub (sent to the phone as approval requests). */
  openAsks(): Array<{ title: string; text: string; where: string; ask: InboxRunAsk }> {
    const messages = [...this.messageAsks.values()].map((m) => ({ title: m.info.title, text: m.info.text, where: m.info.where, ask: m.ask }));
    if (!this.loaded) return messages;
    this.expireAsks();
    return [...this.saved.tasks.filter((t) => t.runAsk).map((t) => ({ title: t.title, text: t.goal, where: t.branch, ask: t.runAsk! })), ...messages];
  }

  /**
   * Asks "Run this in Antigravity?" before one message a chat's agent sends to Antigravity (the `@antigravity`
   * sub-agent): the same ask as an inbox task (the PC, the phone in remote, the hub), one ask for one message, 30
   * minutes, never remembered, and a yes counts against the same daily limit.
   *
   * @param info - What the message is, for the card and the phone.
   * @returns The ask, and its answer when it comes ("timeout" after 30 minutes; "deny" when cancelled).
   * @throws When today's limit is reached or the quota ran out (nothing is asked).
   */
  askMessage(info: MessageAskInfo): { ask: InboxRunAsk; answer: Promise<"allow" | "deny" | "timeout">; cancel: () => void } {
    const now = this.now();
    if (this.saved.quota && this.saved.quota.until > now) throw fail(`Antigravity's quota ran out; it can run again at ${new Date(this.saved.quota.until).toISOString()}.`, 429);
    const cap = this.s.dailyCap;
    if (this.today().used >= cap) throw fail(`Today's limit of ${cap} Antigravity runs is reached (Settings > Task inbox).`, 429);
    const ms = this.d.approvalMs ?? 30 * 60_000;
    const ask: InboxRunAsk = { requestId: randomBytes(12).toString("hex"), at: now, until: now + ms, left: Math.max(0, cap - this.today().used) };
    let finish!: (a: "allow" | "deny" | "timeout") => void;
    const answer = new Promise<"allow" | "deny" | "timeout">((resolve) => (finish = resolve));
    const timer = setTimeout(() => done("timeout"), ms);
    const done = (a: "allow" | "deny" | "timeout") => {
      if (!this.messageAsks.delete(ask.requestId)) return;
      clearTimeout(timer);
      finish(a);
    };
    this.messageAsks.set(ask.requestId, { ask, info: { title: info.title.slice(0, 200), text: info.text.slice(0, 2000), where: info.where.slice(0, 200) }, done });
    this.d.notify("✦ Run this in Antigravity?", `${info.title.slice(0, 120)} · ${ask.left} left today`);
    return { ask, answer, cancel: () => done("deny") };
  }

  /**
   * The answer to a message ask (same verification as {@link answerRun}: the caller passes the verified sender).
   *
   * @returns Whether such an ask was open (it is used up either way).
   */
  async answerMessage(requestId: string, decision: "allow" | "deny", by: string): Promise<boolean> {
    const m = this.messageAsks.get(requestId);
    if (!m || !by) return false;
    if (m.ask.until <= this.now()) {
      m.done("timeout");
      return false;
    }
    if (decision === "allow") {
      await this.load();
      // The limit may have been reached since it was asked.
      if (this.today().used >= this.s.dailyCap) {
        m.done("deny");
        return true;
      }
      this.today().used++;
      await this.save();
    }
    m.done(decision);
    return true;
  }

  /**
   * The answer to an ask, from the user's own tap on the phone (remote, with its paired key, or through the hub,
   * sealed and signed by the paired phone) or on the PC. The ask is used up either way: one yes is one run, and an
   * expired or unknown ask starts nothing.
   *
   * @param requestId - The ask.
   * @param decision - Run, or Not now.
   * @param by - Who answered, as verified by the caller (the paired device's id or name, or "pc").
   * @returns The task, or undefined when no such ask is open.
   */
  async answerRun(requestId: string, decision: "allow" | "deny", by: string): Promise<InboxTaskView | undefined> {
    await this.load();
    this.expireAsks();
    const t = this.saved.tasks.find((x) => x.runAsk?.requestId === requestId);
    if (!t || !by) return undefined;
    delete t.runAsk;
    if (decision !== "allow") {
      t.note = "Not now.";
      await this.save();
      return t;
    }
    return this.run(t.id, { approvedBy: by });
  }

  /**
   * Runs an Antigravity task, only from the user's own action: a press of Run on this computer, or a "Run" answer to
   * the PC's ask (see {@link answerRun}); one at a time, within the daily cap and the quota (a game or a busy PC doesn't hold it back: it runs in the cloud).
   * Returns at once; the run goes on in the background.
   *
   * @param id - The task.
   * @param how - `here`: the press came from this computer itself; `approvedBy`: the verified device that answered the ask.
   */
  async run(id: string, how: { here: boolean } | { approvedBy: string }): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    // Google's terms for a personal plan: every message to Antigravity comes from the user's own press.
    if ("here" in how ? !how.here : !how.approvedBy) throw fail("On the phone, Run answers the PC's ask: tap Run on its card.", 403);
    // A second press on a task that is already starting or running (a hub card and the phone's ask both tapped): nothing more to start.
    if (t.status === "running" && this.active?.id === id) {
      delete t.runAsk;
      return t;
    }
    // Another task is running: this press is kept and the task starts by itself when that one ends (each task still
    // runs only from the user's own press; nothing runs that was not pressed).
    if (this.active && this.active.id !== id && !this.queue.some((q) => q.id === id)) {
      const wait = this.cannotRun(t, true);
      if (wait) throw fail(wait.msg, wait.code);
      this.queue.push({ id, how });
      delete t.runAsk;
      t.note = `Queued: starts by itself after the task now running (${this.queue.length} in line).`;
      await this.save();
      return t;
    }
    const no = this.cannotRun(t);
    if (no) throw fail(no.msg, no.code);
    // Drop the ask for good and show the task as started at once (the hub and the phone follow every save): the fetch
    // below can take a while, and until then the hub page would still list the task as "waiting for Run" and offer
    // Run (and the phone's "Run this?" ask) a second time.
    const before = { status: t.status, note: t.note };
    delete t.runAsk;
    t.status = "running";
    t.note = "Starting…";
    // The task holds the one run slot from now on (another press queues behind it, as for a running task).
    let end!: () => void;
    const active: Active = { id, done: new Promise<void>((r) => (end = r)) };
    this.active = active;
    await this.save();
    try {
      return await this.begin(t, active, end);
    } catch (e) {
      this.active = undefined;
      end();
      // It did not start: back to waiting, so it can be run again (with the reason as its note).
      t.status = before.status;
      if (before.note) t.note = before.note;
      else delete t.note;
      await this.save();
      throw e;
    }
  }

  /** The start of {@link run}: the worktree, the counters and the background work. */
  private async begin(t: InboxTaskView, active: Active, end: () => void): Promise<InboxTaskView> {
    const now = this.now();
    const today = this.today();
    // No "PC is busy" gate here: Antigravity works in Google's cloud, and the PC only fetches and writes a git
    // worktree, so a game, an open editor or a busy card doesn't hold it back (Roee, 2026-11-20). The busy rules
    // still hold back work that runs on this PC itself (the local model, self-work).
    const repo = this.repo();
    // Start from the newest base on GitHub (fetch only reads).
    await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin"], 60_000);
    const base = t.base.startsWith("origin/") ? `refs/remotes/${t.base}` : t.base;
    const attempt = (t.decisions?.length || t.startedAt) ? (Number(/-r(\d+)$/.exec(t.branch.replace(/-partial$/, ""))?.[1] ?? 1) + 1) : 1;
    const branch = `${branchFor(t, "antigravity")}${attempt > 1 ? `-r${attempt}` : ""}`;
    if (!validBranchName(branch)) throw fail("Bad branch name.", 400);
    const wt = await createSessionWorktree(repo, `agy-${t.id}-${attempt}`.slice(0, 60), this.gitStrict, { branch, base, copyIncluded: false });
    Object.assign(t, { status: "running" as InboxStatus, branch, startedAt: now, plan: [], steps: 0, decisions: [], checks: [], files: [], pushed: false, resultWritten: false });
    delete t.endedAt;
    delete t.note;
    delete t.summary;
    delete t.headSha;
    delete t.diff;
    today.used++;
    await this.save();
    this.d.notify("✦ Antigravity started", `${t.id}: ${t.title}`);
    void this.work(t, active, wt.path, wt.base, repo).finally(() => {
      this.active = undefined;
      end();
      void this.runNext();
    });
    return t;
  }

  /** The run itself: one prompt, the policy on each step, then KesherAI's own checks, commit and push. */
  private async work(t: InboxTaskView, a: Active, worktree: string, base: string, repo: string): Promise<void> {
    const s = this.s;
    // Packages for the checks (the project's own lockfile, from the store; no new ones).
    if (existsSync(join(worktree, "pnpm-lock.yaml"))) await this.d.run(worktree, ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], 10 * 60_000).catch(() => undefined);
    const ctx = { worktree, allowedPaths: t.allowedPaths, forbiddenPaths: t.forbiddenPaths, commands: s.commands, ...(t.kind === "research" ? { research: true } : {}) };
    const toolIds = new Set<string>();
    let text = "";
    let error = "";
    let stop = "";
    const handlers: AcpHandlers = {
      update: (u) => {
        if (u.kind === "plan") t.plan = u.entries.slice(0, 40).map((e) => ({ content: e.content.slice(0, 200), status: e.status }));
        else if (u.kind === "tool") {
          toolIds.add(u.id);
          t.steps = toolIds.size;
        } else if (u.kind === "text") text = (text + u.text).slice(-6000);
        void this.save();
      },
      permission: (p) => this.permission(t, a, p, ctx),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const agent = await this.d.startAgent(worktree, handlers);
      a.agent = agent;
      await agent.newSession(worktree);
      await agent.setMode("accept-edits").catch(() => false);
      const model = agent.options.find((o) => o.category === "model" || /model/i.test(o.id));
      const want = (t.model || s.model).trim().toLowerCase();
      const pick = want && model?.choices.find((c) => c.value.toLowerCase() === want || c.name.toLowerCase().includes(want));
      if (model && pick) await agent.setOption(model.id, pick.value).catch(() => undefined);
      const chosen = agent.options.find((o) => o.id === model?.id);
      t.modelUsed = chosen?.choices.find((c) => c.value === chosen.current)?.name ?? (chosen?.current || undefined);
      timer = setTimeout(() => {
        a.why = "time";
        void agent.cancel().catch(() => undefined);
      }, t.maxMinutes * 60_000);
      if (a.why !== "stop") stop = await agent.prompt(agentPrompt(t, t.branch));
      // A research agent sometimes gives up after one refused step and writes nothing: ask once more, in the same
      // session, for the report with what it has (two deep-research runs ended this way).
      const report = t.kind === "research" ? t.allowedPaths[0] : undefined;
      if (report && !a.why && stop === "end_turn" && !existsSync(join(worktree, report))) {
        stop = await agent.prompt(researchNudge(report));
      }
    } catch (e) {
      error = (e as Error).message || String(e);
    } finally {
      if (timer) clearTimeout(timer);
      a.agent?.close();
    }
    t.summary = text.trim().slice(-2000) || undefined;
    const quota = error && isQuotaError(error) ? quotaUntil(error, this.now()) : undefined;
    if (quota) this.saved.quota = { ...quota, taskId: t.id };
    const ok = !error && stop === "end_turn" && !a.why;
    const why = quota ? "Antigravity's quota ran out." : a.why === "stop" ? "Stopped by you." : a.why === "time" ? `Stopped at the ${t.maxMinutes}-minute limit.` : error ? `The agent failed: ${error.slice(0, 300)}` : stop !== "end_turn" ? `The agent ended with ${stop || "no answer"}.` : "";
    await this.finish(t, worktree, base, repo, ok, why, quota ? "deferred-quota" : undefined);
  }

  /** One permission request: the policy decides, or the user does (the task waits; denied after 30 minutes). */
  private async permission(t: InboxTaskView, a: Active, p: AcpPermission, ctx: Parameters<typeof decideStep>[1]): Promise<string | undefined> {
    const v = decideStep(p, ctx);
    const rec = { at: this.now(), verdict: v.verdict, what: v.what, rule: v.rule } as NonNullable<InboxTaskView["decisions"]>[number];
    t.decisions = [...(t.decisions ?? []), rec].slice(-60);
    if (v.verdict !== "ask") {
      void this.save();
      return optionFor(p, v.verdict === "allow" ? "allow" : "deny");
    }
    // One approval per task (the Run press): an unsure step is refused, not asked, unless the user wants step asks.
    if (a.why || !this.s.askSteps) {
      rec.answer = "deny";
      void this.save();
      return optionFor(p, "deny");
    }
    const ms = this.d.approvalMs ?? 30 * 60_000;
    const pending: InboxApprovalAsk = { requestId: `${t.id}-${t.decisions.length}`, what: v.what, ...(p.title ? { why: p.title.slice(0, 300) } : {}), where: t.branch, rule: v.rule, until: this.now() + ms };
    t.pending = pending;
    t.status = "needs-approval";
    await this.save();
    this.d.notify("🔔 Antigravity asks", `${t.id}: ${v.what}`);
    const answer = await new Promise<"allow" | "deny" | "timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      a.answer = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
    });
    a.answer = undefined;
    rec.answer = answer;
    delete t.pending;
    if (t.status === "needs-approval") t.status = "running";
    await this.save();
    return optionFor(p, answer === "allow" ? "allow" : "deny");
  }

  /**
   * The user's answer to an asked step.
   *
   * @param id - The task.
   * @param requestId - From its `pending`.
   * @param decision - Allow once or deny.
   */
  async answer(id: string, requestId: string, decision: "allow" | "deny"): Promise<boolean> {
    await this.load();
    const t = this.find(id);
    if (!this.active || this.active.id !== id || t.pending?.requestId !== requestId || !this.active.answer) return false;
    this.active.answer(decision === "allow" ? "allow" : "deny");
    return true;
  }

  /** Stops a running task: the agent's turn is cancelled, the work so far is kept as a `-partial` branch. */
  async stop(id: string): Promise<boolean> {
    await this.load();
    const a = this.active;
    if (!a || a.id !== id) return false;
    a.why = "stop";
    a.answer?.("deny");
    await a.agent?.cancel().catch(() => undefined);
    await a.done;
    return true;
  }

  /** Skips a waiting task (its board item is blocked with why). */
  async skip(id: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    if (isEnded(t.status) && t.status !== "deferred-quota" && t.status !== "failed") throw fail("It has already ended.", 409);
    t.status = "skipped";
    t.endedAt = this.now();
    t.note = "Skipped by you.";
    t.resultWritten = false;
    if (t.boardId) await this.d.board?.change("roee", [{ op: "block", id: t.boardId, result: "Skipped in the task inbox." }]).catch(() => undefined);
    await this.save();
    await this.writeResult(t).catch(() => undefined);
    await this.save();
    return t;
  }

  /** After the turn: KesherAI's own checks, commit, push of that one branch, the result file and the board. */
  private async finish(t: InboxTaskView, worktree: string, base: string, repo: string, ok: boolean, why: string, forced?: InboxStatus): Promise<void> {
    const git = (args: string[]) => this.d.git(worktree, args);
    const checks: InboxCheck[] = [];
    await git(["add", "-A"]);
    const numstat = await git(["diff", "--cached", "--numstat", base]);
    const files = numstat.out.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 };
    });
    t.files = files.slice(0, 200);
    const diff = (await git(["diff", "--cached", base])).out;
    t.diff = diff.slice(0, 60_000);
    const paths = checkPaths(files.map((f) => f.path), t);
    checks.push({ name: "paths", ok: !paths.outside.length && !paths.tooMany, note: paths.outside.length ? `outside the allowed paths: ${paths.outside.slice(0, 5).join(", ")}` : paths.tooMany ? `${files.length} files, more than ${t.maxFiles}` : `${files.length} files inside the allowed paths` });
    const found = scanDiff(diff, this.d.me);
    checks.push({ name: "secrets and privacy", ok: !found.length, note: found.length ? found.map((f) => `${f.kind} in ${f.file}`).slice(0, 5).join(", ") : "nothing found" });
    const version = changesVersion(diff);
    if (version) checks.push({ name: "version fields", ok: false, note: "a package.json version changed (releases are the lead's)" });
    const blocked = !!paths.outside.length || paths.tooMany || !!found.length || version;
    let tail = "";
    if (files.length && !blocked) {
      const parts = checkParts(t.check, this.s.commands);
      for (const r of parts.refused) checks.push({ name: "check", command: r, ok: false, note: "not on the allowed command list, so KesherAI did not run it" });
      for (const argv of parts.run.slice(0, 6)) {
        const r = await this.d.run(worktree, argv, 10 * 60_000).catch((e) => ({ code: 1, out: (e as Error).message }));
        const last = r.out.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 200);
        tail += `$ ${argv.join(" ")}\n${r.out.slice(-1500)}\n`;
        checks.push({ name: argv.slice(0, 3).join(" "), command: argv.join(" "), ok: r.code === 0, note: r.code === 0 ? last || "ok" : last || `exit ${r.code}` });
      }
    }
    t.checks = checks;
    const allOk = checks.every((c) => c.ok);
    let status: InboxStatus;
    if (blocked) status = "failed";
    else if (!files.length) status = forced ?? "failed";
    else status = forced ?? (ok && allOk ? "done" : "partial");
    if (status === "partial" || (status === "deferred-quota" && files.length)) {
      const partial = `${t.branch}-partial`;
      if (validBranchName(partial) && (await git(["branch", "-m", partial])).code === 0) t.branch = partial;
    }
    t.note = blocked ? `${why ? `${why} ` : ""}Not committed or pushed: ${checks.filter((c) => !c.ok).map((c) => c.note).join("; ")}. The work stays on this PC only (${t.branch}).` : why || (files.length ? undefined : "The agent changed no files.");
    if (!t.note) delete t.note;
    if (files.length && !blocked) {
      const msg = [`Inbox ${t.id}: ${t.title}`.slice(0, 120), "", `From the task inbox (${t.from}), run by Antigravity${t.modelUsed ? ` (${t.modelUsed})` : ""}; checked by KesherAI: ${checks.map((c) => `${c.name} ${c.ok ? "ok" : "failed"}`).join(", ")}.`, ...(status !== "done" ? [`Status: ${status}.`] : []), "", `Desktop-he: משימה מתיבת המשימות: ${t.title}`.slice(0, 200), `Phone-he: משימה מתיבת המשימות: ${t.title}`.slice(0, 200)].join("\n");
      const c = await git([...AUTHOR, "commit", "--quiet", "--no-verify", "-m", msg]);
      if (c.code === 0) {
        t.headSha = (await git(["rev-parse", "HEAD"])).out.trim().slice(0, 40);
        try {
          await pushRef(this.d.git, repo, t.branch, this.branch());
          t.pushed = true;
        } catch (e) {
          t.note = `${t.note ? `${t.note} ` : ""}${(e as Error).message.slice(0, 200)}`;
        }
      }
    }
    t.status = status;
    t.endedAt = this.now();
    delete t.pending;
    // The branch keeps the work; the folder goes (unless the work was blocked and is kept for a look).
    if (!blocked) await this.d.git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    await this.save();
    if (t.boardId && this.d.board) {
      const line = `${status}${t.pushed ? `: branch ${t.branch} (${(t.headSha ?? "").slice(0, 7)})` : ""}${t.note ? ` — ${t.note}` : ""}`.slice(0, 1000);
      await this.d.board.change("kesher", [status === "done" ? { op: "done", id: t.boardId, result: line } : status === "deferred-quota" ? { op: "note", text: line, task: t.boardId } : { op: "block", id: t.boardId, result: line }]).catch(() => undefined);
    }
    if (t.from !== "hub") await this.writeResult(t, tail).catch((e) => {
      this.saved.lastError = `Could not write the result: ${(e as Error).message.slice(0, 160)}`;
    });
    await this.save();
    const icon = status === "done" ? "✓" : status === "deferred-quota" ? "⏸" : status === "partial" ? "◐" : "✕";
    this.d.notify(`${icon} ${t.id} ${status}`, `${t.title}${t.pushed ? ` · ${t.branch}` : ""}`);
  }

  /**
   * Hands a task to another executor ("Who does it", and the quota card's "move to the local model" / "give back to
   * Claude"): it goes back in the queue for the new one, and its board item is opened again for it. A running task is
   * refused (the caller asks the user, then stops it first); a finished one only with `again` (the user said yes).
   *
   * @param id - The task.
   * @param to - The local model (self-work, through the board), Claude's Opus agent, or Antigravity (waits for Run).
   * @param o.again - Run a finished task again with the new executor (the user confirmed).
   */
  async reassign(id: string, to: "local" | "opus" | "antigravity", o: { again?: boolean } = {}): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    if ((t.status === "done" || t.status === "partial") && !o.again) throw fail("It is done.", 409);
    t.runBy = to;
    t.executor = to;
    t.status = to === "antigravity" ? "waiting" : "queued";
    t.branch = branchFor(t, to);
    delete t.endedAt;
    delete t.runAsk;
    t.resultWritten = false;
    t.note = to === "local" ? "Self-work takes it from the task board." : to === "opus" ? "Claude runs it with its own Opus agent." : "Antigravity runs it after your Run.";
    if (t.boardId) await this.d.board?.change("roee", [{ op: "reopen", id: t.boardId }, { op: "edit", id: t.boardId, size: to === "local" ? "small" : "big", forKesher: to === "local" }]).catch(() => undefined);
    await this.save();
    // Antigravity asks "Run this?" on the PC and the phone, as for a new task.
    if (to === "antigravity") this.makeAsk(t);
    return t;
  }

  /**
   * Marks a task as moved out of the inbox (to a chat's sub-agent): it ends here as skipped, with where it went.
   *
   * @param id - The task.
   * @param where - Where it went, in a few words.
   */
  async movedOut(id: string, where: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    t.status = "skipped";
    t.endedAt = this.now();
    t.note = `Moved: ${where}`.slice(0, 300);
    delete t.runAsk;
    if (t.boardId) await this.d.board?.change("roee", [{ op: "block", id: t.boardId, result: t.note }]).catch(() => undefined);
    await this.save();
    return t;
  }
}

/** Whether a status is an end. */
function isEnded(s: InboxStatus): boolean {
  return s === "done" || s === "partial" || s === "failed" || s === "declined" || s === "deferred-quota" || s === "skipped";
}

/**
 * The second prompt to a research agent that ended without writing its report.
 *
 * @param report - The report's path in the worktree.
 */
export function researchNudge(report: string): string {
  return [
    `You ended without writing the report file ${report}. Write it now.`,
    "A refused step is not a reason to stop: use your file tools (read, list, search) and web search instead of shell commands.",
    "Write everything you found so far, mark the parts you could not finish as \"not done\", and save the file before you end.",
  ].join("\n");
}
