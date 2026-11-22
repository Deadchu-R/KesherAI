import { isAbsolute, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import type { AcpPermission } from "./acp.js";
import { isLocalSite } from "./control-policy.js";
import { publicSite } from "./site-icon.js";

/**
 * The task inbox's rules for an agent's steps and for the work it returns (docs/RESEARCH_LOG.md, "A task inbox",
 * approvals policy). KesherAI decides from each permission request, not the agent: reads and edits inside the
 * worktree and the task's paths, and commands on the user's list, are allowed; git push and other history or
 * branch changes, installs, the network, secret files and anything outside the worktree are denied; the rest is
 * asked (the task waits for the user). After the turn the diff is checked again by KesherAI itself.
 */

/** What the policy decided, and the rule (English; the page translates the known ones). */
export interface PolicyVerdict {
  verdict: "allow" | "deny" | "ask";
  rule: string;
  /** The step in a few words (a command, `edit path`). */
  what: string;
}

/** The task's limits the policy needs. */
export interface PolicyContext {
  worktree: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  commands: string[];
  /** A research task: reading public web pages (fetch steps) is allowed; nothing is downloaded or run. */
  research?: boolean;
}

/**
 * Steps that would spend money: buying or topping up credits, upgrading a plan, billing, payment. Never allowed in a
 * task, whatever the agent says it is for (Roee, 2026-11-21: no extra payment, ever).
 */
const PAYMENT = /\b(buy|purchas\w*|top.?up|get|add)\s+(more\s+)?(ai\s+)?credits?\b|\bai credits?\b|\bupgrade\s+(your\s+|to\s+|the\s+)?(a\s+)?(plan|subscription|pro|ultra|tier)\b|\bbilling\b|\bpayments?\b|\bcheck.?out\b|\bsubscri(be|ption)\b/i;

/** Commands never allowed (the first word, or the first two). */
const DENY_COMMANDS: RegExp[] = [
  /^git\s+(push|checkout|switch|reset|rebase|remote|config|tag|branch|merge|pull|fetch|clone|cherry-pick|filter-branch|update-ref|worktree|commit|add|stash|clean|gc|reflog)\b/,
  /^(sudo|su|doas|runas|chmod|chown|icacls|takeown|reg|setx|netsh|schtasks|crontab|systemctl|launchctl)\b/,
  /^(curl|wget|ssh|scp|sftp|ftp|nc|ncat|telnet|rsync|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer)\b/i,
  /^(pnpm|npm|yarn|bun)\s+(add|install|i|ci|remove|rm|uninstall|update|up|upgrade|publish|link|dlx|exec|x)\b/,
  /^(npx|pnpx|bunx)\b/,
  /^(pip|pip3|uv|cargo|go|gem|brew|apt|apt-get|winget|choco|scoop)\s+(install|add|get)\b/,
  /^(rm|del|rmdir|rd|remove-item)\b.*(\s|^)(-rf?|\/s|-recurse)\b/i,
  /^(powershell|pwsh|cmd|bash|sh|zsh)\b/i,
  /^(gh|agy|claude|codex)\b/,
];

/** Files no step may read or change: secrets and keys. */
const SECRET_FILE = /(^|[\\/])(\.env(\.[\w.-]*)?|\.npmrc|\.netrc|\.git-credentials|id_(rsa|ed25519|ecdsa)(\.pub)?|[^\\/]+\.(pem|key|p12|pfx)|credentials(\.json)?|secrets?\.(json|ya?ml))$/i;

/** Pulls the fields a step names out of the agent's raw input (its JSON). */
function fieldsOf(raw: string | undefined): { command?: string; paths: string[] } {
  if (!raw) return { paths: [] };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { paths: [] };
  }
  const paths: string[] = [];
  let command: string | undefined;
  const walk = (x: unknown, key = "", depth = 0) => {
    if (depth > 4 || x == null) return;
    if (typeof x === "string") {
      if (/^(command|cmd|commandline|command_line|script)$/i.test(key)) command ??= x;
      else if (/(^|_)(path|file|filepath|file_path|abs_path|absolute_path|target|source|destination|dir|directory|cwd)$/i.test(key)) paths.push(x);
      return;
    }
    if (Array.isArray(x)) {
      if (/^(command|cmd|args|argv)$/i.test(key) && x.every((y) => typeof y === "string")) command ??= (x as string[]).join(" ");
      else x.slice(0, 30).forEach((y) => walk(y, key, depth + 1));
      return;
    }
    if (typeof x === "object") for (const [k, y] of Object.entries(x as Record<string, unknown>).slice(0, 40)) walk(y, k, depth + 1);
  };
  walk(v);
  return { ...(command ? { command: command.trim() } : {}), paths };
}

