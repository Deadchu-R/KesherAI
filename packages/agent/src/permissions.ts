import type { PermissionMode, ToolRisk } from "@kesher/shared";

/** What to do with a tool call before running it. */
export type PermissionVerdict = { action: "allow" } | { action: "ask"; reason: string } | { action: "deny"; reason: string };

/**
 * Commands that always need the user's approval, whatever the mode: they
 * delete a lot, change the system, publish something, or run code from the
 * internet. The list is deliberately broad; a false alarm costs one click.
 */
const DANGEROUS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, "deletes files recursively or forcefully"],
  [/\b(rmdir|rd)\s+\/s\b/i, "deletes a folder tree"],
  [/\bdel\s+.*\/[sq]\b/i, "deletes files in bulk"],
  [/\bRemove-Item\b.*-Recurse/i, "deletes a folder tree"],
  // `format C:` and Format-Volume erase a disk; Format-List/Format-Table/Format-Wide only lay out text, and wmic's
  // `/format:list` only lays out its output (found in self-work: a disk-space check was held as "can erase a disk").
  [/\b((?<![/-])format(?!-(list|table|wide|custom|hex|number)|:)|mkfs|diskpart|fdisk)\b/i, "can erase a disk"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|rebase|filter-branch)\b/i, "rewrites or publishes git history"],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, "publishes a package"],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|zsh|iex|powershell|pwsh)\b/i, "runs code downloaded from the internet"],
  [/\b(sudo|runas|su)\b/i, "runs with administrator rights"],
  [/\b(shutdown|reboot|halt)\b/i, "shuts the computer down"],
  [/\b(reg\s+(add|delete)|Set-ItemProperty\s+.*HK(LM|CU))\b/i, "changes the Windows registry"],
  [/\bchmod\s+(-R\s+)?777\b/i, "opens file permissions to everyone"],
  [/>\s*\/dev\/sd[a-z]/i, "writes directly to a disk"],
  // Installing system software: seen in a test, a model ran "winget install" for Visual Studio by itself.
  [/\b(winget|choco|scoop)\s+(install|upgrade|uninstall|remove)\b/i, "installs or removes programs on the computer"],
  [/\b(msiexec|vs_installer|vs_community|vs_buildtools|setup)(\.exe)?\s+.*(\/i\b|\/x\b|install|modify|--add|\/quiet|\/passive)/i, "installs or changes programs on the computer"],
  [/\b(apt(-get)?|dnf|yum|pacman|brew)\s+(install|remove|upgrade)\b/i, "installs or removes programs on the computer"],
  [/\bAdd-AppxPackage|Install-Package|Install-Module\b/i, "installs programs or modules on the computer"],
  // Safety gates (r-17, RESEARCH_LOG "Safety gates" 2026-11-23): steps Claude Code, Codex and Google's critic stop.
  // Turning off protection: Defender, the firewall, script policy, boot settings, SELinux/ufw.
  [/\bSet-MpPreference\b.*-Disable|\bAdd-MpPreference\b.*-Exclusion|\bnetsh\s+(advfirewall|firewall)\s+set\b.*\b(off|disable)\b|\bSet-NetFirewallProfile\b.*-Enabled\s+(\$?false|0)\b|\bSet-ExecutionPolicy\s+(-ExecutionPolicy\s+)?(Unrestricted|Bypass)\b|\bbcdedit\b|\bufw\s+disable\b|\bsetenforce\s+0\b|\b(sc(\.exe)?\s+(stop|config)|Stop-Service|Set-Service)\b.*\b(WinDefend|mpssvc|wscsvc|SecurityHealthService)\b/i, "turns off a security protection"],
  // Sending or publishing in the user's name.
  [/\bSend-MailMessage\b|\b(sendmail|mailx?)\s+-|\bgh\s+(pr\s+(create|merge|close|comment|review)|issue\s+(create|close|comment)|release\s+(create|delete|upload)|repo\s+(create|delete|edit)|gist\s+create)\b/i, "sends or publishes something in your name"],
  // Throwing away work git cannot bring back.
  [/\bgit\s+(restore\s+(--\S+\s+)*\.(\s|$)|checkout\s+\.(\s|$)|stash\s+(drop|clear)\b|reflog\s+expire\b|gc\s+--prune)/i, "throws away work that git cannot bring back"],
  // Case matters here: `-d` deletes only a merged branch, `-D` any branch.
  [/\bgit\s+branch\s+(-D|--delete\s+--force|-f\s+-d)\b/, "throws away work that git cannot bring back"],
];

/** The commands that delete, for the "outside the project" check (POSIX, cmd and PowerShell names and aliases). */
const DELETE_VERBS = /^(rm|rmdir|unlink|shred|del|erase|rd|remove-item|ri)$/i;

