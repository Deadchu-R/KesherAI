import type { PermissionMode, ToolRisk } from "@kesher/shared";

/** What to do with a tool call before running it. */
export type PermissionVerdict = { action: "allow" } | { action: "ask"; reason: string };

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
  [/\b(format|mkfs|diskpart|fdisk)\b/i, "can erase a disk"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|rebase|filter-branch)\b/i, "rewrites or publishes git history"],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, "publishes a package"],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|zsh|iex|powershell|pwsh)\b/i, "runs code downloaded from the internet"],
  [/\b(sudo|runas|su)\b/i, "runs with administrator rights"],
  [/\b(shutdown|reboot|halt)\b/i, "shuts the computer down"],
  [/\b(reg\s+(add|delete)|Set-ItemProperty\s+.*HK(LM|CU))\b/i, "changes the Windows registry"],
  [/\bchmod\s+(-R\s+)?777\b/i, "opens file permissions to everyone"],
  [/>\s*\/dev\/sd[a-z]/i, "writes directly to a disk"],
];

/**
 * Checks a shell command against the always-ask list.
 *
 * @param command - The command line.
 * @returns Why it is dangerous, or `undefined` if it is not on the list.
 */
export function dangerReason(command: string): string | undefined {
  return DANGEROUS.find(([re]) => re.test(command))?.[1];
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
 * @returns The verdict.
 */
export function decide(mode: PermissionMode, risk: ToolRisk, alwaysAllowed: boolean, command?: string): PermissionVerdict {
  if (risk === "safe" || risk === "read") return { action: "allow" };
  const danger = command ? dangerReason(command) : undefined;
  if (danger) return { action: "ask", reason: `This command ${danger}, so it always needs your approval.` };
  if (alwaysAllowed) return { action: "allow" };
  if (risk === "write") {
    return mode === "ask" ? { action: "ask", reason: "The agent wants to change a file." } : { action: "allow" };
  }
  return mode === "auto" ? { action: "allow" } : { action: "ask", reason: "The agent wants to run a command on your computer." };
}