/**
 * Whether every address a fetch step names is a public http(s) page (a web search with no address passes). Addresses
 * are read from the step's input (`url`, `uri`, `href`, or any value with a scheme) and its title.
 *
 * @param p - The fetch step.
 * @returns False when any address is local, private, or not http(s).
 */
export function fetchTargetsPublic(p: AcpPermission): boolean {
  const found: string[] = [];
  const scheme = /^[a-z][a-z0-9+.-]*:/i;
  const walk = (x: unknown, key = "", depth = 0) => {
    if (depth > 4 || x == null) return;
    if (typeof x === "string") {
      if (/^(url|uri|href|link|address)s?$/i.test(key) || scheme.test(x.trim())) found.push(x.trim());
      return;
    }
    if (Array.isArray(x)) x.slice(0, 30).forEach((y) => walk(y, key, depth + 1));
    else if (typeof x === "object") for (const [k, y] of Object.entries(x as Record<string, unknown>).slice(0, 40)) walk(y, k, depth + 1);
  };
  try {
    walk(p.rawInput ? JSON.parse(p.rawInput) : undefined);
  } catch {
    // Not JSON: only the title is checked.
  }
  for (const m of (p.title ?? "").matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi)) found.push(m[0]);
  return found.every((raw) => {
    // A bare host ("example.org/page") is read as https.
    const address = scheme.test(raw) && !/^[\w.-]+:\d/.test(raw) ? raw : `https://${raw}`;
    try {
      const u = publicSite(address);
      return !isLocalSite(u.hostname) && !/\.(internal|lan|home|intranet|corp)$/i.test(u.hostname);
    } catch {
      return false;
    }
  });
}

/**
 * A path relative to the worktree, or undefined when it is outside it.
 *
 * @param worktree - The task's worktree.
 * @param p - A path the step names (absolute or relative to the worktree).
 */
export function insideWorktree(worktree: string, p: string): string | undefined {
  const root = resolve(worktree);
  const full = isAbsolute(p) ? resolve(p) : resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) return undefined;
  return relative(root, full).split(sep).join("/");
}

/**
 * Whether a project path matches a list of globs (.gitignore syntax: `apps/**`, `packages/*\/src/**`, `.env*`).
 *
 * @param path - Relative to the project, with `/`.
 * @param globs - The list.
 */
export function matchesAny(path: string, globs: string[]): boolean {
  if (!path || !globs.length) return false;
  return ignore().add(globs).ignores(path);
}

/** Whether a changed path is inside the allowed paths and outside the forbidden ones. */
export function pathAllowed(path: string, allowed: string[], forbidden: string[]): boolean {
  return matchesAny(path, allowed) && !matchesAny(path, forbidden) && !SECRET_FILE.test(path);
}

/**
 * Read-only commands a research task may run in its worktree (listing and reading the project to know what exists):
 * a research run once ended at once after "Get-ChildItem docs/research" was refused, and wrote nothing.
 */
export const RESEARCH_READ_COMMANDS = ["Get-ChildItem", "Get-Content", "Select-String", "ls", "dir", "cat", "type", "rg", "grep", "git log", "git show", "git status"];

/**
 * Formatting commands that may follow a research read command after `|` (`Get-ChildItem x | Select-Object Name`):
 * they only shape the output. A deep-research run stopped after "Get-ChildItem apps/web/src/pages | Select-Object
 * -Property Name" was refused. Script blocks (`{…}`) stay refused, so Where-Object and ForEach-Object cannot run code.
 */
export const RESEARCH_PIPE_FILTERS = ["Select-Object", "Sort-Object", "Measure-Object", "Format-Table", "Format-List", "Out-String", "Select-String", "head", "sort", "wc"];

/**
 * Whether a command may run without asking: every part of `a && b` starts with an allowed command and has no
 * other shell syntax.
 */
