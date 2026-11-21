/**
 * Saved "always allow" rules for tool calls: whether one covers a call. Moved out of conversations.ts (t7);
 * conversations.ts re-exports it. Rules are made by approval-grants.ts (the card's "This time / For this chat /
 * For 1 hour / Until I revoke").
 */

/** One saved rule, as far as matching needs it. */
export interface MatchableRule {
  /** The tool's name, `helper:<tool>` for a helper's rule, a `prefix*` family (`browser_*`) or `*`. */
  tool: string;
  scope: string;
  conversationId?: string;
  modelId?: string;
  until?: string;
  command?: string;
  /** Where it holds: `folder:<path>`, `site:<host>` or `app:<name>`; none = anywhere the tool acts. */
  target?: string;
}

/** One call, as far as matching needs it. */
export interface MatchableCall {
  tool: string;
  modelId: string;
  conversationId: string;
  command?: string;
  /** Where the call acts, in the same form as a rule's target (see approval-grants.ts `targetOf`). */
  target?: string;
}

/**
 * Whether a rule's tool covers a call's tool: the same name, `*` (any tool of the same agent kind), or a family
 * such as `browser_*`. A helper's rules (`helper:…`) never cover the chat's own tools, and the chat's never a helper's.
 *
 * @param ruleTool - The rule's tool.
 * @param callTool - The call's tool.
 */
export function toolMatches(ruleTool: string, callTool: string): boolean {
  if (ruleTool === callTool) return true;
  const helperRule = ruleTool.startsWith("helper:");
  if (helperRule !== callTool.startsWith("helper:")) return false;
  const want = helperRule ? ruleTool.slice(7) : ruleTool;
  const got = helperRule ? callTool.slice(7) : callTool;
  if (want === "*") return true;
  return want.endsWith("*") && want.length > 1 && got.startsWith(want.slice(0, -1));
}

/** A path with `/` only, no trailing `/`, case kept (POSIX is case-sensitive). */
function cleanPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
}

/**
 * Whether a rule's target covers where a call acts. A folder covers itself and every folder inside it (never a
 * path with `..`, and Windows drive letters compare without case); a site covers itself and its subdomains; an app
 * matches by name without case. A rule without a target covers any place; a rule with one never covers a call
 * whose place is unknown.
 *
 * @param pattern - The rule's target, or undefined.
 * @param value - The call's target, or undefined.
 */
export function targetMatches(pattern: string | undefined, value: string | undefined): boolean {
  if (!pattern) return true;
  if (!value) return false;
  const [pk, ...pr] = pattern.split(":");
  const [vk, ...vr] = value.split(":");
  if (pk !== vk) return false;
  const p = pr.join(":");
  const v = vr.join(":");
  if (!p || !v) return false;
  if (pk === "site") {
    const host = v.toLowerCase().replace(/\.$/, "");
    const want = p.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return host === want || host.endsWith(`.${want}`);
  }
  if (pk === "app") return p.toLowerCase() === v.toLowerCase();
  if (pk === "folder") {
    const fold = (s: string) => (/^[a-z]:/i.test(s) ? s.toLowerCase() : s);
    const want = fold(cleanPath(p));
    const got = fold(cleanPath(v));
    if (got.split("/").includes("..")) return false;
    return got === want || got.startsWith(want.endsWith("/") ? want : `${want}/`);
  }
  return false;
}

/**
 * Whether a saved "always allow" rule covers this call: the tool, the scope
 * (this chat, this model, everywhere), not past its end time, the place it acts
 * (a folder, a site, an app), and, for a rule kept for one command, a command
 * that starts with it as a whole word and chains nothing else after it (no ;,
 * &&, |, backticks or $( ) ).
 *
 * @param r - The rule.
 * @param c - The call.
 * @param now - The time now (ms).
 */
export function ruleAllows(r: MatchableRule, c: MatchableCall, now = Date.now()): boolean {
  if (!toolMatches(r.tool, c.tool)) return false;
  if (!(r.scope === "everywhere" || (r.scope === "model" && r.modelId === c.modelId) || (r.scope === "conversation" && r.conversationId === c.conversationId))) return false;
  if (r.until && Date.parse(r.until) <= now) return false;
  if (!targetMatches(r.target, c.target)) return false;
  if (r.command) {
    const cmd = (c.command ?? "").trim().replace(/\s+/g, " ");
    const want = r.command.trim().replace(/\s+/g, " ");
    if (!(cmd === want || cmd.startsWith(`${want} `))) return false;
    if (/[;&|`\n]|\$\(|>\s*[^&\s]|<\(/.test(cmd.slice(want.length))) return false;
  }
  return true;
}
