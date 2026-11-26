import { freeTierTrains } from "./training-risk.js";
/** The connection id of the user's OpenCode Go plan (packages/providers/src/presets.ts). */
export const OPENCODE_PROVIDER = "opencode-go";
/** The defaults: a cheap model for small work, a stronger (still cheap) one for the rest, 15 a day. */
// Defaults by cost (Go plan, 2026-11-22, requests a month): Kimi K3 ~98 (44 requests spent a 5-hour window and 20% of
// the month), MiMo-V2.6-Pro ~3,260, MiMo-V2.6-Flash ~30,100. An agent task makes tens of requests, so the cheap pair.
export const OPENCODE_DEFAULTS = { enabled: true, small: "opencode-go/mimo-v2.6-flash", strong: "opencode-go/mimo-v2.6-pro", dailyCap: 15, freeTrainingOk: true };
/**
 * The OpenCode Go model for a task, by its size: the cheap one for S, the strong one for M and L (like OpenCode's own
 * `small_model` beside `model`, and Cline's separate Plan and Act models). A task's own `model` that names an OpenCode
 * Go model wins.
 *
 * @param t - The task's size and model.
 * @param s - The OpenCode Go settings.
 * @returns The KesherAI model id (`opencode-go/<model>`).
 */
export function opencodeModelFor(t, s) {
    if (t.model?.startsWith(`${OPENCODE_PROVIDER}/`))
        return t.model;
    return t.size === "S" ? s.small || OPENCODE_DEFAULTS.small : s.strong || OPENCODE_DEFAULTS.strong;
}
/**
 * The models a task falls back to when its own model answers 429, in order (after the configured small and strong
 * ones). Kimi is never here: it has ~98 requests a month, so it runs only when the user configured or chose it.
 */
/** OpenCode Go's free models (unlimited while the offer lasts), tried first when `useFree` is on and the connection lists them. */
// Not the "Contributor" free models (Iceman Contributor Free): those answer 400 without the plan's data-sharing
// opt-in, and sharing Roee's code for training is not wanted.
export const OPENCODE_FREE_MODELS = ["opencode-go/beam-free"];
/** Whether a model is one of the plan's free ones (does not count toward the daily cap). */
/** OpenRouter's free tier without a credit purchase: 50 requests a day (20 a minute); failed attempts count (2026-11-23). */
export const OPENROUTER_FREE_DAILY = 50;
/** OpenRouter's free router (`openrouter/free`: picks an open free model by itself), as a KesherAI model id. */
export const OPENROUTER_FREE_ROUTER = "openrouter/openrouter/free";
/** Z.ai's free models (one request at a time; unpublished daily caps), as KesherAI model ids; the first is the coding one. */
export const ZAI_FREE_MODELS = ["zai/glm-4.7-flash", "zai/glm-4.5-flash"];
/** Coding-model names first (stable otherwise), at most `max`. */
const coderFirst = (ids, max) => [...ids].sort((a, b) => Number(/coder|devstral|codestral/i.test(b)) - Number(/coder|devstral|codestral/i.test(a))).slice(0, max);
/**
 * Whether a KesherAI model id is one of OpenRouter's FREE models: the free router, or `openrouter/<provider>/<model>:free`.
 * Any other OpenRouter id (paid) is never allowed in the inbox ({@link inboxModelAllowed}).
 *
 * @param id - The KesherAI model id.
 */
