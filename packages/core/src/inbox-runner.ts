import { randomBytes } from "node:crypto";
import { AGENT_GIT_IDENTITY } from "@kesher/agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { InboxApprovalAsk, InboxBusy, InboxRunAsk, InboxCheck, InboxSettings, InboxState, InboxStatus, InboxTaskSpec, InboxTaskView } from "@kesher/shared";
import type { AcpAgent, AcpHandlers, AcpPermission } from "./acp.js";
import { optionFor } from "./acp-chat.js";
import { changesVersion, checkPaths, decideStep, scanDiff } from "./inbox-policy.js";
import { createSessionWorktree, excludeWorktrees, type Git } from "./session-worktrees.js";
import type { TaskBoard } from "./task-board.js";
import { agentPrompt, branchFor, checkParts, INBOX_DEFAULTS, parseTaskFile, pushRef, resultFileText, routeTask, slugOf, taskFileText, validBranchName, validTaskId } from "./task-inbox.js";

/**
 * The task inbox on the PC (docs/RESEARCH_LOG.md, "A task inbox", plan steps 2, 4 and 6): fetches the `kesher-inbox`
 * branch, puts each new task in the queue and on the shared task board, and runs an Antigravity task **only when the
 * user presses Run on this computer**, one task per press, one prompt per task, never in parallel (Roee's decision and
 * Google's terms for a personal plan; see the 2026-11-19 terms entry). The agent works in its own worktree with no
 * secrets; KesherAI answers its permission requests by the inbox policy, then checks the work itself (paths, secrets
 * and privacy, version fields, the allowed check commands), commits it, and pushes only that `agy/*` branch and the
 * result file on the inbox branch. Local-model tasks go to self-work through the board; Opus tasks stay for Claude.
 */

