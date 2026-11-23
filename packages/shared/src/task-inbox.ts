/**
 * The task inbox (docs/RESEARCH_LOG.md, "A task inbox"): coding tasks Claude (or Roee from the phone, or the Kesher
 * Cloud hub) writes to the `kesher-inbox` git branch; KesherAI on the PC lists them, runs each one with the executor it
 * names, checks the work itself and returns it as a branch for Claude to review. These are the shapes the server
 * sends to the page (`GET /api/task-inbox`), shared so the page and the server agree.
 */
import type { InboxModel } from "./inbox-models.js";
import type { AgentLabel } from "./agent-label.js";

/**
 * Who does a task: `auto` resolves by the routing table (see `routeTask` in packages/core/src/task-inbox.ts).
 * `opencode`: a code task on the user's flat OpenCode Go plan, run by itself in a code chat (no Run press: it is the
 * user's own API key, not an agent's account), on a cheap model for size S and a strong one for M and L.
 */
export type InboxExecutor = "auto" | "antigravity" | "local" | "opus" | "gemini" | "opencode";

/** How big a task is (research reports' "Size S/M/L"; picks the OpenCode Go model). */
export type InboxSize = "S" | "M" | "L";

/** The connection id of the user's OpenCode Go plan (packages/providers/src/presets.ts). */
export const OPENCODE_PROVIDER = "opencode-go";

/** Settings > Task inbox > OpenCode Go (config `taskInbox.opencode`). */
export interface OpencodeSettings {
  /**
   * Allow free services that may train on my code (Gemini free, Mistral, NVIDIA, OpenCode Contributor); only low-risk,
   * non-security tasks are sent ({@link safeForTrainingProvider}). On by default (Roee, 2026-11-23); off: only Beam
   * Free, Z.ai, OpenRouter's `:free` and Cloudflare models run.
   */
  freeTrainingOk?: boolean;
  /** Off: no task goes to OpenCode Go, by hand or as the gap filler. */
  enabled: boolean;
  /** The model for small (S) tasks: cheap and fast. */
  small: string;
  /** The model for medium and large (M, L) tasks: strong. */
  strong: string;
  /** OpenCode Go tasks a day (its plan has one shared monthly allowance; this keeps a day from eating it). */
  dailyCap: number;
  /**
   * Try the plan's free models first (Beam Free: unlimited "for a limited time", 2026-11-23).
   * A task on a free model does not count toward `dailyCap`; when they are gone or fail, the paid order takes over.
   */
  useFree?: boolean;
}

/** The defaults: a cheap model for small work, a stronger (still cheap) one for the rest, 15 a day. */
// Defaults by cost (Go plan, 2026-11-22, requests a month): Kimi K3 ~98 (44 requests spent a 5-hour window and 20% of
// the month), MiMo-V2.6-Pro ~3,260, MiMo-V2.6-Flash ~30,100. An agent task makes tens of requests, so the cheap pair.
export const OPENCODE_DEFAULTS: OpencodeSettings = { enabled: true, small: "opencode-go/mimo-v2.6-flash", strong: "opencode-go/mimo-v2.6-pro", dailyCap: 15, freeTrainingOk: true };

/**
 * The OpenCode Go model for a task, by its size: the cheap one for S, the strong one for M and L (like OpenCode's own
 * `small_model` beside `model`, and Cline's separate Plan and Act models). A task's own `model` that names an OpenCode
 * Go model wins.
 *
 * @param t - The task's size and model.
 * @param s - The OpenCode Go settings.
 * @returns The KesherAI model id (`opencode-go/<model>`).
 */
export function opencodeModelFor(t: { size?: InboxSize; model?: string }, s: Pick<OpencodeSettings, "small" | "strong">): string {
  if (t.model?.startsWith(`${OPENCODE_PROVIDER}/`)) return t.model;
  return t.size === "S" ? s.small || OPENCODE_DEFAULTS.small : s.strong || OPENCODE_DEFAULTS.strong;
}

/**
 * The models a task falls back to when its own model answers 429, in order (after the configured small and strong
 * ones). Kimi is never here: it has ~98 requests a month, so it runs only when the user configured or chose it.
 */
