/**
 * Runs the chat checks (scenarios.ts) on this computer through KesherAI's own chats: each scenario gets a fresh
 * temporary chat (incognito, except the past-chat search, which incognito chats cannot do) with the chosen model,
 * its fixtures, the message, and an auto-answer for approval cards that allows only the fixtures (fixtures.ts).
 * The finished turn is judged by its checks, then the chat, its folder and any seeded chat are deleted.
 * One run at a time; the last 10 runs are kept (in memory and, when given a file, on disk).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent } from "@kesher/shared";
import { judge } from "./checks.js";
import { fixtureDecision, listFixtureFiles, startFixtureServer, writeFixtureFiles, type FixtureServer } from "./fixtures.js";
import { pickScenarios, type Scenario } from "./scenarios.js";

/** What the runner needs from KesherAI (the conversation manager in the app, a fake in tests). */
export interface ChatCheckHost {
  /** The chat model used when the run names none (Settings › Models' default), or undefined when none is chosen. */
  defaultModel(): string | undefined;
  /** Creates a temporary chat for one scenario. @returns Its id and its folder (where its files go). */
  createChat(o: { title: string; model: string; incognito: boolean }): Promise<{ id: string; folder: string }>;
  /** Whether the chat has `tool` (and, with `option`, that input option). */
  hasTool(chatId: string, tool: string, option?: string): Promise<boolean>;
  /** Follows the chat's events. @returns A function that stops following. */
  watch(chatId: string, onEvent: (e: AgentEvent) => void): Promise<() => void>;
  /** Sends the user's message (may resolve only when the turn ends). */
  send(chatId: string, text: string): Promise<unknown>;
  approve(chatId: string, requestId: string, decision: "allow" | "deny", feedback?: string): void;
  answer(chatId: string, questionId: string, text: string): void;
  stop(chatId: string): void;
  /** Deletes a chat with its folder and anything it scheduled. */
  deleteChat(chatId: string): Promise<void>;
  /** Saves a past chat for the search scenario. @returns Its id. */
  seedChat(title: string, messages: Array<{ role: "user" | "assistant"; text: string; at: string }>): Promise<string>;
}

/** One scenario's outcome in a run. */
export interface ChatCheckResult {
  id: string;
  he: string;
  en: string;
  state: "pending" | "running" | "pass" | "fail" | "skip";
  /** The failing check's id. */
  check?: string;
  /** Why it failed or was skipped (English, short). */
  reason?: string;
  /** How long it took, in milliseconds. */
  ms?: number;
}

/** One run of the chat checks. */
export interface ChatCheckRun {
  id: string;
  model: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Why the whole run failed (e.g. the fixture server did not start). */
  error?: string;
  results: ChatCheckResult[];
}

/** How many runs are kept. */
const KEEP = 10;
/** Default time limit per scenario (a big local model on a cold start is slow). */
const DEFAULT_LIMIT_SEC = 240;
/** The answer to a model's question when the scenario does not stop on it. */
const NO_PREFERENCE = "No preference: choose what you think is best and continue.";

/** @returns A run id like `cc-20261128-0955-a1b2`. */
function runId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `cc-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${randomBytes(2).toString("hex")}`;
}

/** Runs and keeps the chat checks. */
export class ChatChecks {
  private runs: ChatCheckRun[] = [];
  private loaded = false;
  private current: { run: ChatCheckRun; stop: boolean } | undefined;

  /**
   * @param host - KesherAI's chats.
   * @param file - Where the last runs are saved (optional).
   * @param startServer - Starts the fixture server (replaced in tests).
   */
  constructor(
    private readonly host: ChatCheckHost,
    private readonly file?: string,
    private readonly startServer: () => Promise<FixtureServer> = () => startFixtureServer(),
  ) {}

