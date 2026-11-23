/** The connection id of the user's OpenCode Go plan (packages/providers/src/presets.ts). */
export const OPENCODE_PROVIDER = "opencode-go";
/** The defaults: a cheap model for small work, a stronger (still cheap) one for the rest, 15 a day. */
// Defaults by cost (Go plan, 2026-11-22, requests a month): Kimi K3 ~98 (44 requests spent a 5-hour window and 20% of
// the month), MiMo-V2.6-Pro ~3,260, MiMo-V2.6-Flash ~30,100. An agent task makes tens of requests, so the cheap pair.
export const OPENCODE_DEFAULTS = { enabled: true, small: "opencode-go/mimo-v2.6-flash", strong: "opencode-go/mimo-v2.6-pro", dailyCap: 15 };
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
export const OPENCODE_FREE_MODELS = ["opencode-go/beam-free", "opencode-go/iceman-contributor-free"];
/** Whether a model is one of the plan's free ones (does not count toward the daily cap). */
export const isFreeOpencodeModel = (id) => OPENCODE_FREE_MODELS.includes(id);
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
    { id: "opencode-go/iceman-contributor-free", name: "Iceman Contributor Free", requests: Infinity },
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
export const opencodeModelName = (id) => id.replace(new RegExp(`^${OPENCODE_PROVIDER}/`), "");
/**
 * The inbox's `lastError` when the git program cannot be started (not installed, or not on PATH). The page shows its
 * own Hebrew and English text for it instead of the raw system message (on Windows, cmd.exe's "is not recognized").
 */
export const INBOX_GIT_MISSING = "Git for Windows is not installed / not found: install it from git-scm.com (or `winget install Git.Git`) and restart KesherAI.";
/** What the PC answers (HTTP 409) when Run is pressed on an Antigravity task while another one runs. */
export const BUSY_RUN_TEXT = { he: "משימה רצה, אין להריץ עד שתסתיים", en: "A task is running; do not run another until it ends" };