/** OpenCode Go's free models (unlimited while the offer lasts), tried first when `useFree` is on and the connection lists them. */
// Not the "Contributor" free models (Iceman Contributor Free): those answer 400 without the plan's data-sharing
// opt-in, and sharing Roee's code for training is not wanted.
export const OPENCODE_FREE_MODELS: readonly string[] = ["opencode-go/beam-free"];

/** Whether a model is one of the plan's free ones (does not count toward the daily cap). */
/** OpenRouter's free tier without a credit purchase: 50 requests a day (20 a minute); failed attempts count (2026-11-23). */
export const OPENROUTER_FREE_DAILY = 50;

/** OpenRouter's free router (`openrouter/free`: picks an open free model by itself), as a KesherAI model id. */
export const OPENROUTER_FREE_ROUTER = "openrouter/openrouter/free";

/** Z.ai's free models (one request at a time; unpublished daily caps), as KesherAI model ids; the first is the coding one. */
export const ZAI_FREE_MODELS: readonly string[] = ["zai/glm-4.7-flash", "zai/glm-4.5-flash"];

/**
 * One free service the inbox may use for S code tasks after Beam Free, before paid models (2026-11-23). Only the models
 * `allowed` accepts may ever run unattended; `trainsOnData` ones also need the user's `freeTrainingOk`.
 */
export interface FreeProvider {
  /** The connection id (`zai`, `openrouter`, `mistral`, `nvidia-nim`; `opencode-go` for its contributor models). */
  id: string;
  /** Shown in the settings card. */
  name: string;
  /** Its free tier may use prompts and outputs for training: used only when `freeTrainingOk` is on. */
  trainsOnData: boolean;
  /** The free requests a day, when the service states one (absent: counted for the card, never limited here). */
  dailyLimit?: number;
  /** Whether a KesherAI model id (`<connection>/<model>`) is one this service's free tier covers. */
  allowed: (id: string) => boolean;
  /** The models to try, in order, from those the connection lists now. */
  pick: (listed: readonly string[]) => string[];
}

/** Coding-model names first (stable otherwise), at most `max`. */
const coderFirst = (ids: readonly string[], max: number): string[] => [...ids].sort((a, b) => Number(/coder|devstral|codestral/i.test(b)) - Number(/coder|devstral|codestral/i.test(a))).slice(0, max);

/**
 * Whether a KesherAI model id is one of OpenRouter's FREE models: the free router, or `openrouter/<provider>/<model>:free`.
 * Any other OpenRouter id (paid) is never allowed in the inbox ({@link inboxModelAllowed}).
 *
 * @param id - The KesherAI model id.
 */
export function isOpenrouterFreeModel(id: string): boolean {
  return id === OPENROUTER_FREE_ROUTER || /^openrouter\/[\w.-]+\/[\w.-]+:free$/.test(id);
}

/** Cloudflare Workers AI: the free 10,000 Neurons a day (resets 00:00 UTC) cover only a few small tasks. */
const isCloudflareModel = (id: string): boolean => /^cloudflare-ai\/@cf\/[\w./:-]+$/.test(id);
/** Gemini's free tier: the Flash and Flash-Lite models only (never Pro). */
const isGeminiFree = (id: string): boolean => /^gemini\/(models\/)?gemini-[\w.-]*flash[\w.-]*$/i.test(id);

/** Services that are chat/research only: too small for an agent loop, never in the inbox's coder order. */
export const CHAT_ONLY_PROVIDERS: readonly string[] = ["sambanova", "cohere", "ollama-cloud"];

const isContributorFree = (id: string): boolean => /^opencode-go\/[\w.-]*contributor-free$/.test(id);

