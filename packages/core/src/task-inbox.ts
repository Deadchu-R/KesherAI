import type { InboxExecutor, InboxFrom, InboxRisk, InboxSettings, InboxStatus, InboxTaskSpec, InboxTaskView } from "@kesher/shared";

/**
 * The task inbox's files and rules (docs/RESEARCH_LOG.md, "A task inbox"; docs/INBOX.md has the template Claude
 * writes). Tasks travel on the `kesher-inbox` git branch as `tasks/<id>.md`; KesherAI answers with `results/<id>.md`
 * there and the work itself on an `agy/<id>-<slug>` branch. Everything in a task file is data written by someone
 * else: it is parsed and checked here, shown to the user, and never run as a command (a task's `check` runs only in
 * the parts that are on the user's own allowed command list; see `checkParts`).
 */

/** The inbox branch's default name. */
export const INBOX_BRANCH = "kesher-inbox";

/** Paths a task may never change, whatever it says (added to its own list). */
export const ALWAYS_FORBIDDEN = [".github/**", ".env*", "**/.env*", "pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "scripts/release*", "docs/SECURITY_REVIEW.md", ".kesher/**", "**/*.pem", "**/*.key"];

/** The defaults of Settings > Task inbox (Roee, 2026-11-19: 10 Antigravity tasks a day, Gemini's default model). */
export const INBOX_DEFAULTS: InboxSettings = {
  enabled: false,
  paused: false,
  branch: INBOX_BRANCH,
  fetchMinutes: 5,
  dailyCap: 10,
  maxMinutes: 15,
  model: "",
  allowedPaths: ["apps/**", "packages/*/src/**", "plugins/**", "docs/**"],
  forbiddenPaths: [...ALWAYS_FORBIDDEN],
  commands: ["pnpm -s typecheck", "pnpm -s lint", "node --test", "node --conditions=source --import tsx --test", "git status", "git diff", "git log", "git show", "rg", "ls"],
  notWhileGame: true,
  notWhileEditor: true,
  gpuBusyPercent: 40,
};

const EXECUTORS = new Set<InboxExecutor>(["auto", "antigravity", "local", "opus"]);
const RISKS = new Set<InboxRisk>(["low", "medium", "high"]);
const FROM = new Set<InboxFrom>(["claude", "roee", "self-work", "hub", "device"]);
/** The biggest task file read (bigger ones are refused, not cut). */
export const MAX_TASK_BYTES = 32 * 1024;

/**
 * Whether a task id is well formed: lowercase letters, digits and dashes, starting with a letter (`c-20261119-04`).
 *
 * @param id - The id.
 */
export function validTaskId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,47}$/.test(id) && !id.includes("--") && !id.endsWith("-");
}

/**
 * Whether a name is a safe git branch name: only `a-z 0-9 . _ / -`, no `..`, no `//`, no leading or trailing `/`
 * or `.`, no `.lock` end, at most 100 characters (stricter than `git check-ref-format`).
 *
 * @param name - The branch's short name (no `refs/heads/`).
 */
