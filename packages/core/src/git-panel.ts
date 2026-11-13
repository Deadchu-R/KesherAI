import { execFile } from "node:child_process";

/**
 * The project's own git, for the code page's Changes panel (like Claude Code
 * Desktop's Changes card and Kilo's Changes tab, see docs/RESEARCH_LOG.md):
 * what changed since the last commit, a diff per file, commit, push, and
 * branches. It uses the git and sign-in already on the computer; nothing here
 * asks for a password (`GIT_TERMINAL_PROMPT=0`, so a push that needs one fails
 * with git's message instead of hanging).
 */

/** One changed file. */
export interface ChangedFile {
  path: string;
  /** Added, modified, deleted, renamed or new (untracked). */
  state: "A" | "M" | "D" | "R" | "?";
  added: number;
  removed: number;
  /** The old path of a renamed file. */
  from?: string;
}

/** The project's git state. */
export interface GitState {
  repo: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  /** Whether there is an `origin` to push to. */
  origin?: boolean;
  /** `owner/name` when origin is on GitHub. */
  github?: string;
  /** The last commit. */
  head?: { sha: string; subject: string };
}

/** What a git command printed. */
export interface GitResult {
  ok: boolean;
  out: string;
}

/**
 * Runs git in a folder.
 *
 * @param repo - The project folder.
 * @param args - git's arguments.
 * @param timeout - Milliseconds.
 * @returns Whether it succeeded, and its output (stdout, then stderr).
 */
export function git(repo: string, args: string[], timeout = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args],
      { cwd: repo, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`.trimEnd() || (err?.message ?? "") }),
    );
  });
}

/**
 * Reads `git status --porcelain=v1 --branch` output.
 *
 * @param text - Its output.
 * @returns Branch, upstream, ahead/behind and the files (without line counts).
 */
export function parseStatus(text: string): Pick<GitState, "branch" | "upstream" | "ahead" | "behind" | "files"> {
  const out: Pick<GitState, "branch" | "upstream" | "ahead" | "behind" | "files"> = { ahead: 0, behind: 0, files: [] };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const m = head.match(/^(?:No commits yet on |Initial commit on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
      if (m) {
        out.branch = m[1] === "HEAD" ? undefined : m[1];
        if (m[2]) out.upstream = m[2];
        out.ahead = Number(m[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
        out.behind = Number(m[3]?.match(/behind (\d+)/)?.[1] ?? 0);
      }
      continue;
    }
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    let from: string | undefined;
    if (path.includes(" -> ")) [from, path] = path.split(" -> ") as [string, string];
    const unq = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
    const state: ChangedFile["state"] = xy === "??" ? "?" : xy.includes("R") ? "R" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
    out.files.push({ path: unq(path), state, added: 0, removed: 0, ...(from ? { from: unq(from) } : {}) });
  }
  return out;
}

/**
 * `owner/name` of a GitHub remote URL.
 *
 * @param url - `https://github.com/o/r.git` or `git@github.com:o/r.git`.
 */
export function githubRepo(url: string): string | undefined {
  return url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)?.slice(1, 3).join("/");
}

/**
 * The project's state: branch, how far from its upstream, and the changed
 * files with their line counts.
 *
 * @param repo - The project folder.
 */