/** The free services, in the order they are tried (after Beam Free). */
export const FREE_PROVIDERS: readonly FreeProvider[] = [
  // Z.ai: API data is not used for training unless the user agrees; one request at a time.
  { id: "zai", name: "Z.ai", trainsOnData: false, allowed: (id) => ZAI_FREE_MODELS.includes(id), pick: (l) => ZAI_FREE_MODELS.filter((m) => l.includes(m)).slice(0, 1) },
  {
    id: "openrouter",
    name: "OpenRouter",
    trainsOnData: false,
    dailyLimit: OPENROUTER_FREE_DAILY,
    allowed: isOpenrouterFreeModel,
    // The free router first, then up to two listed `:free` models (coder ones first).
    pick: (l) => {
      const free = l.filter(isOpenrouterFreeModel);
      return [...free.filter((m) => m === OPENROUTER_FREE_ROUTER), ...coderFirst(free.filter((m) => m !== OPENROUTER_FREE_ROUTER), 2)];
    },
  },
  // Workers AI: ~10,000 Neurons a day for every account; the best coding model it lists (low priority: a small allowance).
  { id: "cloudflare-ai", name: "Cloudflare", trainsOnData: false, allowed: isCloudflareModel, pick: (l) => l.filter((m) => isCloudflareModel(m) && /coder/i.test(m)).slice(0, 1) },
  // Gemini's free key: Flash first, then Flash-Lite; Google's free tier may use prompts to improve its products.
  { id: "gemini", name: "Gemini", trainsOnData: true, allowed: isGeminiFree, pick: (l) => l.filter(isGeminiFree).sort((a, b) => Number(/lite/i.test(a)) - Number(/lite/i.test(b))).slice(0, 2) },
  // The free "Experiment" plan: 1 request/s; its data may train models.
  { id: "mistral", name: "Mistral", trainsOnData: true, allowed: (id) => /^mistral\/[\w.:-]+$/.test(id), pick: (l) => coderFirst(l.filter((m) => m.startsWith("mistral/")), 2) },
  // The free trial key (testing and evaluation only): ~40 requests/min; its data may train models.
  { id: "nvidia-nim", name: "NVIDIA", trainsOnData: true, allowed: (id) => /^nvidia-nim\/[\w./:-]+$/.test(id), pick: (l) => coderFirst(l.filter((m) => m.startsWith("nvidia-nim/")), 2) },
  // OpenCode's "Contributor" free models answer only with the data-sharing opt-in.
  { id: "opencode-go", name: "OpenCode Contributor", trainsOnData: true, allowed: isContributorFree, pick: (l) => l.filter(isContributorFree).slice(0, 1) },
];

/** The free service a model id belongs to, when it is one of the free tier's models. */
export const freeProviderOf = (id: string): FreeProvider | undefined => FREE_PROVIDERS.find((p) => p.allowed(id));

/** Whether a model is a free one (the plan's Beam Free or a free service's): it does not count toward the daily cap. */
export const isFreeOpencodeModel = (id: string): boolean => OPENCODE_FREE_MODELS.includes(id) || !!freeProviderOf(id);

/**
 * The guard for the inbox's automatic runs. A model of a free service's connection (OpenRouter, Z.ai, Cloudflare, Gemini,
 * Mistral, NVIDIA) must be one of its free ones; one of a service that may train on data needs `freeTrainingOk`; the
 * chat-only services never run; other ids are the OpenCode Go plan's own.
 *
 * @param id - The KesherAI model id.
 * @param freeTrainingOk - The user's setting (default false).
 */
export function inboxModelAllowed(id: string, freeTrainingOk = false): boolean {
  if (CHAT_ONLY_PROVIDERS.some((p) => id.startsWith(`${p}/`))) return false;
  const fp = freeProviderOf(id);
  if (fp) return !fp.trainsOnData || freeTrainingOk;
  // A model of a free service's connection that is not one of its free models is never allowed (paid ids included).
  return !FREE_PROVIDERS.some((p) => p.id !== OPENCODE_PROVIDER && id.startsWith(`${p.id}/`)) && !isContributorFree(id);
}

const SECURITY_PATH = /(^|[/._@-])(auth|crypt|key|secret|token|passw|credential|permission|control-reviewer|relay-keys|hub-protocol|pairing|sandbox|gate|updates?|installer|cert|signing)/i;
const SECURITY_WORDS = /\b(security|secure|vulnerab\w*|exploit\w*|passwords?|tokens?|keys?|secrets?|encrypt\w*|decrypt\w*|crypto\w*|auth\w*|permissions?|credentials?|cve(-\d+)?|sandbox|pairing|sealing|relay|installer|signing)\b|אבטח|סיסמ|מפתח|הרשא|הצפנ|טוקן|סוד|פגיעות/i;