/** Words that may stand before a delete and still run it (`sudo rm`, `cmd /c rd`, `pwsh -Command Remove-Item`). */
const RUNNERS = /^(sudo|cmd(\.exe)?|\/c|powershell(\.exe)?|pwsh(\.exe)?|-Command|-c)$/i;

/** Splits a command line into its simple commands (on `;`, `&&`, `||`, `|` and new lines), words unquoted. */
function simpleCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "")))
    .filter((words) => words.length > 0);
}

/** A path in one comparable form: forward slashes, `.`/`..` folded, no trailing slash, lower case on Windows. */
function normPath(p: string, windows: boolean): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const joined = (/^[\\/]/.test(p) ? "/" : "") + parts.join("/");
  return windows ? joined.toLowerCase() : joined;
}

/**
 * Whether a delete target lies outside the project folder. Home, environment variables and other drives count as
 * outside; a plain relative path without `..` stays inside.
 *
 * @param target - The path as the command names it.
 * @param workspace - The project folder; without one, any absolute or `..` path counts as outside.
 */
function outsideWorkspace(target: string, workspace: string | undefined): boolean {
  if (/^(~|\$HOME|\$env:|%[A-Za-z_]+%)/i.test(target)) return true;
  const absolute = /^([A-Za-z]:|[\\/])/.test(target);
  if (!absolute && !/(^|[\\/])\.\.([\\/]|$)/.test(target)) return false;
  if (!workspace) return true;
  const windows = /^[A-Za-z]:/.test(workspace) || workspace.includes("\\");
  const root = normPath(workspace, windows);
  const full = normPath(absolute ? target : `${workspace}/${target}`, windows);
  return full !== root && !full.startsWith(`${root}/`);
}

/**
 * The rule-based critic for deletes: does any delete in the command reach outside the project folder?
 * Flags (`-rf`, `/s`, `-Recurse`, `-Path`) are skipped; a one-letter `/x` is a cmd flag, not a path.
 *
 * @param command - The command line.
 * @param workspace - The project folder.
 * @returns The first target outside it, or undefined.
 */
export function deleteOutside(command: string, workspace: string | undefined): string | undefined {
  for (const words of simpleCommands(command)) {
    const verbAt = words.findIndex((w) => DELETE_VERBS.test(w));
    if (verbAt < 0 || !words.slice(0, verbAt).every((w) => RUNNERS.test(w))) continue;
    for (const arg of words.slice(verbAt + 1)) {
      if (/^-/.test(arg) || /^\/[A-Za-z]$/.test(arg)) continue;
      if (outsideWorkspace(arg, workspace)) return arg;
    }
  }
  return undefined;
}

/**
 * Checks a shell command against the always-ask list: the fixed patterns above and deletes that reach outside the
 * project folder. Pure and fast (no model call), so it runs before any reviewer and costs nothing on safe commands.
 *
 * @param command - The command line.
 * @param workspace - The session's project folder, for the "deletes outside the project" gate.
 * @returns Why it is dangerous, or `undefined` if it is not on the list.
 */
export function dangerReason(command: string, workspace?: string): string | undefined {
  const fixed = DANGEROUS.find(([re]) => re.test(command))?.[1];
  if (fixed) return fixed;
  return deleteOutside(command, workspace) ? "deletes files outside the project folder" : undefined;
}

/**
 * Decides whether a tool call may run now or needs the user's approval.
 *
 * | risk | ask | auto-edit | auto |
 * | --- | --- | --- | --- |
 * | safe, read | run | run | run |
 * | write | ask | run | run |
 * | exec | ask | ask | run (dangerous: ask) |
 *
 * A tool the user chose "always allow" for in this session runs without
 * asking, except dangerous commands, which always ask.
 *
 * @param mode - The session's permission mode.
 * @param risk - The tool's risk.
 * @param alwaysAllowed - Whether the user said "always allow" for this tool.
 * @param command - For `exec` tools, the command line, checked for danger.
 * @param workspace - The project folder, so a delete outside it is caught.
 * @returns The verdict.
 */
export function decide(mode: PermissionMode, risk: ToolRisk, alwaysAllowed: boolean, command?: string, workspace?: string): PermissionVerdict {
  if (risk === "safe" || risk === "read") return { action: "allow" };
  // Plan mode: look, don't touch.
  if (mode === "plan") return { action: "deny", reason: "Plan mode: you may only read and look around. Put this step in your plan and finish with present_plan." };
  const danger = command ? dangerReason(command, workspace) : undefined;
  if (danger) return { action: "ask", reason: `This command ${danger}, so it always needs your approval.` };
  if (alwaysAllowed) return { action: "allow" };
  if (risk === "write") {
    return mode === "ask" ? { action: "ask", reason: "The agent wants to change a file." } : { action: "allow" };
  }
  return mode === "auto" ? { action: "allow" } : { action: "ask", reason: "The agent wants to run a command on your computer." };
}