  private async load(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { runs?: ChatCheckRun[] };
      // A run that was going when KesherAI stopped did not finish.
      this.runs = (saved.runs ?? []).slice(0, KEEP).map((r) => (r.state === "running" ? { ...r, state: "failed", error: "KesherAI stopped during the run." } : r));
    } catch {
      this.runs = [];
    }
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    // Written beside it and renamed, so a reader never sees half a file.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ runs: this.runs }, null, 1), "utf8")
      .then(() => rename(tmp, this.file!))
      .catch(() => undefined);
  }

  /** @returns The last runs, newest first. */
  async list(): Promise<ChatCheckRun[]> {
    await this.load();
    return this.runs;
  }

  /** @returns One run, or undefined. */
  async get(id: string): Promise<ChatCheckRun | undefined> {
    await this.load();
    return this.runs.find((r) => r.id === id);
  }

  /** @returns The chat model a run uses when it names none (undefined when none is chosen). */
  defaultModel(): string | undefined {
    return this.host.defaultModel();
  }

  /** @returns The id of the run that is going now, if any. */
  running(): string | undefined {
    return this.current?.run.id;
  }

  /** Stops the run that is going after its current scenario (that one is stopped too). */
  cancel(): boolean {
    if (!this.current) return false;
    this.current.stop = true;
    return true;
  }

  /**
   * Starts a run in the background.
   *
   * @param o - Scenario ids (all when empty) and the model (the default chat model when unset).
   * @returns The new run's id.
   * @throws Error when a run is going, no chat model is chosen, or an id is unknown.
   */
  async start(o: { ids?: string[]; model?: string } = {}): Promise<string> {
    await this.load();
    if (this.current) throw new Error("Chat checks are already running.");
    const scenarios = pickScenarios(o.ids);
    const model = o.model?.trim() || this.host.defaultModel();
    if (!model) throw new Error("Choose a chat model first.");
    const run: ChatCheckRun = {
      id: runId(new Date()),
      model,
      state: "running",
      startedAt: new Date().toISOString(),
      results: scenarios.map((s) => ({ id: s.id, he: s.he, en: s.en, state: "pending" })),
    };
    this.runs = [run, ...this.runs].slice(0, KEEP);
    this.current = { run, stop: false };
    await this.save();
    void this.go(run, scenarios);
    return run.id;
  }

  /** Runs the scenarios one after another. */
  private async go(run: ChatCheckRun, scenarios: Scenario[]): Promise<void> {
    let server: FixtureServer | undefined;
    try {
      if (scenarios.some((s) => s.web)) server = await this.startServer();
      for (const [i, s] of scenarios.entries()) {
        const result = run.results[i]!;
        if (this.current?.stop) {
          Object.assign(result, { state: "skip", reason: "the run was stopped" });
          continue;
        }
        result.state = "running";
        const t0 = Date.now();
        Object.assign(result, await this.one(s, run.model, server).catch((e: Error) => ({ state: "fail" as const, check: "run", reason: e.message })), { ms: Date.now() - t0 });
        await this.save();
      }
      run.state = "done";
    } catch (e) {
      run.state = "failed";
      run.error = (e as Error).message;
    } finally {
      await server?.close().catch(() => undefined);
      run.finishedAt = new Date().toISOString();
      await this.save();
      this.current = undefined;
    }
  }

  /** Runs one scenario in its own chat and judges it. */
  private async one(s: Scenario, model: string, server: FixtureServer | undefined): Promise<Pick<ChatCheckResult, "state" | "check" | "reason">> {
    const h = this.host;
    const chat = await h.createChat({ title: `[Chat check] ${s.en}`, model, incognito: !s.pastChat && !s.normalChat });
    let seeded: string | undefined;
    let unwatch: (() => void) | undefined;
    try {
      if (s.needs && !(await h.hasTool(chat.id, s.needs.tool, s.needs.option))) {
        return { state: "skip", reason: `${s.needs.tool} has no ${s.needs.option ?? "such"} option yet` };
      }
      if (s.web && !server) throw new Error("the fixture server is not running");
      if (s.files) await writeFixtureFiles(chat.folder, s.files);
      if (s.pastChat) {
        const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
        seeded = await h.seedChat(s.pastChat.title, s.pastChat.messages.map((m) => ({ ...m, at: yesterday })));
      }
      const scope = { ...(s.web && server ? { origin: server.origin } : {}), folder: chat.folder, ...(s.commands ? { commands: s.commands } : {}) };
      const events: AgentEvent[] = [];
      let userSeq = Infinity;
      /** Whether the turn was seen working (a non-idle status) after the user's message: an idle before it is the old turn's. */
      let busy = false;
      let ended: (why?: string) => void = () => undefined;
      const done = new Promise<string | undefined>((ok) => (ended = ok));
      unwatch = await h.watch(chat.id, (e) => {
        events.push(e);
        if (e.type === "user" && userSeq === Infinity) userSeq = e.seq;
        else if (e.type === "approval_request") {
          const d = fixtureDecision(e, scope);
          h.approve(chat.id, e.requestId, d.decision, d.decision === "deny" ? d.why : undefined);
        } else if (e.type === "question") {
          if (e.kind === "signin") h.answer(chat.id, e.questionId, "cancel");
          else if (e.kind === "access") h.answer(chat.id, e.questionId, "");
          else if (s.stopOnQuestion) h.stop(chat.id);
          else h.answer(chat.id, e.questionId, NO_PREFERENCE);
        } else if (e.type === "status" && userSeq !== Infinity && e.status !== "idle" && e.status !== "error") {
          busy = true;
        } else if (e.type === "status" && userSeq !== Infinity && (!e.seq || e.seq > userSeq) && (e.status === "error" || (e.status === "idle" && (busy || events.some((x) => x.type === "assistant" && (x.seq === undefined || x.seq > userSeq)))))) {
          // Live status events carry seq 0 (only saved events get a real one): "after the user's message" is "after we saw it",
          // and idle counts once the turn was seen working or has answered.
          ended(e.status === "error" ? `the turn ended with an error${e.message ? `: ${e.message}` : ""}` : undefined);
        }
      });
      const limit = (s.limitSec ?? DEFAULT_LIMIT_SEC) * 1000;
      const timer = setTimeout(() => ended(`took longer than ${limit / 1000} s`), limit);
      const stopper = setInterval(() => {
        if (this.current?.stop) ended("the run was stopped");
      }, 1000);
      void h.send(chat.id, s.message({ url: (p) => (server ? server.url(p) : p) })).catch((e: Error) => ended(`could not send: ${e.message}`));
      const failure = await done;
      clearTimeout(timer);
      clearInterval(stopper);
      if (failure) {
        h.stop(chat.id);
        return { state: "fail", check: "turn", reason: failure };
      }
      const turn = { events: events.filter((e) => e.seq >= userSeq), files: await listFixtureFiles(chat.folder) };
      const bad = judge(s.checks, turn);
      return bad ? { state: "fail", ...bad } : { state: "pass" };
    } finally {
      unwatch?.();
      await h.deleteChat(chat.id).catch(() => undefined);
      if (seeded) await h.deleteChat(seeded).catch(() => undefined);
    }
  }
}
