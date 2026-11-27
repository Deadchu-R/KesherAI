/**
 * The task inbox (docs/RESEARCH_LOG.md, "A task inbox"): coding tasks Claude (or Roee from the phone, or the Kesher
 * Cloud hub) writes to the `kesher-inbox` git branch; KesherAI on the PC lists them, runs each one with the executor it
 * names, checks the work itself and returns it as a branch for Claude to review. These are the shapes the server
 * sends to the page (`GET /api/task-inbox`), shared so the page and the server agree.
 */
import type { InboxModel } from "./inbox-models.js";
import type { AgentLabel } from "./agent-label.js";
import { freeTierTrains } from "./training-risk.js";
import type { ClaudeSettings, ClaudeState } from "./claude-code.js";

/**
 * Who does a task: `auto` resolves by the routing table (see `routeTask` in packages/core/src/task-inbox.ts).
 * `opencode`: a code task on the user's flat OpenCode Go plan, run by itself in a code chat (no Run press: it is the
 * user's own API key, not an agent's account), on a cheap model for size S and a strong one for M and L.
 * `claude`: a code task for Claude Code on this PC (claude-code.ts), signed in with the user's own subscription; it
 * waits for the user's Run tap by default. Never picked by `auto` (it spends the same limits as the Claude app).
 */
export type InboxExecutor = "auto" | "antigravity" | "local" | "opus" | "gemini" | "opencode" | "ghostcli" | "claude";

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
  /**
   * Send heavy tasks without sensitive content to a flat-rate relay the user pays for (GhostCLI), before the paid plan's
   * models; outside the daily cap (Roee, 25.11: a one-month trial).
   */
  useRelay?: boolean;
}

/**
 * Settings > Task inbox > GhostCLI (config `taskInbox.ghostcli`): the flat-rate relay as its own executor (Roee, 27.11:
 * GhostCLI and OpenCode Go are different services). It runs code tasks with KesherAI's coding agent like OpenCode Go,
 * but with its own on/off, daily cap, model order, 429 tracking and counters.
 */
export interface GhostcliSettings {
  /** Off: no task runs on GhostCLI (given by hand or sent as a heavy task). */
  enabled: boolean;
  /** GhostCLI tasks a day (it is "unlimited" by its terms; this keeps one day from running away). */
  dailyCap: number;
  /** The models to try, in order (`ghostcli/<model>`); empty: the relay's own list, strongest first. */
  models: string[];
  /**
   * Send heavy (M/L) OpenCode tasks without sensitive content to GhostCLI while it answers (they become GhostCLI tasks).
   * Absent: the older `opencode.useRelay` setting decides.
   */
  takeHeavy?: boolean;
}

/** GhostCLI's defaults: on, 30 tasks a day, the relay's own best-first order. */
export const GHOSTCLI_DEFAULTS: GhostcliSettings = { enabled: true, dailyCap: 30, models: [] };

/** GhostCLI's state for its settings card and the queue (like {@link OpencodeState}, counted on its own). */
export interface GhostcliState {
  /** A GhostCLI connection exists and has a key. */
  ready: boolean;
  /** Tasks started today (UTC). */
  used: number;
  /** Every model is cooling down after a 429: no task starts before this (ms since epoch). */
  until?: number;
  /** Models cooling down after a 429: model id → when it is free again (ms). Only those still cooling. */
  cooldowns?: Record<string, number>;
  /** The models its connection lists (`ghostcli/<model>`), for the order picker. */
  models: string[];
  /** The last availability check: whether it answered, and when (ms). */
  answering?: boolean;
  checkedAt?: number;
}

/**
 * A task's executor read from older saved data and task files: a task given to GhostCLI used to be an OpenCode task
 * pinned to the relay (`executor: opencode` + `model: ghostcli/*` or a `ghostcli/<model>`); it is a GhostCLI task now.
 *
 * @param executor - The saved executor.
 * @param model - The saved model, if any.
 * @returns The executor to use.
 */
