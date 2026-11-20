/**
 * Safety v2 for browser and computer control (docs/research/browser-computer-control.md, Phase 4): one pure policy
 * engine that decides every browser_* and computer_* call, whatever the model says. Decided by code, never by the
 * model's promise.
 *
 * - Modes: Manual (ask each action unless "Always" covers it; the default, and always the default for helpers),
 *   Auto (a LOCAL reviewer model sees only the action's metadata and may let it run; otherwise the user is asked),
 *   Skip (runs without asking; only in the chat itself, only after the owner turned it on in Settings with a
 *   warning, never for helpers and never for computer control).
 * - In every mode: a blocked site is refused; a sensitive site (banking, payments, email, account settings,
 *   government, plus the user's own list) asks before every action, reading included, with no "Always"; the tool's
 *   own always-ask list (uploads, clipboard, deleting…) asks; JS follows its policy (ask / local / off).
 * - Origin gate: a task's sites are the ones the user named or approved in this chat; acting or navigating outside
 *   them asks first ("this leaves the task's sites").
 */

/** How browser and computer actions are approved. */
export type ControlMode = "manual" | "auto" | "skip";
/** Which family a tool belongs to. */
export type ControlKind = "browser" | "computer";
/** What a call does, for the rules. */
export type ActionClass = "read" | "act" | "navigate" | "eval";
/** JS on pages: ask every time, run on local dev servers like any action (ask elsewhere), or never. */
export type JsPolicy = "ask" | "local" | "off";
/** Why a site is on the sensitive list. */
export type SensitiveKind = "bank" | "payment" | "email" | "account" | "government" | "user";

/** The owner's settings (Settings → Browser and computer). */
export interface PolicySettings {
  /** The chat's mode. */
  mode: ControlMode;
  /** The helpers' mode (never skip). */
  helperMode: "manual" | "auto";
  /** The owner's explicit "yes" for Skip (with a warning); without it Skip works as Manual. */
  skipAllowed: boolean;
  /** JS policy for browser_eval. */
  js: JsPolicy;
  /** The user's own sensitive sites ("mybank.example"): ask every time, like the built-in list. */
  sensitive: readonly string[];
  /** Sites the tools never act on or read. */
  blocked: readonly string[];
  /** Whether helpers may use "Always on this site / app" (Settings → Browser; off by default). */
  helperAlways: boolean;
}

/** One call, as the engine sees it. */
export interface PolicyCall {
  kind: ControlKind;
  /** The tool's name, e.g. browser_click. */
  tool: string;
  action: ActionClass;
  /** The site's host ("mail.example.com"), for browser calls. */
  site?: string;
  /** The page's address or the address to open (for path rules such as /checkout). */
  url?: string;
  /** The app's process name, for computer calls. */
  app?: string;
  /** The helper's name when a helper asks; undefined for the chat itself. */
  helper?: string;
  /** Whether a saved "Always" (site or app) covers this call. */
  always: boolean;
  /** The task's sites (origin gate); empty means no gate yet. */
  taskSites: readonly string[];
  /** The tool's own always-ask reason (uploads, clipboard, deleting…). */
  mustAsk?: string;
  /** The chat is in plan mode: only reading. */
  plan?: boolean;
}

/** The engine's answer. */
export interface PolicyDecision {
  /** allow: run; review: ask the local reviewer (it may allow, otherwise ask); ask: the user; deny: never. */
  action: "allow" | "review" | "ask" | "deny";
  /** One English sentence (the model reads it on deny; the card shows it on ask). */
  reason: string;
  /** Short tags for the card and the log, e.g. ["sensitive"], ["origin"], ["manual"]. */
  why: string[];
  /** The card must not offer "Always" (and an "always" answer counts as once). */
  noAlways: boolean;
  /** The sensitive list's reason, when the site is on it. */
  sensitive?: SensitiveKind;
}