/** Runs git or a check: arguments as a list, never through a shell. */
export type RunCmd = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** What the inbox needs from KesherAI (injected, so it can be tested with a local bare repo and a fake agent). */
export interface TaskInboxDeps {
  /** Settings > Task inbox (already filled with defaults). */
  settings: () => Partial<InboxSettings>;
  /** Where the queue is kept (KesherAI's data folder). */
  file: string;
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

/** Whether an agent's error is its plan's quota or rate limit. */
export function isQuotaError(msg: string): boolean {
  return /quota|rate.?limit|resource.?exhausted|\b429\b|usage limit|limit reached|exceeded your/i.test(msg);
}

/** The queue, its runs and the inbox branch. */
export class TaskInbox {
  private saved: Saved = { tasks: [], today: { date: "", used: 0 } };
  private loaded = false;
  private active?: Active;
  private timer?: ReturnType<typeof setInterval>;
  /** Asks for one message to Antigravity from a chat's agent (kept in memory: a restart drops them, nothing runs). */
  private readonly messageAsks = new Map<string, { ask: InboxRunAsk; info: MessageAskInfo; done: (a: "allow" | "deny" | "timeout") => void }>();
  private saving: Promise<void> = Promise.resolve();
  private syncing?: Promise<void>;

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
      this.saved = { tasks: Array.isArray(raw.tasks) ? raw.tasks : [], today: raw.today ?? { date: "", used: 0 }, ...(raw.quota ? { quota: raw.quota } : {}), ...(raw.lastFetch ? { lastFetch: raw.lastFetch } : {}) };
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
      this.saved.lastError = /couldn't find remote ref|not found/i.test(fetched.out) ? undefined : `git fetch: ${fetched.out.slice(0, 200)}`;
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
      status: runBy === "antigravity" ? "waiting" : "queued",
      ...(runBy === "opus" ? { note: "Claude runs it with its own Opus agent." } : runBy === "local" ? { note: "Self-work takes it from the task board." } : {}),
    };
    if (boardId) t.boardId = boardId;
    else if (this.d.board) {
      const b = await this.d.board.change("claude", [{ op: "add", title: `[Inbox ${spec.id}] ${spec.title}`, details: [`From the task inbox (tasks/${spec.id}.md on ${this.s.branch}).`, `Executor: ${runBy}${runBy === "antigravity" ? " (waits for Run on the PC)" : ""}.`, `Branch: ${t.branch}`].join("\n"), size: runBy === "local" ? "small" : "big" }]).catch(() => undefined);
      const added = b?.tasks.at(-1);
      if (added) {
        t.boardId = added.id;
        if (runBy === "local") await this.d.board.change("roee", [{ op: "edit", id: added.id, forKesher: true }]).catch(() => undefined);
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
   * A task the user writes in the app ("+ Task", also from the phone): added to the queue and written to the inbox
   * branch so Claude sees it too.
   *
   * @param input - Title, goal and the rest; paths and limits default to Settings.
   */
  async add(input: { title: string; goal: string; executor?: string; risk?: string; check?: string; acceptance?: string }): Promise<InboxTaskView> {
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
    const spec: InboxTaskSpec = { id: `r-${day}-${String(n).padStart(2, "0")}`, title, executor, risk, from: "roee", base: "origin/main", allowedPaths: [...s.allowedPaths], forbiddenPaths: [...s.forbiddenPaths], check: String(input.check ?? "").trim().slice(0, 300), maxMinutes: s.maxMinutes, maxFiles: 15, goal, ...(input.acceptance?.trim() ? { acceptance: input.acceptance.trim().slice(0, 3000) } : {}) };
    // The same checks as a file from git (the text is data either way).
    const parsed = parseTaskFile(taskFileText(spec), spec.id, s);
    if ("error" in parsed) throw fail(parsed.error, 400);
    const t = await this.enqueue(parsed.spec);
    await this.save();
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
  private cannotRun(t: InboxTaskView): { msg: string; code: number } | undefined {
    const s = this.s;
    if (!s.enabled) return { msg: "The inbox is off (Settings > Task inbox).", code: 409 };
    if (s.paused) return { msg: "The inbox is paused.", code: 409 };
    if (t.runBy !== "antigravity") return { msg: t.runBy === "local" ? "Self-work runs this task from the board." : "Claude runs this task.", code: 409 };
    if (this.active) return { msg: "Another task is running. One at a time.", code: 409 };
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
   * the PC's ask (see {@link answerRun}); one at a time, within the daily cap and the quota, when the PC is not busy.
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
    const no = this.cannotRun(t);
    if (no) throw fail(no.msg, no.code);
    delete t.runAsk;
    const now = this.now();
    const today = this.today();
    const busy = await this.d.busy();
    if (!busy.free) throw fail(`The PC is busy: ${busy.reasons.join(", ")}.`, 409);
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
    let end!: () => void;
    const active: Active = { id, done: new Promise<void>((r) => (end = r)) };
    this.active = active;
    void this.work(t, active, wt.path, wt.base, repo).finally(() => {
      this.active = undefined;
      end();
    });
    return t;
  }

  /** The run itself: one prompt, the policy on each step, then KesherAI's own checks, commit and push. */
  private async work(t: InboxTaskView, a: Active, worktree: string, base: string, repo: string): Promise<void> {
    const s = this.s;
    // Packages for the checks (the project's own lockfile, from the store; no new ones).
    if (existsSync(join(worktree, "pnpm-lock.yaml"))) await this.d.run(worktree, ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], 10 * 60_000).catch(() => undefined);
    const ctx = { worktree, allowedPaths: t.allowedPaths, forbiddenPaths: t.forbiddenPaths, commands: s.commands };
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
    if (a.why) return optionFor(p, "deny");
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
   * Hands a quota-stopped Antigravity task to another executor (the quota card: "move to the local model", "give back
   * to Claude").
   *
   * @param id - The task.
   * @param to - The local model (self-work, through the board) or Claude's Opus agent.
   */
  async reassign(id: string, to: "local" | "opus"): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    if (t.status === "done") throw fail("It is done.", 409);
    t.runBy = to;
    t.executor = to;
    t.status = "queued";
    t.branch = branchFor(t, to);
    t.note = to === "local" ? "Self-work takes it from the task board." : "Claude runs it with its own Opus agent.";
    if (t.boardId) await this.d.board?.change("roee", [{ op: "reopen", id: t.boardId }, { op: "edit", id: t.boardId, size: to === "local" ? "small" : "big", forKesher: to === "local" }]).catch(() => undefined);
    await this.save();
    return t;
  }
}

/** Whether a status is an end. */
function isEnded(s: InboxStatus): boolean {
  return s === "done" || s === "partial" || s === "failed" || s === "declined" || s === "deferred-quota" || s === "skipped";
}
