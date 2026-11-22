/** The connection id of the user's OpenCode Go plan (packages/providers/src/presets.ts). */
export const OPENCODE_PROVIDER = "opencode-go";
/** The defaults (Roee, 2026-11-22: GLM 5.3 Flash for small work, Kimi K3 for the rest, 15 a day). */
export const OPENCODE_DEFAULTS = { enabled: true, small: "opencode-go/glm-5.3-flash", strong: "opencode-go/kimi-k3", dailyCap: 15 };
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
/** A model id without its connection (`opencode-go/kimi-k3` → `kimi-k3`), for cards. */
export const opencodeModelName = (id) => id.replace(new RegExp(`^${OPENCODE_PROVIDER}/`), "");
/**
 * The inbox's `lastError` when the git program cannot be started (not installed, or not on PATH). The page shows its
 * own Hebrew and English text for it instead of the raw system message (on Windows, cmd.exe's "is not recognized").
 */
export const INBOX_GIT_MISSING = "Git for Windows is not installed / not found: install it from git-scm.com (or `winget install Git.Git`) and restart KesherAI.";
/** What the PC answers (HTTP 409) when Run is pressed on an Antigravity task while another one runs. */
export const BUSY_RUN_TEXT = { he: "משימה רצה, אין להריץ עד שתסתיים", en: "A task is running; do not run another until it ends" };
