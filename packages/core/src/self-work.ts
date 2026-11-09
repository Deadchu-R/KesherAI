import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Self-work: KesherAI works on a git project by itself (its own code, on the
 * user's computer) for hours, the way background coding agents do (Codex,
 * OpenHands, Cursor): on its own branch, one item at a time, a plan file the
 * user can read and edit, the project's checks after every item, a commit only
 * when they pass, a phone notification per item, and hard stop rules (goal met,
 * blocked, repeated failures, time or step budget). It never pushes, merges or
 * touches other branches; git push and history rewrites always ask the user.
 */

/** One run's settings. */
export interface SelfWorkStart {
  /** The git project folder on this computer. */
  repo: string;
  /** What to do, in the user's words. */
  goal: string;
  /** Stop after this many hours (0.25–12). */
  hours?: number;
  /** Run after every item, e.g. "pnpm test"; empty = no check. */
  check?: string;
  modelId?: string;
}

/** What a run did, for the page and the phone. */
export interface SelfWorkState {
  id: string;
  repo: string;
  goal: string;
  branch: string;
  /** The separate working folder (a git worktree) the run works in; the user's own checkout is not touched. */
  worktree: string;
  check: string;
  modelId?: string;
  convId: string;
  status: "running" | "waiting" | "done" | "blocked" | "stopped" | "failed";
  startedAt: number;
  until: number;
  steps: number;
  /** Items finished and committed. */
  items: Array<{ at: number; text: string; commit?: string }>;
  /** Why it ended, or what it waits for. */
  note?: string;
  failures: number;
}

/** What self-work needs from KesherAI (injected, so it can be tested). */
export interface SelfWorkDeps {
  /** Starts a code chat in the folder (auto-approve file edits and safe commands); `extra`: more folders it may read (the task board and handoff). */
  createChat: (folder: string, title: string, modelId?: string, extra?: string[]) => Promise<string>;
  send: (convId: string, text: string) => Promise<void>;
  /** The chat's state and its last answer. */
  state: (convId: string) => Promise<{ status: string; last: string }>;
  /** Runs git (arguments as a list, no shell). */
  git: (repo: string, args: string[]) => Promise<{ code: number; out: string }>;
  /** Runs the check command in the folder. */
  check: (repo: string, command: string) => Promise<{ code: number; out: string }>;
  notify: (title: string, body: string, link: string) => Promise<void>;
  /** Waits (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
  /** The folder with the shared task board and the handoff notes (board.json, handoff.md), if any. */
  shared?: string;
}

const MAX_STEPS = 80;
const MAX_FAILURES = 3;
/** How long one item may run, and how long an approval may wait. */
const STEP_MS = 45 * 60_000;
const WAIT_MS = 30 * 60_000;

/** The rules the model gets with the goal. */
export function selfWorkBrief(s: Pick<SelfWorkState, "goal" | "branch" | "check">, hours: number, shared?: string): string {
  return [
    `Self-work mode: you work on this project by yourself for up to ${hours} hours, in a separate copy of it (a git worktree) on the branch ${s.branch}; KesherAI commits for you. The user's own copy and the running app are not touched.`,
    `The goal: ${s.goal}`,
    ...(shared ? ["", `First read ${shared}/handoff.md (the project's rules, the owner's preferences, the priority list) and the task_board (read). Work only on tasks you claimed on the board; Claude works on the same board, so never take a task Claude claimed, and mark yours done with the commit and how you tested it.`] : []),
    "",
    "How to work:",
    "1. First write .kesher-self/plan.md: a checklist (- [ ] item) of small, separate items that reach the goal, plus Decisions and Blockers sections. Keep it up to date: it is how the user follows you.",
    "2. Each turn do ONE item: read the code you need, change it, run check_code, mark it - [x] in the plan.",
    `3. End every turn with one line: "ITEM DONE: <the item>", or "ALL DONE" when the goal is met, or "BLOCKED: <why>" when you need the user (a decision, a password, an approval).${s.check ? ` After ITEM DONE KesherAI runs \`${s.check}\`; if it fails you get its output to fix first.` : ""}`,
    "4. Never push, merge, switch branches, rewrite history or delete files you did not create. Do not install programs. Stay inside this project.",
    "5. Small and safe beats big: if an item is too large, split it in the plan.",
  ].join("\n");
}

/** Reads the model's last line: ITEM DONE / ALL DONE / BLOCKED. */
export function readOutcome(text: string): { kind: "item" | "all" | "blocked" | "none"; text: string } {
  const lines = text.trim().split("\n").map((l) => l.replace(/^[\s*_>`#-]+|[\s*_`]+$/g, "")).reverse();
  for (const l of lines.slice(0, 6)) {
    let m = /^ALL DONE\b[:.\s-]*(.*)$/i.exec(l);
    if (m) return { kind: "all", text: m[1]!.trim() };
    m = /^BLOCKED\b[:.\s-]*(.*)$/i.exec(l);
    if (m) return { kind: "blocked", text: m[1]!.trim() || "No reason given." };
    m = /^ITEM DONE\b[:.\s-]*(.*)$/i.exec(l);
    if (m) return { kind: "item", text: m[1]!.trim() || "An item" };
  }
  return { kind: "none", text: "" };
}