export function ghostcliCompat<E extends string>(executor: E, model: string | undefined): E | "ghostcli" {
  return executor === "opencode" && !!model && /^ghostcli\//.test(model) ? "ghostcli" : executor;
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
  /** Its free tier may use prompts and outputs for training (training-risk.ts): used only when `freeTrainingOk` is on. */
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
  { id: "zai", name: "Z.ai", trainsOnData: freeTierTrains("zai"), allowed: (id) => ZAI_FREE_MODELS.includes(id), pick: (l) => ZAI_FREE_MODELS.filter((m) => l.includes(m)).slice(0, 1) },
  {
    id: "openrouter",
    name: "OpenRouter",
    trainsOnData: freeTierTrains("openrouter"),
    dailyLimit: OPENROUTER_FREE_DAILY,
    allowed: isOpenrouterFreeModel,
    // The free router first, then up to two listed `:free` models (coder ones first).
    pick: (l) => {
      const free = l.filter(isOpenrouterFreeModel);
      return [...free.filter((m) => m === OPENROUTER_FREE_ROUTER), ...coderFirst(free.filter((m) => m !== OPENROUTER_FREE_ROUTER), 2)];
    },
  },
  // Workers AI: ~10,000 Neurons a day for every account; the best coding model it lists (low priority: a small allowance).
  { id: "cloudflare-ai", name: "Cloudflare", trainsOnData: freeTierTrains("cloudflare-ai"), allowed: isCloudflareModel, pick: (l) => l.filter((m) => isCloudflareModel(m) && /coder/i.test(m)).slice(0, 1) },
  // Gemini's free key: Flash first, then Flash-Lite; Google's free tier may use prompts to improve its products.
  { id: "gemini", name: "Gemini", trainsOnData: freeTierTrains("gemini"), allowed: isGeminiFree, pick: (l) => l.filter(isGeminiFree).sort((a, b) => Number(/lite/i.test(a)) - Number(/lite/i.test(b))).slice(0, 2) },
  // The free "Experiment" plan: 1 request/s; its data may train models.
  { id: "mistral", name: "Mistral", trainsOnData: freeTierTrains("mistral"), allowed: (id) => /^mistral\/[\w.:-]+$/.test(id), pick: (l) => coderFirst(l.filter((m) => m.startsWith("mistral/")), 2) },
  // The free trial key (testing and evaluation only): ~40 requests/min; its data may train models.
  { id: "nvidia-nim", name: "NVIDIA", trainsOnData: freeTierTrains("nvidia-nim"), allowed: (id) => /^nvidia-nim\/[\w./:-]+$/.test(id), pick: (l) => coderFirst(l.filter((m) => m.startsWith("nvidia-nim/")), 2) },
  // OpenCode's "Contributor" free models answer only with the data-sharing opt-in.
  { id: "opencode-go", name: "OpenCode Contributor", trainsOnData: freeTierTrains("opencode-go"), allowed: isContributorFree, pick: (l) => l.filter(isContributorFree).slice(0, 1) },
  // The same services through the keys entered once in Settings › Accounts › Free cloud helpers (Roee, 24.11: no
  // second key in Connections). Same rules as their Connections twins.
  { id: "fc-zhipu", name: "Z.ai (free cloud)", trainsOnData: freeTierTrains("fc-zhipu"), allowed: (id) => /^fc-zhipu\/glm-[\w.-]*flash$/i.test(id), pick: (l) => l.filter((m) => /^fc-zhipu\/glm-[\w.-]*flash$/i.test(m)).sort().reverse().slice(0, 1) },
  {
    id: "fc-openrouter",
    name: "OpenRouter (free cloud)",
    trainsOnData: freeTierTrains("fc-openrouter"),
    allowed: (id) => id === "fc-openrouter/openrouter/free" || /^fc-openrouter\/[\w.-]+\/[\w.-]+:free$/.test(id),
    pick: (l) => {
      const free = l.filter((m) => m === "fc-openrouter/openrouter/free" || /^fc-openrouter\/[\w.-]+\/[\w.-]+:free$/.test(m));
      return [...free.filter((m) => m === "fc-openrouter/openrouter/free"), ...coderFirst(free.filter((m) => m !== "fc-openrouter/openrouter/free"), 2)];
    },
  },
  { id: "fc-cloudflare", name: "Cloudflare (free cloud)", trainsOnData: freeTierTrains("fc-cloudflare"), allowed: (id) => /^fc-cloudflare\/@cf\/[\w./:-]+$/.test(id), pick: (l) => l.filter((m) => /^fc-cloudflare\/@cf\//.test(m) && /coder/i.test(m)).slice(0, 1) },
];

/** A flat-rate relay the user pays for (GhostCLI): heavy tasks without sensitive content, not counted in OpenCode Go's day. */
export interface RelayProvider {
  /** The connection id (Settings › Connections). */
  id: string;
  /** Shown in the task card and the settings. */
  name: string;
  /** Whether a KesherAI model id is one of its models. */
  allowed: (id: string) => boolean;
  /** The models to try, best first, from what the connection lists. */
  pick: (listed: readonly string[]) => string[];
}

/** Opus first, then Sonnet, then GLM 5.x and the rest; Haiku-size models are skipped (heavy tasks only). */
const relayRank = (id: string): number => (/opus/i.test(id) ? 0 : /sonnet/i.test(id) ? 1 : /fable/i.test(id) ? 2 : /glm-5/i.test(id) ? 3 : 4);

/** The relays the task inbox can use. */
export const RELAY_PROVIDERS: readonly RelayProvider[] = [
  {
    id: "ghostcli",
    name: "GhostCLI",
    allowed: (id) => /^ghostcli\/[\w./:-]+$/.test(id),
    pick: (l) => l.filter((m) => m.startsWith("ghostcli/") && !/haiku|mini|nano|flash/i.test(m)).sort((a, b) => relayRank(a) - relayRank(b)).slice(0, 3),
  },
];

/** The relay a model id belongs to. */
export const relayProviderOf = (id: string): RelayProvider | undefined => RELAY_PROVIDERS.find((p) => p.allowed(id));

/**
 * Whether a task may go to a relay (Roee, 25.11: "heavy tasks without sensitive information"): any size, but not high
 * risk, path-limited, and nothing security-related in its paths or text. The caller also scans the prompt, and the leak
 * guard hides secrets in every request (the relay is in the training-risk table).
 *
 * @param t - The task.
 * @returns `ok`, or `why` (English) it stays with the other models.
 */
export function safeForRelay(t: { risk?: string; allowedPaths?: readonly string[]; title?: string; goal?: string; readFirst?: string; acceptance?: string; outOfScope?: string }): { ok: boolean; why?: string } {
  if (t.risk === "high") return { ok: false, why: "high-risk tasks stay off the relay" };
  const paths = t.allowedPaths ?? [];
  if (!paths.length) return { ok: false, why: "the task has no path limit" };
  const bad = paths.find((g) => SECURITY_PATH.test(g) || /^\.github(\/|$)|(^|\/)\.env/.test(g) || UNLIMITED_PATH.test(g));
  // `!== undefined`: an empty path ("") is found too, and it is falsy.
  if (bad !== undefined) return { ok: false, why: `its paths touch a sensitive or unlimited area (${bad || "an empty path"})` };
  const text = [t.title, t.goal, t.readFirst, t.acceptance, t.outOfScope].filter(Boolean).join("\n");
  if (SECURITY_WORDS.test(text)) return { ok: false, why: "its text mentions a security topic" };
  return { ok: true };
}

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
 * @param relayOk - This task passed {@link safeForRelay} and the relay is on (default false).
 */
export function inboxModelAllowed(id: string, freeTrainingOk = false, relayOk = false): boolean {
  if (CHAT_ONLY_PROVIDERS.some((p) => id.startsWith(`${p}/`))) return false;
  if (relayProviderOf(id)) return relayOk;
  const fp = freeProviderOf(id);
  if (fp) return !fp.trainsOnData || freeTrainingOk;
  // A model of a free service's connection that is not one of its free models is never allowed (paid ids included).
  return !FREE_PROVIDERS.some((p) => p.id !== OPENCODE_PROVIDER && id.startsWith(`${p.id}/`)) && !isContributorFree(id);
}

// A path limit that is no limit: empty, or a wildcard at the top ("**", "**/*", "*/**", "./**") reaches every folder.
const UNLIMITED_PATH = /^(\.?\/)?(\*|$)/;
/**
 * A security-sensitive file a relay or a service that may train must not change (checked on the real files at commit,
 * not only on the task's path patterns).
 *
 * @param path - A changed file.
 * @returns True when it is one.
 */
export function isSecurityFile(path: string): boolean {
  return SECURITY_PATH.test(path) || /^\.github(\/|$)|(^|\/)\.env/.test(path);
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
  const bad = paths.find((g) => SECURITY_PATH.test(g) || /^\.github(\/|$)|(^|\/)\.env/.test(g) || UNLIMITED_PATH.test(g));
  // `!== undefined`: an empty path ("") is found too, and it is falsy.
  if (bad !== undefined) return { ok: false, why: `its paths touch a sensitive or unlimited area (${bad || "an empty path"})` };
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
  /** The research report this task came from (e.g. `docs/research/SYNTHESIS-2026-11-22.md`). */
  source?: string;
}

/** One model attempt inside a task inbox run (nested under the task, not a chat list entry). */
export interface TaskRunAttempt {
  /** 1-based attempt number inside this task. */
  attempt: number;
  /** The model id that ran this attempt. */
  model: string;
  /** Agent steps executed in this attempt. */
  steps: number;
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs: number;
  /** Short result summary kept after raw logs are pruned. */
  result: "done" | "failed" | "stopped" | "quota" | "error";
  /** Optional human-readable note (error message, stop reason). */
  note?: string;
  /** When the attempt started (ms since epoch). */
  startedAt: number;
  /** The chat id that holds this run's messages (hidden from the chat list unless toggled). */
  chatId: string;
}

/** Build the stable chat id for a task inbox run attempt. */
export function inboxRunChatId(taskId: string, attempt: number): string {
  return `inbox-run:${taskId}:${attempt}`;
}

/** A second model's review of a finished task's diff against its goal and allowed paths. */
export interface InboxReview {
  verdict: "ok" | "doubtful" | "reject";
  reasons: string[];
  /** The model that reviewed. */
  model: string;
  /** The watchdog saw the agent work off the task (what it saw). */
  offTask?: string;
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
  /** Times a failure sent it back to the queue by itself (at most 2). */
  autoRetries?: number;
  /** Why the last run did not succeed (kept when the task goes back to the queue), shown in its box; cleared once it is done. */
  lastFail?: { at: number; status: InboxStatus; note: string };
  /** The last steps in short (task-steps.ts), newest last, while it runs and after: the card's "what it does". */
  stepLog?: import("./task-steps.js").StepNote[];
  decisions?: InboxDecision[];
  /** What the run guard did: a rescue hint, a watchdog worry (newest last, at most 30). */
  watchLog?: Array<{ at: number; text: string }>;
  /** The second model's look at the finished diff (inbox-guard.ts). */
  review?: InboxReview;
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
  /**
   * A research run whose web search found nothing (not the model's failure) goes back once, after the search
   * cooldown: "waiting" until that run starts, then "used" (a second such failure ends it as failed).
   */
  searchRetry?: "waiting" | "used";
  /** Whether the result file was written to the inbox branch. */
  resultWritten?: boolean;
  /**
       * The PC asks "Run this task in Antigravity?" (shown on the PC and the phone, and sent through the hub): one ask is
       * one run, it is used up by the answer and expires after 30 minutes; a "yes" is never remembered.
       */
      runAsk?: InboxRunAsk;
      /** Past and current runs of this task (the inbox page lists them; hidden from the main chat list). */
      runs?: TaskRunAttempt[];
  /**
   * The task was moved because its executor ran out of quota (quota-failover.ts): where from, when, and when that
   * executor is expected back (the row shows "↪ moved from X (quota)").
   */
  movedFrom?: InboxMove;
  /** When the PC last asked whether to move this hand-picked task (once per quota stop). */
  quotaAskAt?: number;
  /** Partial work handed to the next executor (task-handoff.ts): the note its prompt starts with, until that run ends. */
  handoff?: InboxHandoff;
  /** Every run of the task, oldest first (at most 8): the page shows the chain once there was a handoff. */
  chain?: HandoffStep[];
}

/** Where a continuation may go (task-handoff.ts): a failover target, or Claude's own Opus agent (security-sensitive or L work only). */
export type HandoffTarget = "ghostcli" | "opencode" | "antigravity" | "local" | "gemini" | "opus";

/** One run in a task's chain (the task page shows them in order). */
export interface HandoffStep {
  /** Who ran it. */
  by: Exclude<InboxExecutor, "auto">;
  /** It ran on a free model (OpenCode Go's free ones): shown as "OpenCode Go free". */
  free?: boolean;
  /** How the run ended. */
  status: InboxStatus;
  /** Files it changed (on the branch). */
  files: number;
  /** When it ended (ms). */
  at: number;
}

/** The handoff waiting for the next run (cleared when that run ends). */
export interface InboxHandoff {
  from: Exclude<InboxExecutor, "auto">;
  to: HandoffTarget;
  /** When it was handed on (ms). */
  at: number;
  /** The branch the work continues from (absent when nothing was pushed). */
  branch?: string;
  /** The note, already through the leak guard (at most 40 lines). */
  note: string;
}

/** A quota move of a task. */
export interface InboxMove {
  from: Exclude<InboxExecutor, "auto">;
  /** When it moved (ms). */
  at: number;
  /** When the first executor is expected back (ms), when known. */
  back?: number;
  /** Executors it was moved away from before `from` (it never moves back to any of them: no bouncing). */
  via?: Array<Exclude<InboxExecutor, "auto">>;
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
  /** GhostCLI: the flat-rate relay, its own executor (absent: the defaults, GHOSTCLI_DEFAULTS). */
  ghostcli?: GhostcliSettings;
  /** Claude Code on this PC (absent: the defaults, CLAUDE_DEFAULTS). */
  claude?: ClaudeSettings;
  /** When a quota runs out: move waiting tasks to an executor with quota left (absent: FAILOVER_DEFAULTS). */
  failover?: Partial<import("./quota-failover.js").FailoverSettings>;
  /** Hand partial work to the next agent (task-handoff.ts; absent: on). */
  handoff?: boolean;
  /** Research → tasks loop: tasks from research reports fill the Antigravity and local lines by themselves (default on). */
  loop?: boolean;
  /**
   * The safety ceiling in minutes (default 120): a run is stopped here whatever it does. The real stop is progress-based
   * (`stallMinutes`, `maxRequests`); a task's own `maxMinutes` counts too, the longer of the two wins.
   */
  maxMinutes: number;
  /** Stop a run when nothing changed (no changed file, no new step) for this many minutes (default 10). */
  stallMinutes?: number;
  /** Most agent requests (steps) one task may use (default 80). */
  maxRequests?: number;
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

/** One relay attempt (GhostCLI), for its trial report. */
export interface RelayRun {
  /** When it ended (ms). */
  at: number;
  /** The task. */
  id: string;
  /** The model asked. */
  model: string;
  /** How it ended: a task status, `rate-limited` (the relay said "too many requests"), or a small check message's result. */
  status: InboxStatus | "rate-limited" | "probe-ok" | "probe-failed" | "handed-off";
  /** How long it ran (ms). */
  ms: number;
}

/** The relay's last small "are you there" message. */
export interface RelayProbe {
  /** When (ms). */
  at: number;
  /** It answered with text. */
  ok: boolean;
  /** How long it took (ms). */
  ms: number;
  /** The model asked. */
  model: string;
  /** The start of the answer, or why it failed. */
  note: string;
  /** The models that answered this time (tasks go only to these), best first. */
  answered?: string[];
}

/** The relay's trial report (Roee, 25.11: is "unlimited" real?). */
export interface RelayReport {
  /** The last small check message, when one was sent. */
  health?: RelayProbe;
  /** Small check messages sent, and how many answered. */
  probes: number;
  probesOk: number;
  /** Attempts in the report (the last 200). */
  runs: number;
  done: number;
  partial: number;
  failed: number;
  /** Runs that stopped part way and were handed to the next agent (not counted as failed). */
  handedOff: number;
  /** "Too many requests" answers: none means no limit was seen. */
  rateLimited: number;
  /** The last one (ms). */
  lastRateLimitAt?: number;
  /** Average minutes of a finished (done or partial) run. */
  avgMinutes?: number;
  /** Since (ms): the first attempt in the report. */
  since?: number;
  /** The last attempts, newest first (up to 20). */
  recent: RelayRun[];
}

/** Relay task runs in a row that must fail before the 15-minute availability checks start again (Roee, 27.11). */
export const RELAY_FAILS_BEFORE_PROBE = 3;

/**
 * Whether the relay's small availability check should run (Roee, 27.11: GhostCLI answers reliably now, so stop
 * checking it all the time and check again only after it failed several times in a row). It runs when nothing is
 * known yet, while the last check said it does not answer (until it answers again), or after
 * {@link RELAY_FAILS_BEFORE_PROBE} task runs in a row ended failed or rate-limited.
 *
 * @param log - The attempts, oldest first.
 * @param health - The last check, if any.
 * @returns True when a check should run (the caller still spaces checks 15 minutes apart).
 */
export function relayNeedsProbe(log: readonly RelayRun[], health: { ok: boolean; at: number } | undefined): boolean {
  if (!health || !health.ok) return true;
  const runs = log.filter((r) => r.status !== "probe-ok" && r.status !== "probe-failed" && r.at > health.at);
  const tail = runs.slice(-RELAY_FAILS_BEFORE_PROBE);
  return tail.length === RELAY_FAILS_BEFORE_PROBE && tail.every((r) => r.status === "failed" || r.status === "rate-limited");
}

/**
 * Sums relay attempts into the trial report.
 *
 * @param log - The attempts, oldest first.
 * @returns The report.
 */
export function relayReport(log: readonly RelayRun[]): RelayReport {
  const probes = log.filter((r) => r.status === "probe-ok" || r.status === "probe-failed");
  const tasks = log.filter((r) => r.status !== "probe-ok" && r.status !== "probe-failed");
  const finished = tasks.filter((r) => r.status === "done" || r.status === "partial");
  const limited = tasks.filter((r) => r.status === "rate-limited");
  return {
    probes: probes.length,
    probesOk: probes.filter((r) => r.status === "probe-ok").length,
    runs: tasks.length,
    done: tasks.filter((r) => r.status === "done").length,
    partial: tasks.filter((r) => r.status === "partial").length,
    failed: tasks.filter((r) => r.status === "failed" || r.status === "declined").length,
    handedOff: tasks.filter((r) => r.status === "handed-off").length,
    rateLimited: limited.length,
    ...(limited.length ? { lastRateLimitAt: limited[limited.length - 1]!.at } : {}),
    ...(finished.length ? { avgMinutes: Math.round(finished.reduce((n, r) => n + r.ms, 0) / finished.length / 6_000) / 10 } : {}),
    ...(tasks.length ? { since: tasks[0]!.at } : {}),
    recent: tasks.slice(-20).reverse(),
  };
}

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
  /** GhostCLI now: its connection, today's count, its models and cooldowns (its own executor). */
  ghostcli?: GhostcliState;
  /** The relay's trial report (GhostCLI), once it ran a task. */
  relay?: RelayReport;
  /** Antigravity's quota as read on the PC (antigravity-quota.ts), when Antigravity runs. */
  agQuota?: AntigravityQuota;
  /** Why the last reading found nothing (Antigravity closed, no port, another answer shape). */
  agQuotaWhy?: string;
  /** Claude Code on this PC: installed, signed in, its quota reading and whether a task may start. */
  claude?: ClaudeState;
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

/** One Antigravity model's quota as Antigravity's local language server reports it (antigravity-quota.ts). */
export interface AntigravityModelQuota {
  name: string;
  /** What is left, 0..1 (0 = used up). */
  left: number;
  /** When it fills again (ms since epoch), when the answer says. */
  resetAt?: number;
}

/** Antigravity's quota, read on the PC (read-only, every few minutes while Antigravity runs). */
export interface AntigravityQuota {
  at: number;
  models: AntigravityModelQuota[];
}

/** A short summary for a line: the best model's share left and, when all are used up, the earliest reset. */
export function antigravityQuotaSummary(q: AntigravityQuota): { left: number; resetAt?: number } {
  const left = Math.max(0, ...q.models.map((m) => m.left));
  const resets = q.models.filter((m) => m.left <= 0 && m.resetAt).map((m) => m.resetAt!);
  return { left, ...(left <= 0 && resets.length ? { resetAt: Math.min(...resets) } : {}) };
}