/**
 * Whether a task may be sent to a free service that may train on its prompts (Gemini free, Mistral, NVIDIA, OpenCode
 * Contributor): only a low-risk, small code task that stays away from anything security-sensitive. It never reads
 * files; the caller also runs the privacy scan on the prompt it sends.
 *
 * @param t - The task (its limits and text).
 * @returns `ok`, or `why` (English) it must stay with the other free options.
 */
export function safeForTrainingProvider(t: { kind?: string; risk?: string; size?: string; allowedPaths?: readonly string[]; forbiddenPaths?: readonly string[]; title?: string; goal?: string; readFirst?: string; acceptance?: string; outOfScope?: string }): { ok: boolean; why?: string } {
  if (t.kind === "research") return { ok: false, why: "research and report tasks stay off training services" };
  if (t.risk !== "low") return { ok: false, why: "only low-risk tasks go to services that may train" };
  if (t.size !== "S") return { ok: false, why: "only small (S) tasks go to services that may train" };
  const paths = t.allowedPaths ?? [];
  if (!paths.length) return { ok: false, why: "the task has no path limit" };
  const bad = paths.find((g) => SECURITY_PATH.test(g) || /^\.github(\/|$)|(^|\/)\.env/.test(g) || /^\*{0,2}(\/\*\*)?$/.test(g));
  if (bad) return { ok: false, why: `its paths touch a sensitive or unlimited area (${bad})` };
  const text = [t.title, t.goal, t.readFirst, t.acceptance, t.outOfScope].filter(Boolean).join("\n");
  if (SECURITY_WORDS.test(text)) return { ok: false, why: "its text mentions a security topic" };
  return { ok: true };
}

/**
 * The free service models to try for a small task, in order: each connected service's picks, skipping the ones that may
 * train on data unless allowed. Only what each connection lists now.
 *
 * @param listed - Per connection id, the models it lists (`<connection>/<model>`); absent: not connected.
 * @param freeTrainingOk - The user's setting.
 */
export function freeModelsFor(listed: Readonly<Record<string, readonly string[]>>, freeTrainingOk = false): string[] {
  return FREE_PROVIDERS.filter((p) => (freeTrainingOk || !p.trainsOnData) && listed[p.id]).flatMap((p) => p.pick(listed[p.id]!));
}

/**
 * The free models to try first: on unless turned off, and only those the connection lists now (the offer is "for a
 * limited time"; an empty or unknown list means none).
 *
 * @param s - The OpenCode Go settings.
 * @param listed - The models the connection lists.
 */
export function opencodeFreeFirst(s: Pick<OpencodeSettings, "useFree">, listed: readonly string[]): string[] {
  return s.useFree === false ? [] : OPENCODE_FREE_MODELS.filter((m) => listed.includes(m));
}

export const OPENCODE_FALLBACKS: readonly string[] = ["opencode-go/mimo-v2.6-flash", "opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3", "opencode-go/mimo-v2.6-pro"];