export async function gitState(repo: string): Promise<GitState> {
  const inside = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") return { repo: false, ahead: 0, behind: 0, files: [] };
  // `status` and `diff` both refresh the index, and two git processes may
  // not open .git/index at once (Windows: "index file open failed:
  // Permission denied"), so they run one after the other.
  const status = await git(repo, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
  const [numstat, remote, head] = await Promise.all([
    git(repo, ["diff", "HEAD", "--numstat", "-M"]),
    git(repo, ["remote", "get-url", "origin"]),
    git(repo, ["log", "-1", "--format=%h%x00%s"]),
  ]);
  const state: GitState = { repo: true, ...parseStatus(status.out) };
  const counts = new Map<string, [number, number]>();
  if (numstat.ok) {
    for (const l of numstat.out.split(/\r?\n/)) {
      const [a, r, ...p] = l.split("\t");
      if (!p.length) continue;
      // A rename shows as `old => new` or `dir/{old => new}/x`.
      const path = p.join("\t").replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
      counts.set(path, [Number(a) || 0, Number(r) || 0]);
    }
  }
  for (const f of state.files) {
    const c = counts.get(f.path);
    if (c) [f.added, f.removed] = c;
  }
  // New files are not in `git diff HEAD`: count their lines (small ones only).
  await Promise.all(
    state.files
      .filter((f) => f.state === "?")
      .slice(0, 200)
      .map(async (f) => {
        const d = await git(repo, ["diff", "--no-index", "--numstat", "--", nullDevice(), f.path]);
        f.added = Number(d.out.split("\t")[0]) || 0;
      }),
  );
  if (remote.ok) {
    state.origin = true;
    const gh = githubRepo(remote.out);
    if (gh) state.github = gh;
  }
  if (head.ok && head.out) {
    const [sha, subject] = head.out.split("\0");
    state.head = { sha: sha!, subject: subject ?? "" };
  }
  return state;
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/** A diff bigger than this is cut (the panel shows a note). */
const MAX_DIFF = 400 * 1024;

/**
 * The diff of one file, or of everything, against the last commit.
 *
 * @param repo - The project folder.
 * @param path - A changed file (from {@link gitState}); all files when empty.
 * @param untracked - Whether it is a new file git does not track yet.
 * @returns Unified diff text.
 */
export async function gitDiff(repo: string, path?: string, untracked = false): Promise<{ diff: string; cut: boolean }> {
  const r = untracked && path ? await git(repo, ["diff", "--no-index", "--", nullDevice(), path]) : await git(repo, ["diff", "HEAD", "-M", ...(path ? ["--", path] : [])]);
  const text = r.out;
  return text.length > MAX_DIFF ? { diff: text.slice(0, MAX_DIFF), cut: true } : { diff: text, cut: false };
}

/**
 * Commits every change (like Kilo: one commit of the whole working tree).
 *
 * @param repo - The project folder.
 * @param message - The commit message (first line, blank line, body).
 * @returns The new commit's short sha, or git's error.
 */
export async function gitCommit(repo: string, message: string): Promise<GitResult & { sha?: string }> {
  const msg = message.replace(/\r\n/g, "\n").trim();
  if (!msg) return { ok: false, out: "The commit message is empty." };
  const add = await git(repo, ["add", "-A"], 120_000);
  if (!add.ok) return add;
  const c = await git(repo, ["commit", "-m", msg], 120_000);
  if (!c.ok) return c;
  const sha = await git(repo, ["rev-parse", "--short", "HEAD"]);
  return { ...c, ...(sha.ok ? { sha: sha.out.trim() } : {}) };
}

/**
 * Pushes the current branch; the first push of a new branch sets its upstream.
 *
 * @param repo - The project folder.
 */
export async function gitPush(repo: string): Promise<GitResult> {
  const up = await git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  return git(repo, up.ok ? ["push"] : ["push", "-u", "origin", "HEAD"], 180_000);
}

/**
 * Fetches and fast-forwards the current branch (never a merge commit or rebase without the user).
 *
 * @param repo - The project folder.
 */
export function gitPull(repo: string): Promise<GitResult> {
  return git(repo, ["pull", "--ff-only"], 180_000);
}

/**
 * Local and remote branches, newest first.
 *
 * @param repo - The project folder.
 */
export async function gitBranches(repo: string): Promise<{ current?: string; local: string[]; remote: string[] }> {
  const [cur, refs] = await Promise.all([git(repo, ["branch", "--show-current"]), git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"])]);
  const local: string[] = [];
  const remote: string[] = [];
  for (const r of refs.out.split(/\r?\n/)) {
    if (r.startsWith("refs/heads/")) local.push(r.slice(11));
    else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) remote.push(r.slice(13));
  }
  return { ...(cur.ok && cur.out.trim() ? { current: cur.out.trim() } : {}), local: local.slice(0, 100), remote: remote.slice(0, 100) };
}

/** A branch name git accepts (and nothing that looks like an option). */
export function validBranch(name: string): boolean {
  return /^[\w][\w./-]{0,99}$/.test(name) && !name.includes("..") && !name.endsWith(".lock") && !name.endsWith("/") && !name.endsWith(".");
}

/**
 * Switches branch, or makes a new one from the current branch. A remote branch
 * (`origin/x`) becomes a local branch that tracks it.
 *
 * @param repo - The project folder.
 * @param name - The branch.
 * @param create - Make it first.
 */
export async function gitSwitch(repo: string, name: string, create = false): Promise<GitResult> {
  if (!validBranch(name)) return { ok: false, out: "That branch name is not valid." };
  if (create) return git(repo, ["switch", "-c", name]);
  const remote = name.match(/^([\w.-]+)\/(.+)$/);
  if (remote) {
    const remotes = await git(repo, ["remote"]);
    if (remotes.out.split(/\r?\n/).includes(remote[1]!)) return git(repo, ["switch", "--track", name]);
  }
  return git(repo, ["switch", name]);
}

/**
 * The last commits' messages, for writing a new one in the same style.
 *
 * @param repo - The project folder.
 * @param n - How many.
 */
export async function recentMessages(repo: string, n = 8): Promise<string[]> {
  const r = await git(repo, ["log", `-${n}`, "--format=%B%x00"]);
  return r.ok ? r.out.split("\0").map((m) => m.trim()).filter(Boolean) : [];
}

/**
 * The prompt that asks a model for a commit message (Kilo writes one from the
 * repo's recent commits; Desktop-he/Phone-he lines and trailers of
 * KesherAI's own commits come from there too).
 *
 * @param diff - What changed (cut to fit).
 * @param recent - The last commit messages.
 * @param budget - Characters the diff may take.
 */
export function commitPrompt(diff: string, recent: string[], budget = 12_000): string {
  const examples = recent.slice(0, 5).map((m) => m.slice(0, 1200)).join("\n---\n");
  const d = diff.length > budget ? `${diff.slice(0, budget)}\n… (diff cut)` : diff;
  return [
    "Write the git commit message for the changes below.",
    "Follow the style and structure of this repository's recent commit messages exactly: the same kind of first line, the same sections or extra lines, and the same trailer lines at the end (copy trailer lines such as Co-Authored-By word for word).",
    "Describe only what the diff actually changes. Reply with the message only: no quotes, no code fence, no explanation.",
    "",
    "Recent commit messages (separated by ---):",
    examples || "(none: write one short line, then a blank line and a few lines if needed)",
    "",
    "The diff:",
    d,
  ].join("\n");
}

/** The model's reply as a clean message (no fences or quotes around it). */
export function cleanMessage(text: string): string {
  let t = text.trim().replace(/^<think>[\s\S]*?<\/think>\s*/, "");
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1]!;
  if (/^".*"$/s.test(t)) t = t.slice(1, -1);
  return t.trim();
}