export function isOpenrouterFreeModel(id) {
    return id === OPENROUTER_FREE_ROUTER || /^openrouter\/[\w.-]+\/[\w.-]+:free$/.test(id);
}
/** Cloudflare Workers AI: the free 10,000 Neurons a day (resets 00:00 UTC) cover only a few small tasks. */
const isCloudflareModel = (id) => /^cloudflare-ai\/@cf\/[\w./:-]+$/.test(id);
/** Gemini's free tier: the Flash and Flash-Lite models only (never Pro). */
const isGeminiFree = (id) => /^gemini\/(models\/)?gemini-[\w.-]*flash[\w.-]*$/i.test(id);
/** Services that are chat/research only: too small for an agent loop, never in the inbox's coder order. */
export const CHAT_ONLY_PROVIDERS = ["sambanova", "cohere", "ollama-cloud"];
const isContributorFree = (id) => /^opencode-go\/[\w.-]*contributor-free$/.test(id);
/** The free services, in the order they are tried (after Beam Free). */
export const FREE_PROVIDERS = [
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
/** Opus first, then Sonnet, then GLM 5.x and the rest; Haiku-size models are skipped (heavy tasks only). */
const relayRank = (id) => (/opus/i.test(id) ? 0 : /sonnet/i.test(id) ? 1 : /fable/i.test(id) ? 2 : /glm-5/i.test(id) ? 3 : 4);
/** The relays the task inbox can use. */
export const RELAY_PROVIDERS = [
    {
        id: "ghostcli",
        name: "GhostCLI",
        allowed: (id) => /^ghostcli\/[\w./:-]+$/.test(id),
        pick: (l) => l.filter((m) => m.startsWith("ghostcli/") && !/haiku|mini|nano|flash/i.test(m)).sort((a, b) => relayRank(a) - relayRank(b)).slice(0, 3),
    },
];
/** The relay a model id belongs to. */
export const relayProviderOf = (id) => RELAY_PROVIDERS.find((p) => p.allowed(id));
/**
 * Whether a task may go to a relay (Roee, 25.11: "heavy tasks without sensitive information"): any size, but not high
 * risk, path-limited, and nothing security-related in its paths or text. The caller also scans the prompt, and the leak
 * guard hides secrets in every request (the relay is in the training-risk table).
 *
 * @param t - The task.
 * @returns `ok`, or `why` (English) it stays with the other models.
 */
export function safeForRelay(t) {
    if (t.risk === "high")
        return { ok: false, why: "high-risk tasks stay off the relay" };
    const paths = t.allowedPaths ?? [];
    if (!paths.length)
        return { ok: false, why: "the task has no path limit" };
    const bad = paths.find((g) => SECURITY_PATH.test(g) || /^\.github(\/|$)|(^|\/)\.env/.test(g) || /^\*{0,2}(\/\*\*)?$/.test(g));
    if (bad)
        return { ok: false, why: `its paths touch a sensitive or unlimited area (${bad})` };
    const text = [t.title, t.goal, t.readFirst, t.acceptance, t.outOfScope].filter(Boolean).join("\n");
    if (SECURITY_WORDS.test(text))
        return { ok: false, why: "its text mentions a security topic" };
    return { ok: true };
}
/** The free service a model id belongs to, when it is one of the free tier's models. */
export const freeProviderOf = (id) => FREE_PROVIDERS.find((p) => p.allowed(id));
/** Whether a model is a free one (the plan's Beam Free or a free service's): it does not count toward the daily cap. */
export const isFreeOpencodeModel = (id) => OPENCODE_FREE_MODELS.includes(id) || !!freeProviderOf(id);
/**
 * The guard for the inbox's automatic runs. A model of a free service's connection (OpenRouter, Z.ai, Cloudflare, Gemini,
 * Mistral, NVIDIA) must be one of its free ones; one of a service that may train on data needs `freeTrainingOk`; the
 * chat-only services never run; other ids are the OpenCode Go plan's own.
 *
 * @param id - The KesherAI model id.
 * @param freeTrainingOk - The user's setting (default false).
 * @param relayOk - This task passed {@link safeForRelay} and the relay is on (default false).
 */
export function inboxModelAllowed(id, freeTrainingOk = false, relayOk = false) {
    if (CHAT_ONLY_PROVIDERS.some((p) => id.startsWith(`${p}/`)))
        return false;
    if (relayProviderOf(id))
        return relayOk;
    const fp = freeProviderOf(id);
    if (fp)
        return !fp.trainsOnData || freeTrainingOk;
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
export function safeForTrainingProvider(t) {
    if (t.kind === "research")
        return { ok: false, why: "research and report tasks stay off training services" };
    if (t.risk !== "low")
        return { ok: false, why: "only low-risk tasks go to services that may train" };
    if (t.size !== "S")
        return { ok: false, why: "only small (S) tasks go to services that may train" };
    const paths = t.allowedPaths ?? [];
    if (!paths.length)
        return { ok: false, why: "the task has no path limit" };
    const bad = paths.find((g) => SECURITY_PATH.test(g) || /^\.github(\/|$)|(^|\/)\.env/.test(g) || /^\*{0,2}(\/\*\*)?$/.test(g));
    if (bad)
        return { ok: false, why: `its paths touch a sensitive or unlimited area (${bad})` };
    const text = [t.title, t.goal, t.readFirst, t.acceptance, t.outOfScope].filter(Boolean).join("\n");
    if (SECURITY_WORDS.test(text))
        return { ok: false, why: "its text mentions a security topic" };
    return { ok: true };
}
/**
 * The free service models to try for a small task, in order: each connected service's picks, skipping the ones that may
 * train on data unless allowed. Only what each connection lists now.
 *
 * @param listed - Per connection id, the models it lists (`<connection>/<model>`); absent: not connected.
 * @param freeTrainingOk - The user's setting.
 */
export function freeModelsFor(listed, freeTrainingOk = false) {
    return FREE_PROVIDERS.filter((p) => (freeTrainingOk || !p.trainsOnData) && listed[p.id]).flatMap((p) => p.pick(listed[p.id]));
}
/**
 * The free models to try first: on unless turned off, and only those the connection lists now (the offer is "for a
 * limited time"; an empty or unknown list means none).
 *
 * @param s - The OpenCode Go settings.
 * @param listed - The models the connection lists.
 */
export function opencodeFreeFirst(s, listed) {
    return s.useFree === false ? [] : OPENCODE_FREE_MODELS.filter((m) => listed.includes(m));
}
export const OPENCODE_FALLBACKS = ["opencode-go/mimo-v2.6-flash", "opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3", "opencode-go/mimo-v2.6-pro"];
/** What the Go plan ($10) allows a month, per model (approximate, 2026-11-22), shown in the OpenCode card. */
export const OPENCODE_MONTHLY_REQUESTS = [
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
export function opencodeModelOrder(s) {
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
export function opencodeFreeModel(order, until, now, first, skip = []) {
    const free = (m) => !skip.includes(m) && (until[m] ?? 0) <= now;
    if (first && free(first))
        return first;
    return order.find(free);
}
/** A model id without its connection (`opencode-go/kimi-k3` → `kimi-k3`), for cards. */
export const opencodeModelName = (id) => id.replace(new RegExp(`^(${OPENCODE_PROVIDER}|openrouter|mistral|nvidia-nim|zai)/`), "");
/**
 * The inbox's `lastError` when the git program cannot be started (not installed, or not on PATH). The page shows its
 * own Hebrew and English text for it instead of the raw system message (on Windows, cmd.exe's "is not recognized").
 */
export const INBOX_GIT_MISSING = "Git for Windows is not installed / not found: install it from git-scm.com (or `winget install Git.Git`) and restart KesherAI.";
/**
 * Sums relay attempts into the trial report.
 *
 * @param log - The attempts, oldest first.
 * @returns The report.
 */
export function relayReport(log) {
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
        rateLimited: limited.length,
        ...(limited.length ? { lastRateLimitAt: limited[limited.length - 1].at } : {}),
        ...(finished.length ? { avgMinutes: Math.round(finished.reduce((n, r) => n + r.ms, 0) / finished.length / 6_000) / 10 } : {}),
        ...(tasks.length ? { since: tasks[0].at } : {}),
        recent: tasks.slice(-20).reverse(),
    };
}
/** What the PC answers (HTTP 409) when Run is pressed on an Antigravity task while another one runs. */
export const BUSY_RUN_TEXT = { he: "משימה רצה, אין להריץ עד שתסתיים", en: "A task is running; do not run another until it ends" };
/** A short summary for a line: the best model's share left and, when all are used up, the earliest reset. */
export function antigravityQuotaSummary(q) {
    const left = Math.max(0, ...q.models.map((m) => m.left));
    const resets = q.models.filter((m) => m.left <= 0 && m.resetAt).map((m) => m.resetAt);
    return { left, ...(left <= 0 && resets.length ? { resetAt: Math.min(...resets) } : {}) };
}