export function validBranchName(name: string): boolean {
  if (!/^[a-z0-9][a-z0-9._/-]{0,99}$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("/.") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return true;
}

/**
 * The only refs KesherAI may push (Roee, 2026-11-19): `agy/*` branches and the inbox branch. Nothing else: not `main`,
 * not `release`, no tags, no force (`+`), no `src:dst` mapping, no deleting (`:ref`), no options.
 *
 * @param ref - What would be pushed, as given to `git push origin <ref>`.
 * @param inboxBranch - The inbox branch's name (Settings).
 * @returns Whether it may be pushed.
 */
export function pushAllowed(ref: string, inboxBranch = INBOX_BRANCH): boolean {
  if (typeof ref !== "string" || !validBranchName(ref)) return false;
  if (ref === inboxBranch && validBranchName(inboxBranch) && !inboxBranch.includes("/") && inboxBranch !== "main" && inboxBranch !== "master" && inboxBranch !== "release") return true;
  return /^agy\/[a-z0-9][a-z0-9._-]*$/.test(ref);
}

/**
 * Pushes one ref to `origin`, after {@link pushAllowed}; the single place in the inbox that pushes.
 *
 * @param git - Runs git (arguments as a list, no shell).
 * @param repo - The folder.
 * @param ref - The branch.
 * @param inboxBranch - The inbox branch's name.
 * @throws When the ref is not allowed (nothing runs) or the push failed.
 */
export async function pushRef(git: (cwd: string, args: string[]) => Promise<{ code: number; out: string }>, repo: string, ref: string, inboxBranch = INBOX_BRANCH): Promise<void> {
  if (!pushAllowed(ref, inboxBranch)) throw new Error(`KesherAI may push only agy/* branches and ${inboxBranch}; refused: ${ref.slice(0, 80)}`);
  const r = await git(repo, ["push", "--no-verify", "origin", `refs/heads/${ref}:refs/heads/${ref}`]);
  if (r.code !== 0) throw new Error(`git push failed: ${r.out.slice(0, 300)}`);
}

/** A slug for a branch: lowercase latin letters, digits and dashes, at most 30 characters. */
export function slugOf(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "task";
}

/**
 * The work branch for a task: `agy/<id>-<slug>` (Antigravity), `local/<id>-<slug>` (self-work, never pushed) or
 * `helper/<id>-<slug>` (Claude's Opus agent, in the cloud); `-partial` when the work was kept unfinished.
 *
 * @param spec - The task.
 * @param runBy - Its executor after routing.
 * @param partial - Unfinished work.
 */
export function branchFor(spec: Pick<InboxTaskSpec, "id" | "title">, runBy: Exclude<InboxExecutor, "auto">, partial = false): string {
  const prefix = runBy === "antigravity" ? "agy" : runBy === "local" ? "local" : "helper";
  const name = `${prefix}/${spec.id}-${slugOf(spec.title)}${partial ? "-partial" : ""}`;
  if (!validBranchName(name)) throw new Error("Bad branch name.");
  return name;
}

/** Text the routing reads as security or infrastructure (always Claude's Opus agent). */
const SENSITIVE = /secur|auth|token|password|secret|share.?link|updater|release|migrat|\bgit\b|\bacp\b|אבטח|טוקן|סיסמ/i;

/**
 * Picks the executor for a task whose spec says `auto` (the research entry's table): the local model for small
 * mechanical work, Antigravity for medium well-specified work with a check, Claude's Opus agent for hard, risky,
 * vague or security work.
 *
 * @param spec - The task.
 * @returns Its executor.
 */
export function routeTask(spec: Pick<InboxTaskSpec, "executor" | "risk" | "title" | "goal" | "check" | "acceptance" | "maxFiles">): Exclude<InboxExecutor, "auto"> {
  if (spec.executor !== "auto") return spec.executor;
  if (spec.risk === "high" || SENSITIVE.test(`${spec.title}\n${spec.goal}`)) return "opus";
  if (!spec.check.trim() || !spec.acceptance?.trim()) return "opus";
  if (spec.maxFiles <= 2 && spec.risk === "low") return "local";
  if (spec.maxFiles <= 15) return "antigravity";
  return "opus";
}

/** Splits a frontmatter list: `[a, "b"]` on one line, or `- a` lines after the key. */
function listOf(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  const s = (v ?? "").trim();
  if (!s) return [];
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  return inner.split(",").map((x) => unquote(x.trim())).filter(Boolean);
}

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

/** A path glob a task may name: relative, no `..`, no drive letters, no backslashes. */
function cleanGlob(g: string): string | undefined {
  const s = g.trim();
  if (!s || s.length > 120 || s.startsWith("/") || s.startsWith("~") || /^[a-z]:/i.test(s) || s.includes("\\") || s.split("/").includes("..")) return undefined;
  return /^[\w.*?/@{},-]+$/.test(s) ? s : undefined;
}

/**
 * Reads a task file: frontmatter between `---` lines (`key: value`, lists as `[a, b]` or `- a` lines), then
 * `## Goal`, `## Read first`, `## Acceptance`, `## Out of scope`, `## Report` sections.
 *
 * @param text - The file's text.
 * @param fileId - The id from its file name (`tasks/<id>.md`); the frontmatter's id must match it.
 * @param defaults - The inbox's settings (paths, limits).
 * @returns The task, or an error that says what is wrong (the task is then shown as declined).
 */
export function parseTaskFile(text: string, fileId: string, defaults: Pick<InboxSettings, "maxMinutes" | "allowedPaths" | "forbiddenPaths">): { spec: InboxTaskSpec } | { error: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_TASK_BYTES) return { error: "The task file is bigger than 32 KB." };
  if (!validTaskId(fileId)) return { error: "The task's file name is not a valid id." };
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { error: "The task has no frontmatter (--- lines)." };
  const fm: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of m[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = fm[listKey];
      fm[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1]!.trim())];
      continue;
    }
    const kv = /^([a-z_]{1,30}):\s*(.*)$/.exec(line);
    if (!kv) return { error: `A frontmatter line is not "key: value": ${line.slice(0, 60)}` };
    listKey = kv[2] ? undefined : kv[1]!;
    fm[kv[1]!] = kv[2] ? unquote(kv[2].trim()) : [];
  }
  const str = (k: string, max = 300) => {
    const v = fm[k];
    return (Array.isArray(v) ? v.join(", ") : (v ?? "")).trim().slice(0, max);
  };
  const id = str("id", 60) || fileId;
  if (id !== fileId) return { error: `The id (${id}) does not match the file name (${fileId}).` };
  const title = str("title", 200);
  if (!title) return { error: "The task has no title." };
  const executor = (str("executor", 20) || "auto") as InboxExecutor;
  if (!EXECUTORS.has(executor)) return { error: "executor must be auto, antigravity, local or opus." };
  const risk = (str("risk", 10) || "medium") as InboxRisk;
  if (!RISKS.has(risk)) return { error: "risk must be low, medium or high." };
  const from = (str("from", 20) || "claude") as InboxFrom;
  if (!FROM.has(from)) return { error: "from must be claude, roee, self-work or hub." };
  const base = str("base", 100) || "origin/main";
  if (!validBranchName(base) && !/^[0-9a-f]{7,40}$/.test(base)) return { error: "base is not a valid branch or commit." };
  const globs = (k: string) => {
    const all = listOf(fm[k]);
    const bad = all.filter((g) => !cleanGlob(g));
    return bad.length ? { bad } : { list: all.map((g) => cleanGlob(g)!).slice(0, 40) };
  };
  const allowed = globs("allowed_paths");
  const forbidden = globs("forbidden_paths");
  if ("bad" in allowed || "bad" in forbidden) return { error: `A path is not allowed (absolute, outside the project or odd characters): ${[...("bad" in allowed ? allowed.bad! : []), ...("bad" in forbidden ? forbidden.bad! : [])].join(", ").slice(0, 120)}` };
  const num = (k: string, def: number, min: number, max: number) => {
    const n = Number(str(k, 10));
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };
  const model = str("model", 80);
  if (model && !/^[\w .:/()-]+$/.test(model)) return { error: "model has odd characters." };
  // Sections: "## Goal" and the others; anything before the first heading counts as the goal.
  const body = m[2] ?? "";
  const sections: Record<string, string> = {};
  let cur = "goal";
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1]!.toLowerCase().replace(/[^a-z ]/g, "").trim();
      continue;
    }
    sections[cur] = `${sections[cur] ?? ""}${line}\n`;
  }
  const sec = (k: string) => (sections[k] ?? "").trim().slice(0, 6000) || undefined;
  const goal = sec("goal");
  if (!goal) return { error: "The task has no Goal." };
  const spec: InboxTaskSpec = {
    id,
    title,
    executor,
    risk,
    from,
    base,
    allowedPaths: allowed.list!.length ? allowed.list! : [...defaults.allowedPaths],
    // The task may add paths it must not touch, never remove the standing ones.
    forbiddenPaths: [...new Set([...defaults.forbiddenPaths, ...ALWAYS_FORBIDDEN, ...forbidden.list!])],
    check: str("check", 300),
    maxMinutes: num("max_minutes", defaults.maxMinutes, 1, 60),
    maxFiles: num("max_files", 15, 1, 60),
    ...(model ? { model } : {}),
    goal,
    ...(sec("read first") ? { readFirst: sec("read first")! } : {}),
    ...(sec("acceptance") ? { acceptance: sec("acceptance")! } : {}),
    ...(sec("out of scope") ? { outOfScope: sec("out of scope")! } : {}),
    ...(sec("report") ? { report: sec("report")! } : {}),
  };
  return { spec };
}