/** Built-in sensitive sites by kind: a host matches itself and its subdomains. */
const SENSITIVE_HOSTS: Record<Exclude<SensitiveKind, "user">, readonly string[]> = {
  bank: [
    "leumi.co.il", "bankhapoalim.co.il", "discountbank.co.il", "mizrahi-tefahot.co.il", "fibi.co.il", "bank-yahav.co.il",
    "mercantile.co.il", "pepper.co.il", "onezero.co.il", "max.co.il", "cal-online.co.il", "isracard.co.il",
    "chase.com", "wellsfargo.com", "bankofamerica.com", "citi.com", "hsbc.com", "barclays.co.uk", "santander.com",
    "revolut.com", "wise.com", "n26.com", "monzo.com", "capitalone.com", "usbank.com",
  ],
  payment: [
    "paypal.com", "stripe.com", "pay.google.com", "payments.google.com", "venmo.com", "cash.app", "payboxapp.com",
    "bitpay.co.il", "coinbase.com", "binance.com", "kraken.com", "checkout.shopify.com", "klarna.com", "afterpay.com",
  ],
  email: [
    "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com",
    "mail.proton.me", "proton.me", "mail.aol.com", "icloud.com", "gmx.com", "gmx.net", "zoho.com", "fastmail.com",
    "walla.co.il",
  ],
  account: [
    "accounts.google.com", "myaccount.google.com", "account.microsoft.com", "login.microsoftonline.com",
    "login.live.com", "appleid.apple.com", "account.apple.com", "id.apple.com", "accountscenter.facebook.com",
  ],
  government: ["gov.il", "gov.uk", "gov", "mil", "europa.eu", "irs.gov", "btl.gov.il"],
};

/** Host patterns that are sensitive whoever runs them (a bank's own domain, a webmail host, a government domain). */
const SENSITIVE_PATTERNS: Array<[SensitiveKind, RegExp]> = [
  ["government", /(^|\.)gov(\.[a-z]{2})?$|(^|\.)gob\.[a-z]{2}$|(^|\.)gouv\.[a-z]{2}$|(^|\.)mil$/i],
  ["bank", /(^|[.-])(online)?bank(ing)?([.-]|$)|banking/i],
  ["email", /^(webmail|mail|email|outlook)\./i],
  ["account", /^(accounts?|login|signin|sso|auth|id)\./i],
  ["payment", /^(pay|payments?|checkout|billing|wallet)\./i],
];

/** Address paths that are sensitive on any site: checkout and payment, account and security settings. */
const SENSITIVE_PATHS: Array<[SensitiveKind, RegExp]> = [
  ["payment", /\/(checkout|payment|payments|billing|pay|purchase|buy)(\/|$|\?)/i],
  ["account", /\/(settings\/(security|account|password|privacy|emails?|billing)|account\/(security|settings|password)|security\/?(settings)?|password|2fa|two-factor)(\/|$|\?)/i],
];

/** Lowercase host without "www." and without the port. */
function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
}

/**
 * Whether a host is a list entry or one of its subdomains.
 *
 * @param host - E.g. "mail.example.com".
 * @param entry - E.g. "example.com", or "*.example.com".
 */
