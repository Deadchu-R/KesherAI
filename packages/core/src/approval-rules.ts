/**
 * Saved "always allow" rules for tool calls: whether one covers a call. Moved out of conversations.ts (t7);
 * conversations.ts re-exports it.
 */

/**
 * Whether a saved "always allow" rule covers this call: the tool, the scope
 * (this chat, this model, everywhere), not past its end time, and, for a rule
 * kept for one command, a command that starts with it as a whole word and
 * chains nothing else after it (no ;, &&, |, backticks or $( ) ).
 */
export function ruleAllows(r: { tool: string; scope: string; conversationId?: string; modelId?: string; until?: string; command?: string }, c: { tool: string; modelId: string; conversationId: string; command?: string }, now = Date.now()): boolean {
  if (r.tool !== c.tool && r.tool !== "*") return false;
  if (!(r.scope === "everywhere" || (r.scope === "model" && r.modelId === c.modelId) || (r.scope === "conversation" && r.conversationId === c.conversationId))) return false;
  if (r.until && Date.parse(r.until) <= now) return false;
  if (r.command) {
    const cmd = (c.command ?? "").trim().replace(/\s+/g, " ");
    const want = r.command.trim().replace(/\s+/g, " ");
    if (!(cmd === want || cmd.startsWith(`${want} `))) return false;
    if (/[;&|`\n]|\$\(|>\s*[^&\s]|<\(/.test(cmd.slice(want.length))) return false;
  }
  return true;
}