/**
 * Writes a task file (the phone's "+ Task" and the hub's tasks), in the same format {@link parseTaskFile} reads.
 *
 * @param s - The task.
 */
export function taskFileText(s: InboxTaskSpec): string {
  const one = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const list = (l: string[]) => `[${l.map((x) => one(x)).join(", ")}]`;
  return [
    "---",
    `id: ${s.id}`,
    `title: ${one(s.title)}`,
    `from: ${s.from}`,
    `executor: ${s.executor}`,
    `risk: ${s.risk}`,
    `base: ${s.base}`,
    `allowed_paths: ${list(s.allowedPaths)}`,
    `forbidden_paths: ${list(s.forbiddenPaths.filter((p) => !ALWAYS_FORBIDDEN.includes(p)))}`,
    `check: ${one(s.check)}`,
    `max_minutes: ${s.maxMinutes}`,
    `max_files: ${s.maxFiles}`,
    ...(s.model ? [`model: ${one(s.model)}`] : []),
    "---",
    "",
    "## Goal",
    s.goal,
    ...(s.readFirst ? ["", "## Read first", s.readFirst] : []),
    ...(s.acceptance ? ["", "## Acceptance", s.acceptance] : []),
    ...(s.outOfScope ? ["", "## Out of scope", s.outOfScope] : []),
    ...(s.report ? ["", "## Report", s.report] : []),
    "",
  ].join("\n");
}