export function hostMatches(host: string, entry: string): boolean {
  const h = bareHost(host);
  const e = bareHost(entry.replace(/^\*\./, "").replace(/^https?:\/\//, "").split("/")[0] ?? "");
  return !!e && (h === e || h.endsWith(`.${e}`));
}

/**
 * Whether a host is this computer or the local network's own name (dev servers).
 *
 * @param host - E.g. "localhost:5173".
 */
export function isLocalSite(host: string | undefined): boolean {
  if (!host) return false;
  const h = bareHost(host);
  return h === "localhost" || h === "0.0.0.0" || h === "[::1]" || /^127\./.test(h) || h.endsWith(".localhost") || h.endsWith(".local");
}

/**
 * Why a site is sensitive (ask before every action, no "Always"), or undefined.
 *
 * @param host - The site's host.
 * @param url - Its address, for path rules (checkout, account settings).
 * @param extra - The user's own sensitive sites.
 */
export function sensitiveKind(host: string | undefined, url?: string, extra: readonly string[] = []): SensitiveKind | undefined {
  if (!host || isLocalSite(host)) return undefined;
  if (extra.some((e) => hostMatches(host, e))) return "user";
  for (const [kind, list] of Object.entries(SENSITIVE_HOSTS) as Array<[SensitiveKind, readonly string[]]>)
    if (list.some((e) => hostMatches(host, e))) return kind;
  const h = bareHost(host);
  for (const [kind, re] of SENSITIVE_PATTERNS) if (re.test(h)) return kind;
  if (url) {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      path = "";
    }
    for (const [kind, re] of SENSITIVE_PATHS) if (re.test(path)) return kind;
  }
  return undefined;
}

/** English words for each sensitive kind (the reason sentence); the card shows its own Hebrew/English words. */
const KIND_WORDS: Record<SensitiveKind, string> = {
  bank: "a bank",
  payment: "payments",
  email: "email",
  account: "account settings",
  government: "a government service",
  user: "your sensitive list",
};

/** Tools that only look (no change, no navigation), by name, for both families. */
const READ_TOOLS = new Set([
  "browser_tabs", "browser_read", "browser_snapshot", "browser_screenshot", "browser_console", "browser_network",
  "browser_network_request", "browser_inspect", "browser_wait", "browser_find_visual",
  "computer_screenshot", "computer_tree", "computer_windows", "computer_cursor_position", "computer_zoom", "computer_wait",
  "computer_find",
]);
const NAV_TOOLS = new Set(["browser_open", "browser_navigate", "browser_back", "browser_forward", "browser_reload"]);

/**
 * What a tool's call does, by its name.
 *
 * @param tool - The tool's name.
 * @param input - Its input (browser_navigate's `action` back/forward/reload stays navigation).
 */
export function actionClassOf(tool: string, input: Record<string, unknown> = {}): ActionClass {
  if (tool === "browser_eval") return "eval";
  if (NAV_TOOLS.has(tool)) return "navigate";
  if (READ_TOOLS.has(tool)) return "read";
  // A browser call that takes an address opens it: navigation.
  if (tool.startsWith("browser_") && typeof input.url === "string") return "navigate";
  return "act";
}

/**
 * The family of a tool, or undefined when the gate does not cover it.
 *
 * @param tool - The tool's name.
 */
export function controlKindOf(tool: string): ControlKind | undefined {
  return tool.startsWith("browser_") ? "browser" : tool.startsWith("computer_") ? "computer" : undefined;
}

/**
 * The mode that applies to one call: helpers use the helpers' mode (never Skip); Skip without the owner's yes is
 * Manual; Skip never covers computer control (it becomes Auto, the reviewer still looks).
 *
 * @param s - The settings.
 * @param kind - Browser or computer.
 * @param helper - Whether a helper asks.
 */
export function effectiveMode(s: Pick<PolicySettings, "mode" | "helperMode" | "skipAllowed">, kind: ControlKind, helper: boolean): ControlMode {
  if (helper) return s.helperMode === "auto" ? "auto" : "manual";
  if (s.mode !== "skip") return s.mode;
  if (!s.skipAllowed) return "manual";
  return kind === "computer" ? "auto" : "skip";
}

/**
 * Decides one browser or computer call. Pure: the same call and settings always give the same answer.
 *
 * @param c - The call.
 * @param s - The owner's settings.
 * @returns allow / review / ask / deny, with the reason, tags and whether "Always" may be offered.
 */
export function decideControl(c: PolicyCall, s: PolicySettings): PolicyDecision {
  const where = c.site ?? c.app ?? "this target";
  const helperNoAlways = !!c.helper && !s.helperAlways;
  if (c.site && s.blocked.some((b) => hostMatches(c.site!, b)))
    return { action: "deny", reason: `${c.site} is on the blocked list (Settings → Browser and computer): KesherAI never uses it.`, why: ["blocked"], noAlways: true };
  if (c.plan && c.action !== "read")
    return { action: "deny", reason: "Plan mode: you may only read and look around. Put this step in your plan and finish with present_plan.", why: ["plan"], noAlways: true };
  if (c.action === "eval" && s.js === "off")
    return { action: "deny", reason: "Running JavaScript on pages is turned off (Settings → Browser and computer → JavaScript).", why: ["js"], noAlways: true };
  const sensitive = c.kind === "browser" ? sensitiveKind(c.site, c.url, s.sensitive) : undefined;
  if (sensitive)
    return { action: "ask", reason: `${where} is ${KIND_WORDS[sensitive]}, so every action there is asked, in every mode.`, why: ["sensitive"], noAlways: true, sensitive };
  if (c.mustAsk) return { action: "ask", reason: c.mustAsk, why: ["always-ask"], noAlways: true };
  if (c.action === "eval" && (s.js === "ask" || !isLocalSite(c.site)))
    return { action: "ask", reason: `Runs JavaScript on ${where}, so it is asked every time.`, why: ["js"], noAlways: true };
  if (c.action === "read") return { action: "allow", reason: "Only looks.", why: ["read"], noAlways: helperNoAlways };
  const outside = c.kind === "browser" && !!c.site && c.taskSites.length > 0 && !isLocalSite(c.site) && !c.taskSites.some((t) => hostMatches(c.site!, t));
  if (outside && !c.always)
    return { action: "ask", reason: `${c.site} is outside this task's sites (${c.taskSites.slice(0, 3).join(", ")}), so leaving them is asked.`, why: ["origin"], noAlways: helperNoAlways };
  const mode = effectiveMode(s, c.kind, !!c.helper);
  if (c.always && !helperNoAlways) return { action: "allow", reason: `"Always" is on for ${where}.`, why: ["always"], noAlways: false };
  if (mode === "skip") return { action: "allow", reason: "Skip mode: runs without asking.", why: ["skip"], noAlways: false };
  if (mode === "auto") return { action: "review", reason: "Auto mode: the local reviewer looks at it first.", why: ["review"], noAlways: helperNoAlways };
  return { action: "ask", reason: c.helper ? `${c.helper} asks before every action (Manual mode).` : "Manual mode: every action is asked.", why: ["manual"], noAlways: helperNoAlways };
}

/**
 * The task's sites from what the user wrote: the hosts of addresses and bare domains ("example.com") in their
 * messages. The origin gate uses them with the sites the user approved in the chat.
 *
 * @param messages - The user's messages.
 * @returns Hosts without "www.", at most 20.
 */
export function sitesInText(messages: readonly string[]): string[] {
  const out = new Set<string>();
  const re = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost)(?::\d+)?(?=[/\s"'),.!?]|$)/gi;
  for (const m of messages) for (const x of m.matchAll(re)) {
    const host = bareHost(x[1]!);
    // File names that look like domains ("report.pdf", "main.ts") are not sites.
    if (/\.(pdf|docx?|xlsx?|pptx?|txt|md|ts|tsx|js|jsx|json|png|jpe?g|gif|zip|exe|py|cs|cpp|h|html?|css)$/i.test(host)) continue;
    out.add(host);
    if (out.size >= 20) break;
  }
  return [...out];
}

/** One decision for the action log. */
export interface ControlDecision {
  /** When (ISO time). */
  at: string;
  /** The chat it belongs to. */
  chatId?: string;
  /** The helper's name, or undefined for the chat itself. */
  helper?: string;
  kind: ControlKind;
  tool: string;
  site?: string;
  app?: string;
  /** What it acted on, e.g. `button "Send"`. */
  target?: string;
  /** What was decided. */
  decision: "allow" | "deny" | "expired" | "always";
  /** Who decided: the policy (rules), the reviewer, "always", "skip", or the user. */
  by: "policy" | "reviewer" | "always" | "skip" | "user" | "timeout";
  /** The reason, short. */
  reason?: string;
}

/** Every browser and computer decision of the last day (at most 500), for the action log in the steps panel. */
export class ControlLog {
  private items: ControlDecision[] = [];

  /**
   * Adds a decision (its time is now).
   *
   * @param d - The decision.
   */
  add(d: Omit<ControlDecision, "at">): void {
    this.items.push({ at: new Date().toISOString(), ...d, ...(d.target ? { target: d.target.slice(0, 200) } : {}), ...(d.reason ? { reason: d.reason.slice(0, 300) } : {}) });
    const day = Date.now() - 24 * 60 * 60_000;
    while (this.items.length > 500 || (this.items[0] && Date.parse(this.items[0].at) < day)) this.items.shift();
  }

  /**
   * The newest decisions.
   *
   * @param n - How many, at most.
   * @param chatId - Only this chat's (with its helpers).
   * @returns Oldest first.
   */
  last(n = 50, chatId?: string): ControlDecision[] {
    return (chatId ? this.items.filter((d) => d.chatId === chatId) : this.items).slice(-n);
  }
}

/** How long an approval card waits before it counts as denied. */
export const CONTROL_APPROVAL_MS = 5 * 60_000;
