/**
 * The inbox's `lastError` when the git program cannot be started (not installed, or not on PATH). The page shows its
 * own Hebrew and English text for it instead of the raw system message (on Windows, cmd.exe's "is not recognized").
 */
export const INBOX_GIT_MISSING = "Git for Windows is not installed / not found: install it from git-scm.com (or `winget install Git.Git`) and restart KesherAI.";
/** What the PC answers (HTTP 409) when Run is pressed on an Antigravity task while another one runs. */
export const BUSY_RUN_TEXT = { he: "משימה רצה, אין להריץ עד שתסתיים", en: "A task is running; do not run another until it ends" };