/** The status a result file says, from the queue's status. */
function resultStatus(s: InboxStatus): string {
  return s === "needs-approval" || s === "running" ? "needs-approval" : s;
}

/**
 * The result file KesherAI writes back (`results/<id>.md` on the inbox branch) for Claude to review.
 *
 * @param t - The task after its run.
 * @param checkTail - The check output's last lines.
 */
export function resultFileText(t: InboxTaskView, checkTail = ""): string {
  const minutes = t.startedAt && t.endedAt ? Math.round((t.endedAt - t.startedAt) / 6000) / 10 : undefined;
  return [
    "---",
    `id: ${t.id}`,
    `status: ${resultStatus(t.status)}`,
    `executor: ${t.runBy}`,
    `branch: ${t.pushed ? t.branch : ""}`,
    `base: ${t.base}`,
    `head_sha: ${t.headSha ?? ""}`,
    ...(minutes !== undefined ? [`minutes: ${minutes}`] : []),
    ...(t.modelUsed ? [`model: ${t.modelUsed.replace(/[\r\n]/g, " ")}`] : []),
    "---",
    "",
    "## Summary",
    (t.summary ?? t.note ?? "").trim().slice(0, 2000) || "(none)",
    "",
    "## Files",
    ...(t.files?.length ? t.files.map((f) => `- ${f.path} (+${f.added} -${f.removed})`) : ["(none)"]),
    "",
    "## Checks (run by KesherAI)",
    ...(t.checks?.length ? t.checks.map((c) => `- ${c.ok ? "ok" : "FAIL"} ${c.name}${c.command ? ` \`${c.command}\`` : ""}: ${c.note.replace(/\n/g, " ").slice(0, 200)}`) : ["(none)"]),
    ...(checkTail ? ["", "```", checkTail.slice(-3000), "```"] : []),
    ...(t.note && t.summary ? ["", "## Note", t.note] : []),
    "",
  ].join("\n");
}

/**
 * The prompt sent to the agent, once, when the user presses Run. The task's own text goes inside a marked block as
 * the task to do; the rules around it are KesherAI's and come first.
 *
 * @param s - The task.
 * @param branch - Its work branch.
 */
export function agentPrompt(s: InboxTaskSpec, branch: string): string {
  return [
    `You are working on one task in this folder, a git worktree on the branch ${branch}. Read AGENTS.md first and follow it.`,
    "Rules (from KesherAI, not from the task):",
    "- Do not run git push, git commit, git checkout, git switch, git reset, git rebase or git remote. Do not touch other branches. KesherAI commits and pushes after its own checks.",
    "- Do not install packages, do not use the network, do not read files outside this folder or secret files (.env, keys).",
    `- Change only files under: ${s.allowedPaths.join(", ")}. Never: ${s.forbiddenPaths.join(", ")}. At most ${s.maxFiles} files.`,
    "- No emails, user names, personal paths, keys or tokens in any file.",
    "- When done, end with a short report: what you changed (files), how you checked it, anything left open.",
    "",
    "<task>",
    `Title: ${s.title}`,
    "",
    `Goal:\n${s.goal}`,
    ...(s.readFirst ? ["", `Read first:\n${s.readFirst}`] : []),
    ...(s.acceptance ? ["", `Acceptance:\n${s.acceptance}`] : []),
    ...(s.outOfScope ? ["", `Out of scope:\n${s.outOfScope}`] : []),
    ...(s.check ? ["", `Check: ${s.check}`] : []),
    ...(s.report ? ["", `Report:\n${s.report}`] : []),
    "</task>",
  ].join("\n");
}

/**
 * Splits a task's check into commands KesherAI may run: `a && b`, each part a plain command (no `;`, `|`, `>`, `<`,
 * backticks, `$`, quotes) that starts with one of the allowed commands. Anything else is not run.
 *
 * @param check - The task's check text.
 * @param allowed - Settings > Task inbox > commands.
 * @returns The parts to run (as argument lists) and the parts refused.
 */
export function checkParts(check: string, allowed: string[]): { run: string[][]; refused: string[] } {
  const run: string[][] = [];
  const refused: string[] = [];
  for (const raw of check.split("&&").map((p) => p.trim()).filter(Boolean)) {
    const argv = raw.split(/\s+/);
    const ok = !/[;|<>`$"'\\&(){}\n]/.test(raw) && allowed.some((a) => {
      const want = a.trim().split(/\s+/);
      return want.length > 0 && want.every((w, i) => argv[i] === w);
    });
    if (ok) run.push(argv);
    else refused.push(raw.slice(0, 120));
  }
  return { run, refused };
}