/** What the Go plan ($10) allows a month, per model (approximate, 2026-11-22), shown in the OpenCode card. */
export const OPENCODE_MONTHLY_REQUESTS: ReadonlyArray<{ id: string; name: string; requests: number }> = [
  { id: "opencode-go/beam-free", name: "Beam Free", requests: Infinity },
  { id: "opencode-go/kimi-k3", name: "Kimi K3", requests: 98 },
  { id: "opencode-go/mimo-v2.6-pro", name: "MiMo-V2.6-Pro", requests: 3260 },
  { id: "opencode-go/glm-5.3", name: "GLM-5.3", requests: 2640 },
  { id: "opencode-go/mimo-v2.6-flash", name: "MiMo-V2.6-Flash", requests: 30100 },
  { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", requests: 43300 },
];

/**
 * The models OpenCode Go may use for a task, in order: the configured small and strong, then the fallbacks. No
 * duplicates; kimi appears only when configured.
 *
 * @param s - The OpenCode Go settings.
 */
export function opencodeModelOrder(s: Pick<OpencodeSettings, "small" | "strong">): string[] {
  return [...new Set([s.small || OPENCODE_DEFAULTS.small, s.strong || OPENCODE_DEFAULTS.strong, ...OPENCODE_FALLBACKS])];
}

/**
 * The first model that is not cooling down. `first` (the task's own pick) is tried before the order; `skip` models
 * (one that just answered 429) are never returned.
 *
 * @param order - The models in order (opencodeModelOrder).
 * @param until - Each model's cooldown end (ms since epoch); absent or past means free.
 * @param now - Now (ms).
 * @param first - The model to prefer, when free.
 * @param skip - Models to leave out.
 * @returns The model id, or undefined when all are cooling down.
 */
export function opencodeFreeModel(order: readonly string[], until: Readonly<Record<string, number>>, now: number, first?: string, skip: readonly string[] = []): string | undefined {
  const free = (m: string): boolean => !skip.includes(m) && (until[m] ?? 0) <= now;
  if (first && free(first)) return first;
  return order.find(free);
}

/** A model id without its connection (`opencode-go/kimi-k3` → `kimi-k3`), for cards. */
export const opencodeModelName = (id: string): string => id.replace(new RegExp(`^(${OPENCODE_PROVIDER}|openrouter|mistral|nvidia-nim|zai)/`), "");

/**
 * What a task is: `code` (the default) changes the project; `research` only writes one report, either with Antigravity
 * (big research, needs the user's Run) or with the free Gemini key (small research, runs by itself).
 */
export type InboxKind = "code" | "research";

/** How risky a task is (security, git, auth, releases are always `high`). */
export type InboxRisk = "low" | "medium" | "high";

/** Where a task came from (`device`: another of the user's devices, through Google Drive; it always waits for Run). */
export type InboxFrom = "claude" | "roee" | "self-work" | "hub" | "device";

/**
 * A task's state in the queue:
 * - `waiting`: ready; an Antigravity task waits for the user's Run on the PC, a local one for self-work.
 * - `queued`: handed on (to self-work through the board, or kept for Claude's own Opus agent).
 * - `running`, `needs-approval` (an agent step waits for the user), then one of the ends:
 * - `done`, `partial` (work kept as a `-partial` branch), `failed`, `declined` (refused by a rule),
 *   `deferred-quota` (the plan's quota ran out; Run again later), `skipped` (the user skipped it).
 */
export type InboxStatus = "waiting" | "queued" | "running" | "needs-approval" | "done" | "partial" | "failed" | "declined" | "deferred-quota" | "skipped";

/** A task as written in `tasks/<id>.md` (frontmatter and sections), after checking. */
export interface InboxTaskSpec {
  id: string;
  title: string;
  executor: InboxExecutor;
  /** `research`: the task writes one report (`docs/research/<id>.md`) and nothing else; absent = `code`. */
  kind?: InboxKind;
  /** `size: S|M|L` (absent: guessed from its limits, see `sizeOf` in packages/core/src/task-inbox.ts). */
  size?: InboxSize;
  risk: InboxRisk;
  from: InboxFrom;
  /** The branch or commit to start from (default `origin/main`). */
  base: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** The check KesherAI runs after the agent (only parts that are on the allowed command list). */
  check: string;
  maxMinutes: number;
  maxFiles: number;
  /** A model the task asks for (inside Antigravity); empty = the inbox's default. */
  model?: string;
  /** `local_ok: true`: the local model may carry it while Claude cools down (never an Antigravity task). */
  localOk?: boolean;
  /** `replaces: [ids]`: older tasks this one supersedes; the PC skips those that have not started, with a note. */
  replaces?: string[];
  /** The standing "what to research next" task (a fresh copy of a template, shown while Antigravity is idle; inbox-queue.ts). */
  standing?: boolean;
  /** For a standing copy: the template task it was copied from (none: the "what to research next" template). */
  standingOf?: string;
  goal: string;
  readFirst?: string;
  acceptance?: string;
  outOfScope?: string;
  report?: string;
}

/** What KesherAI decided about one agent step (a permission request). */
export interface InboxDecision {
  at: number;
  verdict: "allow" | "deny" | "ask";
  /** The step as the agent named it, e.g. `pnpm add fuse.js` or `edit DownloadsHistory.tsx`. */
  what: string;
  /** Which rule decided, in English (the page translates the known ones). */
  rule: string;
  /** For `ask`: the user's answer. */
  answer?: "allow" | "deny" | "timeout";
}

/** An agent step waiting for the user's answer. */
export interface InboxApprovalAsk {
  requestId: string;
  what: string;
  /** The agent's own words for why (its step title), if any. */
  why?: string;
  /** The working folder it runs in (shown as the branch, never a personal path). */
  where: string;
  /** Why KesherAI asks instead of deciding. */
  rule: string;
  /** When it is denied without an answer (ms since epoch). */
  until: number;
}

/** One check KesherAI ran on the work. */
export interface InboxCheck {
  name: string;
  command?: string;
  ok: boolean;
  /** A short result ("0 errors", "4 files inside the allowed paths") or the output's tail. */
  note: string;
}

/** A task with everything the queue and the task page show. */
export interface InboxTaskView extends InboxTaskSpec {
  status: InboxStatus;
  /** The owner's own name and note for its agent run (agent-labels.ts; added by the route, not stored with it). */
  label?: AgentLabel;
  /** The executor after routing (`auto` resolved). */
  runBy: Exclude<InboxExecutor, "auto">;
  /** The branch the work goes to (`agy/<id>-<slug>`, `-partial` when kept unfinished). */
  branch: string;
  /** The board item it was put on (the shared task board). */
  boardId?: string;
  /** The place in its executor's queue (1 = next), while the user has it queued (added by the PC's list, never stored). */
  queued?: number;
  /** A local-model task's board item while it is not ended: open = waits for the local agent, claimed = it works on it. */
  boardState?: "open" | "claimed";
  /** The model it ran on, as the agent named it. */
  modelUsed?: string;
  /** It ran on a free service that may use prompts for training (the card says so). */
  mayTrain?: boolean;
  /** Set when the chosen model could not run (quota, unavailable) and another took over, e.g. "Claude Opus 4.6 → Claude Sonnet 4.6 (quota)". */
  modelFallback?: string;
  plan?: Array<{ content: string; status: string }>;
  steps?: number;
  decisions?: InboxDecision[];
  pending?: InboxApprovalAsk;
  checks?: InboxCheck[];
  files?: Array<{ path: string; added: number; removed: number }>;
  /** The diff (cut to about 60 KB) for the task page. */
  diff?: string;
  headSha?: string;
  pushed?: boolean;
  /** The agent's own short report. */
  summary?: string;
  /** Why it failed, was declined or deferred. */
  note?: string;
  startedAt?: number;
  endedAt?: number;
  /** A free-Gemini research task's report (the result file carries it whole; the page shows it). */
  researchReport?: string;
  /** The research report is on main (its commit, short), merged by KesherAI itself (research-publish.ts). */
  merged?: string;
  /** For a free-Gemini task deferred by its quota: when it may try once more by itself (ms since epoch). */
  retryAt?: number;
  /** The one automatic retry after the quota reset was used (a second quota stop waits for the user). */
  autoRetried?: boolean;
  /** Whether the result file was written to the inbox branch. */
  resultWritten?: boolean;
  /**
   * The PC asks "Run this task in Antigravity?" (shown on the PC and the phone, and sent through the hub): one ask is
   * one run, it is used up by the answer and expires after 30 minutes; a "yes" is never remembered.
   */
  runAsk?: InboxRunAsk;
}

/** A waiting "Run this task in Antigravity?" question. */
export interface InboxRunAsk {
  requestId: string;
  at: number;
  /** It expires then (ms since epoch). */
  until: number;
  /** Antigravity tasks left today when it was asked. */
  left: number;
  /**
   * Set when this is the "Next in line — Start?" ask after a task ended (the queue never starts a task by itself):
   * `done` is the title of the task that ended, `more` how many are in line behind this one.
   */
  next?: { done: string; more: number };
}

/** Settings > Task inbox (config `taskInbox`). */
export interface InboxSettings {
  /** Off: no fetching, no runs (the kill switch). */
  enabled: boolean;
  paused: boolean;
  /** The git project on this computer whose `origin` holds the inbox branch. */
  repo?: string;
  /** The inbox branch's name (default `kesher-inbox`). */
  branch: string;
  fetchMinutes: number;
  /** Antigravity tasks a day (default 10). */
  dailyCap: number;
  /** OpenCode Go: the flat coding plan that takes S/M code tasks while Antigravity is out (absent: the defaults). */
  opencode?: OpencodeSettings;
  /** Research → tasks loop: tasks from research reports fill the Antigravity and local lines by themselves (default on). */
  loop?: boolean;
  maxMinutes: number;
  /** The model inside Antigravity (empty: Gemini's default). */
  model: string;
  /**
   * Ask on the phone for each step the policy is unsure about (true), or approve once per task (false, the default):
   * the Run press approves the task, steps inside the policy go ahead, and unsure steps are refused and listed in the
   * result for review instead of waiting for an answer (Roee, 2026-11-21).
   */
  askSteps?: boolean;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Commands the agent may run without asking, and the only ones KesherAI runs as a task's check. */
  commands: string[];
  /**
   * Per executor: ask "Next in line: X - Start?" when a task ends and another is queued (true), or start the next
   * queued task by itself (false). Antigravity defaults to asking (Roee, 2026-11-22); the local model to starting by itself.
   */
  askBeforeNext: { antigravity: boolean; local: boolean };
  /** Busy rules: Run waits while a game, an editor, or a busy graphics card is on. */
  notWhileGame: boolean;
  notWhileEditor: boolean;
  /** Percent; 0 = off. */
  gpuBusyPercent: number;
}

/** Why the PC is busy now, or free. */
export interface InboxBusy {
  free: boolean;
  reasons: string[];
  gpu?: number;
  games?: number;
}

/**
 * The inbox's `lastError` when the git program cannot be started (not installed, or not on PATH). The page shows its
 * own Hebrew and English text for it instead of the raw system message (on Windows, cmd.exe's "is not recognized").
 */
export const INBOX_GIT_MISSING = "Git for Windows is not installed / not found: install it from git-scm.com (or `winget install Git.Git`) and restart KesherAI.";

/** `GET /api/task-inbox`: the queue and its state. */
export interface InboxState {
  settings: InboxSettings;
  today: { date: string; used: number };
  tasks: InboxTaskView[];
  busy: InboxBusy;
  lastFetch?: number;
  lastError?: string;
  /** The plan's quota ran out: Antigravity can run again after this time. */
  quota?: { until: number; taskId?: string; estimated: boolean };
  /** The page runs on this computer itself (Run starts at once); elsewhere Run answers the PC's ask. */
  runHere: boolean;
  /** The project's folder name (never its full path), for the ask card. */
  project?: string;
  /** The models Antigravity offered in its last session (inbox-models.ts); empty before it was asked once. */
  models?: InboxModel[];
  /** OpenCode Go now: its connection is set up with a key, today's count, and its limit's end when it answered 429. */
  opencode?: OpencodeState;
  /** The connected free services (OpenRouter, Z.ai, Mistral, NVIDIA, ...) that take S tasks after Beam Free. */
  free?: FreeProviderState[];
  /**
   * The work loop (Settings › Task inbox › Keep the work loop running): running, paused until Antigravity can work
   * again (its quota, every model's quota, or today's cap: `until` in ms), or off.
   */
  loop?: { state: "running" | "paused" | "off"; until?: number; why?: "quota" | "models" | "cap" };
}

/** One connected free service for the settings card: today's requests (its own count when it answered, else counted here). */
export interface FreeProviderState {
  /** The connection id (`openrouter`, `zai`, ...). */
  id: string;
  name: string;
  /** Free requests used today (UTC), failed attempts included. */
  used: number;
  /** The day's limit when the service states one (OpenRouter: 50). */
  limit?: number;
  /** Out until this time (ms since epoch): the day's limit, a 402, or a 429. */
  until?: number;
  /** Its free tier may train on prompts: used only when `freeTrainingOk` is on. */
  trainsOnData: boolean;
}

/** OpenCode Go's state for the settings card and the queue. */
export interface OpencodeState {
  /** The `opencode-go` connection exists and has a key. */
  ready: boolean;
  /** Tasks started today. */
  used: number;
  /** Its plan's limit was reached: no task starts before this (ms since epoch). */
  until?: number;
  /** Models cooling down after a 429: model id → when it is free again (ms since epoch). Only those still cooling. */
  cooldowns?: Record<string, number>;
  /** The models its connection lists (`opencode-go/<model>`), for the pickers; empty when it could not be asked. */
  models: string[];
}

/** What the PC answers (HTTP 409) when Run is pressed on an Antigravity task while another one runs. */
export const BUSY_RUN_TEXT = { he: "משימה רצה, אין להריץ עד שתסתיים", en: "A task is running; do not run another until it ends" } as const;
