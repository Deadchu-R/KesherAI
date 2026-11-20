/**
 * The Claude chat's agent reports, without the network: where the pairing is kept, and how one command (`start`,
 * `step`, `done`, `failed`) changes a run's state and adds its events. The CLI (`hub-report.ts`) seals what this
 * returns to every paired phone (the hub page and the phone's Cloud tab), the same `agent_event` the PC sends.
 *
 * Privacy: only titles, short labels and summaries the lead writes go out, cleaned by the share scrubber (local
 * paths, keys and tokens are hidden). Never a prompt, a file's content or an agent's output.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HUB_LIMITS, isHubId, type ActivityEvent, type AgentRunState } from "../../packages/shared/src/hub.js";
import { cleanForShare } from "../../packages/core/src/shares.js";

/** What kind of helper agent a run is (shown as an icon before its title). */
export type ChatAgentKind = "research" | "build" | "lookup";

/** The kinds, with the icon each title starts with (language-neutral, so the title stays the lead's own words). */
export const KIND_ICON: Record<ChatAgentKind, string> = { research: "🔎", build: "🔨", lookup: "📖" };

/** One run as this chat remembers it between commands. */
export interface ChatRun {
  state: AgentRunState;
  /** The last event number used. */
  seq: number;
  /** Events not delivered yet (sent with the next batch; the state alone always draws the card). */
  unsent: ActivityEvent[];
}

/** The pairing file (`~/.kesher-hub/claude-chat.json`, mode 600; never in the repo). */
export interface ChatConfig {
  /** The hub's address (origin and path, no trailing slash). */
  url?: string;
  deviceId?: string;
  /** The device token (Bearer). Secret. */
  token?: string;
  /** This chat's ECDH private key as JWK text. Secret. */
  privateJwk?: string;
  /** A pairing in progress: polled until approved on the hub's Devices screen. */
  pending?: { url: string; pollSecret: string; code: string; fingerprint: string; expiresAt: number };
  /** Runs by id (ended ones are kept a day, at most 50). */
  runs: Record<string, ChatRun>;
}

/** The folder of the pairing file (`KESHER_HUB_HOME` overrides it, for tests). */
export const configDir = (): string => process.env.KESHER_HUB_HOME || join(homedir(), ".kesher-hub");

/** The pairing file's path. */
export const configPath = (): string => join(configDir(), "claude-chat.json");

/**
 * Reads the pairing file.
 *
 * @returns The config (empty when there is none yet).
 */
export async function loadConfig(): Promise<ChatConfig> {
  try {
    const c = JSON.parse(await readFile(configPath(), "utf8")) as ChatConfig;
    return { ...c, runs: c.runs && typeof c.runs === "object" ? c.runs : {} };
  } catch {
    return { runs: {} };
  }
}

/**
 * Writes the pairing file: the folder only for this user (700), the file too (600), replaced in one step.
 *
 * @param c - The config.
 */
export async function saveConfig(c: ChatConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configPath()}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, configPath());
}

/**
 * Cleans text a run reports: local paths, keys and tokens hidden (the share scrubber), one line, capped.
 *
 * @param text - What the lead wrote.
 * @param max - The most characters kept.
 * @returns The clean text.
 */
