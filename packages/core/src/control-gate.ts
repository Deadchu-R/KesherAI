/**
 * Puts the safety v2 policy (control-policy.ts) in front of every browser_* and computer_* tool of a chat: each call
 * is decided by the rules, the local reviewer (Auto mode) or the user on approval card v2, and every decision goes to
 * the action log. The tools tell the gate where they act through `withControlInfo` (site, app, target, a picture).
 */
import type { AgentTool, GateResult, ToolContext } from "@kesher/agent";
import type { ControlCard } from "@kesher/shared";
import { CONTROL_APPROVAL_MS, ControlLog, actionClassOf, controlKindOf, decideControl, hostMatches, sitesInText, type PolicySettings } from "./control-policy.js";
import type { ControlReviewer } from "./control-reviewer.js";

/** Where a call acts, as its tool knows it. */
export interface ControlTarget {
  /** The site's host, for browser calls. */
  site?: string;
  /** The page's address, or the address to open. */
  url?: string;
  /** The app's process name and its window, for computer calls. */
  app?: string;
  window?: string;
  /** What it acts on, e.g. `button "Send"`. */
  target?: string;
  /** The user already let this chat use the app (computer_use_app): counts as "Always in this app". */
  granted?: boolean;
  /** For typing: how many characters (the reviewer never sees the text). */
  typedChars?: number;
  /** Typing into a password or code field: the tool refuses it and shows the sign-in card, so no approval card first. */
  secretField?: boolean;
  /** A PNG of the target cut from a screenshot, for the card (only made when the card is shown). */
  crop?: () => Promise<Buffer | undefined>;
}

const INFO = Symbol("controlInfo");
type WithInfo = AgentTool & { [INFO]?: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ControlTarget> };

/**
 * Lets a tool tell the gate where a call acts (kept through `{ ...tool }` copies).
 *
 * @param tool - The tool.
 * @param info - Finds the site or app, the target and its picture for one call.
 * @returns The same tool.
 */
export function withControlInfo<T extends AgentTool>(tool: T, info: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ControlTarget>): T {
  (tool as WithInfo)[INFO] = info;
  return tool;
}

/** What the gate needs from the chat. */
export interface ControlGateDeps {
  /** The chat's id (the action log). */
  chatId: string;
  /** The owner's settings, read on every call. */
  settings(): PolicySettings;
  /** The local reviewer for Auto mode, or undefined when there is no local model. */
  reviewer(): ControlReviewer | undefined;
  /** The action log. */
  log: ControlLog;
  /** Sites the user approved in this chat (the origin gate's task sites, with the ones they wrote). */
  sites: Set<string>;
  /** Keeps the card's picture as an asset; its id. */
  saveCrop?(png: Buffer): Promise<string>;
}

/** Short words for what a tool does, for the card ("click", "type"…); the card says them in the user's language. */
export function verbOf(tool: string): string {
  return tool.replace(/^(browser|computer)_/, "").replace(/_/g, " ");
}

/**
 * Gives every browser and computer tool in a list the safety v2 gate; other tools are returned as they are.
 *
 * @param tools - The chat's tools.
 * @param d - The chat's settings, reviewer, log and sites.
 */