function commandAllowed(command: string, allowed: string[], filters: string[] = []): boolean {
  // `read | filter | filter`: each pipe stage after the first must be an output filter (research only).
  if (filters.length && /(^|[^|])\|(?!\|)/.test(command) && !command.includes("&&")) {
    const stages = command.split("|").map((p) => p.trim());
    if (stages.some((p) => !p)) return false;
    return commandAllowed(stages[0] ?? "", allowed) && stages.slice(1).every((p) => commandAllowed(p, filters));
  }
  const parts = command.split("&&").map((p) => p.trim()).filter(Boolean);
  // No other shell syntax: PowerShell runs `(…)` and `{…}` as code, and cmd expands `%VAR%` (scan 172).
  if (!parts.length || /[;|<>`$\r\n&(){}%]/.test(command.replace(/&&/g, " "))) return false;
  return parts.every((p) => {
    const argv = p.split(/\s+/);
    // An allowed command still may not look outside the worktree (`ls ~`, `rg x ../..`, `C:\…`).
    // Also a rooted or UNC path (`\\host\share`), a drive after a parameter (`-Path:C:\x`), and flags that run a program
    // (`rg --pre`) or write a file (`git log --output=`, `--ext-diff`, `--textconv`); unique abbreviations count too.
    if (argv.some((w) => /^(~|\/|\\|\.\.([\\/]|$))|[a-z]:[\\/]/i.test(w) || /[\\/]\.\.([\\/]|$)/.test(w) || /^--(pr|ou|ext|textc|exec)/i.test(w))) return false;
    return allowed.some((a) => {
      const want = a.trim().split(/\s+/);
      return want.length > 0 && want.every((w, i) => argv[i] === w);
    });
  });
}

/**
 * Decides one permission request of an agent working on an inbox task.
 *
 * @param p - The request, as acp.ts flattened it.
 * @param ctx - The task's worktree, paths and the allowed commands.
 * @returns The verdict and the rule.
 */
export function decideStep(p: AcpPermission, ctx: PolicyContext): PolicyVerdict {
  const f = fieldsOf(p.rawInput);
  const kind = (p.toolKind ?? "").toLowerCase();
  const diffPaths = (p.diffs ?? []).map((d) => d.path);
  const paths = [...new Set([...f.paths, ...diffPaths])];
  const label = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

  // First of all: nothing that buys, upgrades or pays (a quota or credit offer must end the task, not be accepted).
  // File edits are checked by their title only: a report may talk about pricing and billing; it is not a step that pays.
  const writes = kind === "edit" || kind === "delete" || kind === "move";
  if (PAYMENT.test(writes ? (p.title ?? "") : `${p.title ?? ""}\n${p.rawInput ?? ""}`)) return { verdict: "deny", rule: "no-payment", what: label(p.title || "a step about credits, a plan or payment") };

  if (f.command || kind === "execute") {
    const command = f.command ?? p.title;
    const what = label(command || "a command");
    const parts = command.split(/&&|\|\||;|\|/).map((x) => x.trim()).filter(Boolean);
    for (const part of parts) if (DENY_COMMANDS.some((r) => r.test(part))) return { verdict: "deny", rule: /^git\s+(push|commit|add)\b/.test(part) ? "only KesherAI commits and pushes" : /^git\s/.test(part) ? "git history and branches are KesherAI's" : /install|add|ci\b|npx|pnpx|bunx/.test(part) ? "no installs" : /curl|wget|ssh|iwr|irm|web|scp|ftp|nc\b/i.test(part) ? "no network" : "not allowed in a task", what };
    if (SECRET_FILE.test(command.split(/\s+/).find((w) => SECRET_FILE.test(w)) ?? "")) return { verdict: "deny", rule: "secret files", what };
    // Where it runs (cwd) and any path it names must be inside the worktree.
    if (f.paths.some((x) => !insideWorktree(ctx.worktree, x))) return { verdict: "deny", rule: "outside the worktree", what };
    // Agents often name the worktree by its full path ("C:\\…\\worktrees\\agy-x\\packages"): read it as "." so a read
    // inside the worktree is not refused as "outside" (two research runs ended after such reads were denied).
    const local = relativeToWorktree(command, ctx.worktree);
    // Read-only listing/reading commands are safe for every task (a 4.27 plugin conversion stopped after a refused
    // "Get-ChildItem -Recurse"); only research tasks may pipe into output filters.
    return (ctx.research ? commandAllowed(local, [...ctx.commands, ...RESEARCH_READ_COMMANDS], RESEARCH_PIPE_FILTERS) : commandAllowed(local, [...ctx.commands, ...RESEARCH_READ_COMMANDS])) ? { verdict: "allow", rule: "on the command list", what } : { verdict: "ask", rule: "not on the command list", what };
  }

  if (kind === "fetch") {
    if (!ctx.research) return { verdict: "deny", rule: "no network", what: label(p.title || "fetch") };
    // Public web pages only: never this computer or the home network (KesherAI's own API, ComfyUI, the router), nor
    // file:// or other schemes (scan 171: a page read during research could name such an address).
    return fetchTargetsPublic(p) ? { verdict: "allow", rule: "research: reading a public page", what: label(p.title || "fetch") } : { verdict: "deny", rule: "not a public web page", what: label(p.title || "fetch") };
  }

  const rel = paths.map((x) => insideWorktree(ctx.worktree, x));
  const shown = label(`${kind || "step"} ${rel.map((r, i) => r ?? paths[i]).join(", ") || p.title}`);
  if (rel.some((r) => r === undefined)) return { verdict: "deny", rule: "outside the worktree", what: shown };
  if (rel.some((r) => SECRET_FILE.test(r!))) return { verdict: "deny", rule: "secret files", what: shown };

  if (kind === "read" || kind === "search" || kind === "think") return { verdict: "allow", rule: "reading inside the project", what: shown };
  if (kind === "edit" || kind === "delete" || kind === "move") {
    if (!rel.length) return { verdict: "ask", rule: "the step does not say which file", what: shown };
    if (rel.some((r) => matchesAny(r!, ctx.forbiddenPaths))) return { verdict: "deny", rule: "a forbidden path", what: shown };
    if (rel.every((r) => matchesAny(r!, ctx.allowedPaths))) return { verdict: "allow", rule: "inside the allowed paths", what: shown };
    return { verdict: "ask", rule: "outside the allowed paths", what: shown };
  }
  return { verdict: "ask", rule: "an unknown kind of step", what: shown };
}

/** A finding of the secrets and privacy scan. */
export interface ScanFinding {
  file: string;
  kind: string;
}

/** Keys and tokens by their known shapes. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["API key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/],
];

/** Addresses that are fine in code (examples, no-reply). */
const OK_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com|noreply\.invalid|kesher\.invalid|localhost|test)$/i;
/** User names that are not a person (placeholders and system accounts). */
const OK_USER = /^(public|default|default user|all users|user|username|you|me|name|runner|runneradmin|root|claude|node|app|ubuntu|vscode|codespace|\$\{?\w+\}?|%\w+%|<[^>]+>|\.\.\.|x+)$/i;

/**
 * Scans the lines a change adds for keys, tokens, email addresses, the Windows user name and personal paths
 * (Roee's rule: nothing in git may show them). Run by KesherAI on the diff before every commit.
 *
 * @param diff - A unified diff (`git diff`).
 * @param me - This computer's user name and home folder, which must never appear.
 * @returns What was found, by file (never the found text itself, so the finding can be shown and logged).
 */
export function scanDiff(diff: string, me: { username?: string; home?: string } = {}): ScanFinding[] {
  const out: ScanFinding[] = [];
  let file = "";
  const home = me.home && me.home.length > 3 ? me.home.toLowerCase().replace(/\\/g, "/") : undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const add = line.slice(1);
    const hit = (kind: string) => {
      if (!out.some((f) => f.file === file && f.kind === kind)) out.push({ file, kind });
    };
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(add)) hit(kind);
    for (const m of add.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) if (!OK_EMAIL.test(m[0]) && !/^[\w.+-]+@\d/.test(m[0]) && /\.[a-z]{2,}$/i.test(m[0])) hit("email address");
    for (const m of add.matchAll(/[a-z]:[\\/]+users[\\/]+([^\\/"'`\s]+)/gi)) if (!OK_USER.test(m[1]!)) hit("personal path");
    for (const m of add.matchAll(/\/(?:home|Users)\/([^/"'`\s]+)/g)) if (!OK_USER.test(m[1]!)) hit("personal path");
    const low = add.toLowerCase();
    if (home && low.replace(/\\/g, "/").includes(home)) hit("personal path");
    // The user name itself only as part of a path (a bare word can be anyone's name, and his name may be in git).
    if (me.username && me.username.length >= 2 && new RegExp(`[\\\\/]${me.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\\\/]|$)`, "i").test(add)) hit("user name");
  }
  return out;
}

/** A research report an agent wrote: the only kind of file the privacy scan redacts instead of blocking. */
const REPORT_PATH = /^docs\/research\/[\w.-]+\.md$/;

/**
 * Whether a changed path is an agent's research report (`docs/research/*.md`).
 *
 * @param path - A changed path (relative, `/`).
 */
export function isResearchReport(path: string): boolean {
  return REPORT_PATH.test(path) && !path.includes("..");
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Takes this computer's personal paths out of a research report, so a report is not blocked from push for them: the
 * home folder becomes `~`, any other `C:\Users\<name>`, `/home/<name>` or `/Users/<name>` becomes `~` too, and the
 * user name inside a path becomes `<user>`. Backslash, forward-slash and doubled-backslash forms, any case. Emails,
 * keys and tokens are left alone (the scan still blocks them).
 *
 * @param text - The report.
 * @param me - This computer's user name and home folder.
 * @returns The redacted text and how many places changed.
 */
export function redactReport(text: string, me: { username?: string; home?: string } = {}): { text: string; count: number } {
  let count = 0;
  /** Replaces each match with what `to` gives (undefined keeps the match), counting the changes. */
  const sub = (re: RegExp, to: (match: string, group: string) => string | undefined) => {
    text = text.replace(re, (match: string, group: string) => {
      const out = to(match, group);
      if (out === undefined) return match;
      count++;
      return out;
    });
  };
  const sep = "[\\\\/]+";
  const home = me.home && me.home.length > 3 ? me.home.split(/[\\/]+/).filter(Boolean) : undefined;
  if (home?.length) sub(new RegExp(`(${/^[\\/]/.test(me.home!) ? sep : ""}${home.map(escapeRe).join(sep)})(?![\\w.-])`, "gi"), () => "~");
  // Anyone's home folder (placeholders such as C:\Users\<name> or /home/user stay).
  sub(/\b[a-z]:[\\/]+users[\\/]+([^\\/"'`\s<>]+)/gi, (_m, user) => (OK_USER.test(user) ? undefined : "~"));
  sub(/(?:\/mnt\/[a-z])?\/(?:home|Users)\/([^/"'`\s<>]+)/gi, (_m, user) => (OK_USER.test(user) ? undefined : "~"));
  if (me.username && me.username.length >= 2) sub(new RegExp(`([\\\\/])${escapeRe(me.username)}(?![\\w.-])`, "gi"), (_m, slash) => `${slash}<user>`);
  return { text, count };
}

/**
 * Checks the files a change touched against the task's limits.
 *
 * @param files - Changed paths (relative, `/`).
 * @param ctx - The allowed and forbidden paths, and the most files.
 * @returns The paths outside the limits, and whether there are too many files.
 */
export function checkPaths(files: string[], ctx: { allowedPaths: string[]; forbiddenPaths: string[]; maxFiles: number }): { outside: string[]; tooMany: boolean } {
  return { outside: files.filter((f) => !pathAllowed(f, ctx.allowedPaths, ctx.forbiddenPaths)), tooMany: files.length > ctx.maxFiles };
}

/**
 * Whether a diff changes a `"version"` field in a package.json (releases are the lead's).
 *
 * @param diff - The unified diff.
 */
export function changesVersion(diff: string): boolean {
  let pkg = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) pkg = /(^|\/)package\.json$/.test(line.slice(4).trim());
    else if (pkg && /^[+-]\s*"version"\s*:/.test(line)) return true;
  }
  return false;
}

/**
 * A command with the worktree's own absolute path (either slash, any letter case, quoted or not) written as ".".
 * @param command - The command as the agent sent it.
 * @param worktree - The task's worktree.
 */
export function relativeToWorktree(command: string, worktree: string): string {
  if (!worktree) return command;
  const root = worktree.replace(/[\\/]+$/, "");
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\|\//g, "[\\\\/]");
  return command.replace(new RegExp(`"${esc}([\\\\/][^"]*)?"|${esc}(?=[\\\\/\\s]|$)`, "gi"), (_m, rest: string | undefined) => (rest === undefined && _m.startsWith('"') ? "." : _m.startsWith('"') ? `.${rest}` : "."));
}