export function scrub(text: string, max: number): string {
  const t = cleanForShare(String(text ?? "")).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One command of the CLI, as {@link applyCommand} takes it. */
export type ChatCommand =
  | { cmd: "start"; kind: ChatAgentKind; model?: string; title: string }
  | { cmd: "step"; label: string }
  | { cmd: "done"; summary?: string }
  | { cmd: "failed"; reason: string };

/**
 * Applies one command to a run: its new whole state, and the event it adds to the unsent ones.
 *
 * @param runId - The run's id (letters, digits, `_`, `-`; at most 64).
 * @param old - The run as remembered, if any.
 * @param c - The command.
 * @param now - Now (ms).
 * @returns The run after the command.
 * @throws When the id is not valid, or `step`/`done`/`failed` name a run this chat never started.
 */
export function applyCommand(runId: string, old: ChatRun | undefined, c: ChatCommand, now: number): ChatRun {
  if (!isHubId(runId)) throw new Error("The run id may hold only letters, digits, _ and - (at most 64).");
  if (c.cmd === "start") {
    const title = `${KIND_ICON[c.kind]} ${scrub(c.title, 110) || c.kind}`;
    const model = c.model ? scrub(c.model, HUB_LIMITS.nameChars) : undefined;
    const ev: ActivityEvent = { seq: 1, t: now, type: "started", title, source: "claude-chat", ...(model ? { model } : {}) };
    const state: AgentRunState = { runId, title, source: "claude-chat", state: "running", ...(model ? { model } : {}), step: 0, startedAt: now, lastEventAt: now, files: 0, fileNames: [] };
    return { state, seq: 1, unsent: [ev] };
  }
  if (!old) throw new Error(`No run "${runId}" was started from this chat. Call start first.`);
  const seq = old.seq + 1;
  const base = { ...old.state, lastEventAt: Math.max(now, old.state.lastEventAt) };
  const keep = (ev: ActivityEvent, state: AgentRunState): ChatRun => ({ state, seq, unsent: [...old.unsent, ev].slice(-HUB_LIMITS.agentEventsPerRun) });
  switch (c.cmd) {
    case "step": {
      const label = scrub(c.label, 80);
      const n = old.state.step + 1;
      return keep({ seq, t: now, type: "step", n, label }, { ...base, state: "running", step: n, ...(label ? { label } : {}) });
    }
    case "done": {
      const summary = c.summary ? scrub(c.summary, 300) : "";
      const { label: _label, ...rest } = base;
      return keep({ seq, t: now, type: "done", steps: old.state.step, ...(summary ? { summary } : {}) }, { ...rest, state: "done", endedAt: now, ...(summary ? { summary } : {}) });
    }
    case "failed": {
      const reason = scrub(c.reason, 200);
      const { label: _label, ...rest } = base;
      return keep({ seq, t: now, type: "failed", reason }, { ...rest, state: "failed", endedAt: now });
    }
  }
}

/**
 * Drops runs no viewer needs any more: ended over a day ago, and the oldest past 50.
 *
 * @param runs - The runs (changed in place).
 * @param now - Now (ms).
 */
export function pruneRuns(runs: Record<string, ChatRun>, now: number): void {
  for (const [id, r] of Object.entries(runs)) if (r.state.endedAt && now - r.state.endedAt > 86_400_000) delete runs[id];
  const ids = Object.keys(runs).sort((a, b) => runs[b]!.state.lastEventAt - runs[a]!.state.lastEventAt);
  for (const id of ids.slice(50)) delete runs[id];
}

/**
 * Reads the CLI's arguments into a command.
 *
 * @param argv - The arguments after the script (`start <runId> --kind … --model … --title …`, `step <runId> <label>`,
 *   `done <runId> [summary]`, `failed <runId> <reason>`).
 * @returns The run id and the command.
 * @throws With the usage line when the arguments do not fit.
 */
export function parseArgs(argv: string[]): { runId: string; command: ChatCommand } {
  const [cmd, runId = "", ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case "start": {
      const kind = flag("kind");
      const title = flag("title");
      if (!runId || !title || !(kind === "research" || kind === "build" || kind === "lookup")) throw new Error('Usage: start <runId> --kind research|build|lookup --model <name> --title "<short title>"');
      const model = flag("model");
      return { runId, command: { cmd, kind, title, ...(model ? { model } : {}) } };
    }
    case "step":
      if (!runId || !rest[0]) throw new Error('Usage: step <runId> "<short label>"');
      return { runId, command: { cmd, label: rest[0] } };
    case "done":
      if (!runId) throw new Error('Usage: done <runId> ["<summary, at most 300 characters>"]');
      return { runId, command: { cmd, ...(rest[0] ? { summary: rest[0] } : {}) } };
    case "failed":
      if (!runId || !rest[0]) throw new Error('Usage: failed <runId> "<reason>"');
      return { runId, command: { cmd, reason: rest[0] } };
    default:
      throw new Error(`Unknown command "${cmd ?? ""}". Commands: pair, start, step, done, failed.`);
  }
}
