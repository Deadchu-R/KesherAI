/**
 * Long-term approvals in every flow (WORK_LIST "Long-term approvals in chats"): from any approval card the user
 * picks "This time", "For this chat", "For 1 hour" or "Until I revoke", and the grant is kept as a permission rule
 * (config `permissions`) scoped to the tool, to where it acts (a folder, a site, an app) and to the agent kind.
 *
 * Rules this module keeps:
 * - A helper's grant is stricter: it is named `helper:<tool>` (never covers the chat's own tools), it holds only in
 *   its chat, and "Until I revoke" becomes "For this chat".
 * - The always-ask lists are never granted: dangerous commands, sensitive sites (passwords, payments, banks), app
 *   steps that type secrets or change system settings, deletes, and anything a guest asked for. Those cards come
 *   with `noAlways`, and the server checks again here, so a changed client cannot widen them.
 */
import type { MatchableRule } from "./approval-rules.js";

/** What the user chose on a card. */
export type GrantChoice = "once" | "chat" | "hour" | "revoke";
export const GRANT_CHOICES: readonly GrantChoice[] = ["once", "chat", "hour", "revoke"];

/** A saved rule, as the config keeps it. */
export interface GrantRule extends MatchableRule {
  scope: "conversation" | "model" | "everywhere";
  createdAt?: string;
}

/** The waiting request, as far as granting needs it (from its `approval_request` event). */
export interface GrantRequest {
  /** The tool. */
  name: string;
  input: Record<string, unknown>;
  reason: string;
  /** The browser's `site:<host>` scope. */
  scope?: string;
  /** Set for a helper's step. */
  helper?: unknown;
  /** The card offers no "always" (sensitive site, always-ask step, guest). */
  noAlways?: boolean;
}

/** Tools whose calls are never granted for longer than once: they delete, or change the system. */
const NEVER_GRANTED = /^(helper:)?(delete_|remove_|trash_|uninstall_|system_settings|set_system|computer_type_secret|browser_fill_password|pay_)/;

/** The guard's words for a command that always asks (agent/permissions.ts `decide`). */
const DANGER = /^This command .+, so it always needs your approval\.$/;
/** A guest's action (shared-chat.ts): always the owner's yes, every time. */
const GUEST = /\(a guest\) asked for this/;

/**
 * Whether a request is on an always-ask list, so no choice on its card may last past this one time.
 *
 * @param r - The request.
 * @returns The reason it always asks, or undefined when it may be granted.
 */
export function alwaysAsks(r: GrantRequest): string | undefined {
  if (r.noAlways) return "This step is always asked.";
  if (DANGER.test(r.reason)) return "Dangerous commands are always asked.";
  if (GUEST.test(r.reason)) return "A guest's actions are always asked.";
  if (NEVER_GRANTED.test(r.name)) return "Deleting and system changes are always asked.";
  return undefined;
}

/** The folder a path is in (no `..`), or undefined. Works for `/` and `\` paths. */
function folderOf(path: string): string | undefined {
  const p = path.trim().replace(/\\/g, "/");
  if (!p || p.split("/").includes("..")) return undefined;
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : p.slice(0, i);
}

/**
 * Where a call acts, as a rule target: the browser's site, the app for `computer_use_app`, the folder of a file a
 * tool writes. Undefined when the tool has no place narrower than itself (a command is narrowed by its start).
 *
 * @param tool - The tool (without `helper:`).
 * @param input - The call's arguments.
 * @param scope - The session's scope for the call (`site:<host>` for the browser).
 */
export function targetOf(tool: string, input: Record<string, unknown> | undefined, scope?: string): string | undefined {
  if (scope?.startsWith("site:") && scope.length > 5) return scope;
  const str = (k: string) => (typeof input?.[k] === "string" ? (input[k] as string).trim() : "");
  if (tool === "computer_use_app" && str("app")) return `app:${str("app").toLowerCase().slice(0, 80)}`;
  const path = str("path") || str("file") || str("dest");
  if (path && /^(write_file|edit_file|multi_edit|apply_patch|create_file|move_file|copy_file|download_file)$/.test(tool)) {
    const f = folderOf(path);
    return f ? `folder:${f}` : undefined;
  }
  return undefined;
}

