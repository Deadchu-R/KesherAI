/**
 * Approvals answered from the Kesher Cloud hub page (or the phone's Cloud tab): the same effect as the chat's own
 * approval card on this PC. "Approve once" and "Deny" answer the request; "Allow for a while" first keeps a rule for
 * that chat's tool that ends by itself (as the card's "Allow for 1 hour" does), then answers "always". A sub-agent's
 * step gets a `helper:<tool>` rule (delegate.ts), kept apart from the chat's own rules, as on the card.
 */
import type { KesherConfig } from "./config.js";
import { HELPER_RULE } from "./delegate.js";

/** One permission rule, as the config keeps it. */
type PermissionRule = KesherConfig["permissions"][number];

/** The guard's words for a command that always asks (no "for a while" for these, as on the PC's card). */
const DANGER = /^This command .+, so it always needs your approval\.$/;

/**
 * Whether an approval's reason marks a command that always needs the user's approval.
 *
 * @param reason - The request's reason.
 * @returns True for a dangerous command.
 */
export function isDangerousReason(reason: string): boolean {
  return DANGER.test(reason);
}

/**
 * The rules after "Allow for a while": a rule for this tool in this chat until `now + minutes`, replacing the same
 * rule (e.g. "for an hour" after "for good"), with rules that already ended dropped. Same as the chat card's route.
 *
 * @param rules - The current rules.
 * @param o - The tool, the chat, how long (minutes, at most a year) and the time now (ms).
 * @returns The new rules.
 */
export function withTimedRule(rules: readonly PermissionRule[], o: { tool: string; conversationId: string; minutes: number; now: number }): PermissionRule[] {
  const minutes = Math.max(1, Math.min(Math.floor(o.minutes), 366 * 24 * 60));
  const rule: PermissionRule = { tool: o.tool, scope: "conversation", conversationId: o.conversationId, createdAt: new Date(o.now).toISOString(), until: new Date(o.now + minutes * 60_000).toISOString() };
  const same = (r: PermissionRule) => r.tool === rule.tool && r.scope === rule.scope && r.conversationId === rule.conversationId && r.modelId === undefined && r.command === undefined;
  return [...rules.filter((r) => !same(r) && !(r.until && Date.parse(r.until) <= o.now)), rule];
}

/** A waiting request as the chat's session keeps it (only what deciding needs). */
export interface WaitingRequest {
  name: string;
  reason: string;
  /** Set for a site-scoped tool (the browser): "Always" there means one site, never "for a while". */
  scope?: string;
  /** Set when a sub-agent asks: its rule is `helper:<tool>`, kept apart from the chat's own rules. */
  helper?: unknown;
}

/** What answering needs from the app. */
export interface HubApprovalDeps {
  /** The request in its chat, or undefined when the chat or the request is gone. */
  find(conversationId: string, requestId: string): Promise<{ request: WaitingRequest; approve: (decision: "allow" | "always" | "deny") => boolean } | undefined>;
  config: () => Pick<KesherConfig, "permissions">;
  saveConfig: () => Promise<void>;
  now?: () => number;
}

/**
 * Whether "Allow for a while" may apply to a request: not a dangerous command, not limited to one site.
 *
 * @param r - The request.
 * @returns True when a timed rule may be kept for it.
 */
export function allowsForWhile(r: WaitingRequest): boolean {
  return !r.scope && !isDangerousReason(r.reason);
}

/**
 * Answers a chat's approval from the hub. A "for a while" that does not apply (see {@link allowsForWhile}) is
 * answered as "Approve once", never widened.
 *
 * @param d - The app's parts.
 * @param conversationId - The chat.
 * @param requestId - The request.
 * @param decision - Allow or deny.
 * @param forMinutes - "Allow for a while", in minutes (allow only).
 * @returns Whether a waiting request was answered.
 */
export async function answerFromHub(d: HubApprovalDeps, conversationId: string, requestId: string, decision: "allow" | "deny", forMinutes?: number): Promise<boolean> {
  const found = await d.find(conversationId, requestId);
  if (!found) return false;
  if (decision === "allow" && forMinutes && forMinutes > 0 && allowsForWhile(found.request)) {
    const cfg = d.config();
    cfg.permissions = withTimedRule(cfg.permissions, { tool: `${found.request.helper ? HELPER_RULE : ""}${found.request.name}`, conversationId, minutes: forMinutes, now: (d.now ?? Date.now)() });
    await d.saveConfig();
    return found.approve("always");
  }
  return found.approve(decision);
}