export function gateControlTools(tools: AgentTool[], d: ControlGateDeps): AgentTool[] {
  return tools.map((t) => {
    const kind = controlKindOf(t.spec.name);
    if (!kind) return t;
    const info = (t as WithInfo)[INFO];
    const gate = async (input: Record<string, unknown>, ctx: ToolContext, gi: Parameters<NonNullable<AgentTool["gate"]>>[2]): Promise<GateResult> => {
      const where: ControlTarget = (await info?.(input, ctx).catch(() => undefined)) ?? {};
      if (where.secretField) return { action: "allow", reason: "Nothing is typed: the tool refuses password and code fields and asks the user to sign in." };
      const site = where.site ?? (gi.scope?.startsWith("site:") ? gi.scope.slice(5) : undefined);
      const app = where.app;
      const s = d.settings();
      const action = actionClassOf(t.spec.name, input);
      const namedSites = sitesInText(gi.asked);
      const taskSites = [...new Set([...namedSites, ...d.sites])];
      const mustAsk = t.askFirst?.(input);
      const always = gi.always || where.granted === true;
      const dec = decideControl({ kind, tool: t.spec.name, action, ...(site ? { site } : {}), ...(where.url ? { url: where.url } : {}), ...(app ? { app } : {}), ...(gi.helper ? { helper: gi.helper } : {}), always, taskSites, namedSites, ...(mustAsk ? { mustAsk } : {}), plan: gi.plan }, s);
      const entry = { chatId: d.chatId, ...(gi.helper ? { helper: gi.helper } : {}), kind, tool: t.spec.name, ...(site ? { site } : {}), ...(app ? { app } : {}), ...(where.target ? { target: where.target } : {}) };
      // Reading is not logged as a decision (the activity strip has it); everything else is.
      if (dec.action === "allow") {
        if (action !== "read") d.log.add({ ...entry, decision: "allow", by: dec.why[0] === "always" ? "always" : dec.why[0] === "skip" ? "skip" : "policy", reason: dec.reason });
        return { action: "allow", reason: dec.reason };
      }
      if (dec.action === "deny") {
        d.log.add({ ...entry, decision: "deny", by: "policy", reason: dec.reason });
        return { action: "deny", reason: dec.reason };
      }
      let reason = dec.reason;
      const why = [...dec.why];
      if (dec.action === "review") {
        const reviewer = d.reviewer();
        const r = reviewer
          ? await reviewer({ asked: gi.asked, ...(gi.helper ? { helper: gi.helper } : {}), kind, tool: t.spec.name, ...(where.target ? { target: where.target } : {}), ...(site ? { site } : {}), ...(app ? { app } : {}), ...(where.typedChars !== undefined ? { typedChars: where.typedChars } : {}) }, ctx.signal).catch(() => undefined)
          : undefined;
        if (r?.allow) {
          d.log.add({ ...entry, decision: "allow", by: "reviewer", reason: r.reason });
          return { action: "allow", reason: r.reason, note: `✓ Approved by the local reviewer: ${verbOf(t.spec.name)}${where.target ? ` ${where.target}` : ""}${site ? ` on ${site}` : app ? ` in ${app}` : ""}${r.reason ? ` (${r.reason})` : ""}` };
        }
        reason = r ? `The local reviewer left it to you: ${r.reason || "unsure"}.` : "No local model to review it, so you decide.";
      }
      let crop: string | undefined;
      if (where.crop && d.saveCrop) {
        const png = await where.crop().catch(() => undefined);
        if (png?.length) crop = await d.saveCrop(png).catch(() => undefined);
      }
      const control: ControlCard = {
        kind,
        verb: verbOf(t.spec.name),
        ...(site ? { site } : {}),
        ...(app ? { app } : {}),
        ...(where.window ? { window: where.window.slice(0, 120) } : {}),
        ...(where.target ? { target: where.target.slice(0, 160) } : {}),
        ...(crop ? { crop } : {}),
        why,
        ...(dec.sensitive ? { sensitive: dec.sensitive } : {}),
        expiresAt: new Date(Date.now() + CONTROL_APPROVAL_MS).toISOString(),
      };
      return {
        action: "ask",
        reason,
        // "Always in this app" is computer_use_app's grant (asked once per app), never a whole computer tool.
        noAlways: dec.noAlways || (kind === "computer" && t.spec.name !== "computer_use_app"),
        control,
        timeoutMs: CONTROL_APPROVAL_MS,
        decided: (decision, by) => {
          d.log.add({ ...entry, decision, by, reason });
          // A site the user let it act on or open joins the task's sites, so the origin gate stops asking for it.
          if ((decision === "allow" || decision === "always") && site && kind === "browser" && !dec.sensitive && ![...d.sites].some((x) => hostMatches(site, x))) d.sites.add(site);
        },
      };
    };
    return { ...t, gate };
  });
}