/**
 * The tool name a grant is kept for: the browser's site grant covers all its tools on that site (`browser_*`), as
 * "Always on this site" did; everything else is the tool itself. A helper's grant gets `helper:`.
 *
 * @param r - The request.
 */
export function grantTool(r: Pick<GrantRequest, "name" | "scope" | "helper">): string {
  const base = r.scope?.startsWith("site:") && r.name.startsWith("browser_") ? "browser_*" : r.name;
  return `${r.helper ? "helper:" : ""}${base}`;
}

/**
 * The rule for a choice on a card, or undefined when nothing is kept ("This time", or a request on an always-ask
 * list). "For this chat" and "For 1 hour" hold in the chat; "Until I revoke" holds everywhere until removed in
 * Settings › Approvals, except for a helper, whose grant never leaves its chat.
 *
 * @param r - The request.
 * @param o - The choice, the chat, the time now (ms), and for a command the start it is limited to.
 */
export function grantFor(r: GrantRequest, o: { choice: GrantChoice; conversationId: string; now: number; command?: string }): GrantRule | undefined {
  if (o.choice === "once" || alwaysAsks(r)) return undefined;
  const choice: GrantChoice = r.helper && o.choice === "revoke" ? "chat" : o.choice;
  const target = targetOf(r.name, r.input, r.scope);
  // A command grant is a start of the command asked about (as whole words), never another command (scan 171: the
  // card sends it, so a changed client could otherwise keep a rule for a command nobody saw).
  const asked = typeof r.input?.command === "string" ? r.input.command.trim().replace(/\s+/g, " ") : undefined;
  let command = o.command?.trim().replace(/\s+/g, " ").slice(0, 200);
  if (command && asked !== undefined && !(asked === command || asked.startsWith(`${command} `))) command = asked.slice(0, 200);
  return {
    tool: grantTool(r),
    scope: choice === "revoke" ? "everywhere" : "conversation",
    ...(choice === "revoke" ? {} : { conversationId: o.conversationId }),
    createdAt: new Date(o.now).toISOString(),
    ...(choice === "hour" ? { until: new Date(o.now + 60 * 60_000).toISOString() } : {}),
    ...(target ? { target } : {}),
    ...(command ? { command } : {}),
  };
}

/**
 * The rules after adding one: the same grant (tool, scope, chat, model, command, target) is replaced (e.g. "For 1
 * hour" after "Until I revoke"), and rules that already ended are dropped.
 *
 * @param rules - The current rules.
 * @param rule - The new one.
 * @param now - The time now (ms).
 */
export function withGrant<T extends GrantRule>(rules: readonly T[], rule: T, now: number): T[] {
  const same = (x: T) => x.tool === rule.tool && x.scope === rule.scope && x.conversationId === rule.conversationId && x.modelId === rule.modelId && x.command === rule.command && x.target === rule.target;
  return [...rules.filter((x) => !same(x) && !(x.until && Date.parse(x.until) <= now)), rule];
}

/**
 * The grants still in force, for Settings › Approvals: each with its place in the whole list (for Revoke), the
 * agent kind, and the milliseconds left (undefined = until revoked).
 *
 * @param rules - The config's rules.
 * @param now - The time now (ms).
 */
export function activeGrants<T extends GrantRule>(rules: readonly T[], now: number): Array<{ index: number; rule: T; kind: "chat" | "helper"; leftMs?: number }> {
  return rules.flatMap((rule, index) => {
    const end = rule.until ? Date.parse(rule.until) : undefined;
    if (end !== undefined && end <= now) return [];
    return [{ index, rule, kind: rule.tool.startsWith("helper:") ? ("helper" as const) : ("chat" as const), ...(end !== undefined ? { leftMs: end - now } : {}) }];
  });
}