/** Runs self-work, one run at a time, kept in a file so a restart can continue it. */
export class SelfWork {
  private run_?: SelfWorkState;
  private stopRequested = false;
  private loop?: Promise<void>;

  /**
   * @param file - Where the run is kept (KesherAI's data folder).
   * @param d - What self-work needs from KesherAI.
   */
  constructor(
    private readonly file: string,
    private readonly d: SelfWorkDeps,
  ) {}

  /** The current or last run. */
  get current(): SelfWorkState | undefined {
    return this.run_;
  }

  /** Loads the last run; one that was working when KesherAI closed carries on. */
  async load(): Promise<void> {
    const raw = await readFile(this.file, "utf8").catch(() => "");
    if (!raw) return;
    try {
      this.run_ = JSON.parse(raw) as SelfWorkState;
    } catch {
      return;
    }
    if ((this.run_.status === "running" || this.run_.status === "waiting") && Date.now() < this.run_.until) {
      this.loop = this.work(false);
    } else if (this.run_.status === "running" || this.run_.status === "waiting") {
      this.run_.status = "stopped";
      this.run_.note = "KesherAI was closed past the time limit.";
      await this.save();
    }
  }

  /**
   * Starts a run: checks the folder is a git project, makes its own working folder (a git worktree) on a new branch, opens the chat and sends the goal.
   */
  async start(o: SelfWorkStart): Promise<SelfWorkState> {
    if (this.run_ && (this.run_.status === "running" || this.run_.status === "waiting")) throw new Error("Self-work is already running. Stop it first.");
    const goal = o.goal.trim().slice(0, 4000);
    if (!goal) throw new Error("Say what to work on.");
    if (!existsSync(join(o.repo, ".git"))) throw new Error("That folder is not a git project (no .git folder).");
    const head = await this.d.git(o.repo, ["rev-parse", "--verify", "HEAD"]);
    if (head.code !== 0) throw new Error(`git could not read the project: ${head.out.slice(0, 300)}`);
    const hours = Math.min(12, Math.max(0.25, Number(o.hours ?? 2) || 2));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const branch = `kesher-self/${stamp}`;
    // A separate working folder next to the project: the user's checkout (and the running app) stay as they are.
    const worktree = join(dirname(o.repo), `${basename(o.repo)}-self-work`, stamp);
    const made = await this.d.git(o.repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
    if (made.code !== 0) throw new Error(`Could not make the work folder for ${branch}: ${made.out.slice(0, 300)}`);
    const check = (o.check ?? "").trim().slice(0, 300);
    const convId = await this.d.createChat(worktree, `🤖 Self-work · ${goal.slice(0, 50)}`, o.modelId, this.d.shared ? [this.d.shared] : []);
    this.run_ = { id: stamp, repo: o.repo, goal, branch, worktree, check, ...(o.modelId ? { modelId: o.modelId } : {}), convId, status: "running", startedAt: Date.now(), until: Date.now() + hours * 3_600_000, steps: 0, items: [], failures: 0 };
    this.stopRequested = false;
    await this.save();
    await this.d.send(convId, selfWorkBrief(this.run_, hours, this.d.shared));
    await this.d.notify("🤖 Self-work started", `${goal.slice(0, 120)} (branch ${branch}, up to ${hours} h, in ${worktree})`, `#/c/${convId}`);
    this.loop = this.work(true);
    return this.run_;
  }

  /** Asks the run to stop after the current step (the chat is stopped too by the caller). */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.run_ && (this.run_.status === "running" || this.run_.status === "waiting")) await this.end("stopped", "Stopped by you.");
  }

  /** For tests: waits until the loop ends. */
  async settled(): Promise<void> {
    await this.loop;
  }

  private async save(): Promise<void> {
    if (this.run_) await writeFile(this.file, JSON.stringify(this.run_, null, 2)).catch(() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private async end(status: SelfWorkState["status"], note: string): Promise<void> {
    const r = this.run_;
    if (!r || (r.status !== "running" && r.status !== "waiting")) return;
    r.status = status;
    r.note = note;
    await this.save();
    const title = status === "done" ? "✅ Self-work finished" : status === "blocked" ? "✋ Self-work needs you" : "⏹ Self-work stopped";
    await this.d.notify(title, `${note} ${r.items.length} item(s) committed on ${r.branch}.`, `#/c/${r.convId}`);
  }

  /** Waits for the chat to finish its turn. */
  private async turn(): Promise<{ status: string; last: string } | undefined> {
    const r = this.run_!;
    const end = Date.now() + STEP_MS;
    let waitingSince = 0;
    for (;;) {
      await this.sleep(2000);
      if (this.stopRequested) return undefined;
      const st = await this.d.state(r.convId);
      if (st.status === "waiting") {
        if (!waitingSince) {
          waitingSince = Date.now();
          r.status = "waiting";
          r.note = "Waiting for your approval in the chat.";
          await this.save();
          await this.d.notify("✋ Self-work waits for your approval", r.goal.slice(0, 120), `#/c/${r.convId}`);
        } else if (Date.now() - waitingSince > WAIT_MS) {
          await this.end("blocked", "An approval waited more than 30 minutes.");
          return undefined;
        }
        continue;
      }
      if (waitingSince) {
        waitingSince = 0;
        r.status = "running";
        delete r.note;
        await this.save();
      }
      if (st.status !== "running") return st;
      if (Date.now() > end) {
        await this.end("blocked", "One item ran for 45 minutes without finishing.");
        return undefined;
      }
    }
  }

  /** The loop: a turn, its outcome, the check, a commit, the next turn. */
  private async work(fresh: boolean): Promise<void> {
    const r = this.run_!;
    if (!fresh) await this.d.send(r.convId, "KesherAI restarted. Read .kesher-self/plan.md and continue with the next item (end with ITEM DONE / ALL DONE / BLOCKED).").catch(() => undefined);
    try {
      while (!this.stopRequested) {
        if (Date.now() > r.until) return await this.end("stopped", "The time limit was reached.");
        if (r.steps >= MAX_STEPS) return await this.end("stopped", `Stopped after ${MAX_STEPS} turns.`);
        const st = await this.turn();
        if (!st) return;
        r.steps++;
        if (st.status === "error") {
          r.failures++;
          if (r.failures >= MAX_FAILURES) return await this.end("failed", "The model stopped with errors 3 times in a row.");
          await this.d.send(r.convId, "The last turn ended with an error. Continue with the current item.");
          continue;
        }
        const out = readOutcome(st.last);
        if (out.kind === "blocked") return await this.end("blocked", out.text);
        if (out.kind === "none") {
          r.failures++;
          if (r.failures >= MAX_FAILURES) return await this.end("blocked", "The model did not say what it finished 3 times in a row.");
          await this.d.send(r.convId, "End your turn with one line: ITEM DONE: <item>, ALL DONE, or BLOCKED: <why>. If the item is not finished, finish it first.");
          continue;
        }
        if (r.check) {
          const c = await this.d.check(r.worktree ?? r.repo, r.check);
          if (c.code !== 0) {
            r.failures++;
            await this.save();
            if (r.failures >= MAX_FAILURES) return await this.end("blocked", `\`${r.check}\` failed 3 times in a row.`);
            await this.d.send(r.convId, `\`${r.check}\` failed after your change. Fix it before the next item (end with ITEM DONE again):\n${c.out.slice(-3000)}`);
            continue;
          }
        }
        r.failures = 0;
        const label = out.text || "Plan";
        await this.d.git(r.worktree ?? r.repo, ["add", "-A"]);
        const committed = await this.d.git(r.worktree ?? r.repo, ["commit", "-m", `self-work: ${label.slice(0, 150)}`, "-m", `Goal: ${r.goal.slice(0, 500)}`]);
        const sha = committed.code === 0 ? (await this.d.git(r.worktree ?? r.repo, ["rev-parse", "--short", "HEAD"])).out.trim() : undefined;
        if (out.kind === "item" || sha) {
          r.items.push({ at: Date.now(), text: label, ...(sha ? { commit: sha } : {}) });
          await this.save();
          await this.d.notify(`🤖 ${label.slice(0, 80)}`, `Self-work: item ${r.items.length}${sha ? ` (${sha})` : ""}. ${r.goal.slice(0, 80)}`, `#/c/${r.convId}`);
        }
        if (out.kind === "all") return await this.end("done", out.text || "The goal is met.");
        await this.d.send(r.convId, "Next item from .kesher-self/plan.md (end with ITEM DONE / ALL DONE / BLOCKED).");
      }
    } catch (e) {
      await this.end("failed", (e as Error).message);
    }
  }
}
