/**
 * What is left of every provider the PC's agents use, as one small snapshot for the hub page's Quotas section
 * (Roee, 27.11: "info on the usage of every option", "in the hub too I want info on quotas").
 *
 * {@link buildProviderQuotas} turns what the PC already knows (the task inbox's state, the free cloud helpers' state,
 * the local engine) into rows of names, numbers and times only: no keys, no paths, no prompts, no error texts.
 * {@link cleanProviderQuotas} is the strict reader the hub page uses on what arrives (lengths and numbers capped).
 * Nothing is guessed: a value the PC does not know is left out, and the page shows "unknown".
 *
 * Pure (no I/O), so it runs on the PC, in the hub page and in tests alike.
 */
import type { ClaudeState } from "./claude-code.js";
import type { AntigravityQuota, FreeProviderState, OpencodeState, RelayReport } from "./task-inbox.js";

/** Which family a row belongs to: picks its icon on the page (the same as the Tasks tab's agent chips). */
export type QuotaKind = "antigravity" | "ghostcli" | "opencode" | "gemini" | "free" | "local" | "claude";

/** A row's overall state: room left, under a fifth left, used up (or blocked), switched off / not set up, or unknown. */
export type QuotaState = "ok" | "low" | "out" | "off" | "unknown";

/** One bar of a row: a share left (0..1) or a count against a limit, and when it fills again. */
export interface QuotaBar {
  /** What the bar measures: a model group ("Gemini Pro"), or a window (`5h`, `week`, `day`). */
  label: string;
  /** Share left, 0..1, when the provider reports a share. */
  left?: number;
  /** Used so far in the window, when counted. */
  used?: number;
  /** The window's limit, when known. */
  limit?: number;
  /** When it fills again (ms since epoch), when known. */
  resetAt?: number;
}

/** Counts of agent runs (GhostCLI's trial report). */
export interface QuotaCounts {
  runs: number;
  done?: number;
  partial?: number;
  failed?: number;
  rateLimited?: number;
}

/** One provider as the Quotas section shows it. */
export interface ProviderQuota {
  /** Stable id: `antigravity`, `ghostcli`, `opencode`, `gemini`, `local`, `claude`, `inbox-<id>`, `cloud-<id>`. */
  id: string;
  kind: QuotaKind;
  /** `tasks`: used by the task inbox's agents; `chat`: the free cloud helpers of chats. */
  group: "tasks" | "chat";
  name: string;
  state: QuotaState;
  bars: QuotaBar[];
  /** Runs today (UTC day, as the PC counts its days). */
  today?: QuotaCounts;
  /** Runs in the whole report, and since when (ms). */
  total?: QuotaCounts & { since?: number };
  /** Average minutes of a finished run. */
  avgMinutes?: number;
  /** The last small "are you there" check. */
  health?: { ok: boolean; model: string; ms: number; at: number };
  /** Nothing starts before this (a 429, a used-up plan). */
  until?: number;
  /** The last "too many requests" answer. */
  lastRateLimitAt?: number;
  /** The model in use (the local engine's file name, without its folder). */
  model?: string;
  /** When the numbers were read (ms); absent: not known. */
  readAt?: number;
  /** Why an `off` row is off, when it is one the page can name (Claude Code: not installed, not signed in, an API key). */
  offWhy?: QuotaOffWhy;
}

/** Why a row is off. */
export type QuotaOffWhy = "not-installed" | "signed-out" | "api-key";

/** What {@link buildProviderQuotas} reads: the inbox state's quota fields and the free cloud helpers' state. */
export interface ProviderQuotaInput {
  /** The clock (ms). */
  now: number;
  /** The task inbox (InboxState's fields), when the PC has one. */
  inbox?: {
    agQuota?: AntigravityQuota;
    relay?: RelayReport;
    opencode?: OpencodeState;
    /** OpenCode Go's daily task cap (InboxSettings.opencode.dailyCap). */
    opencodeDailyCap?: number;
    claude?: ClaudeState;
    free?: FreeProviderState[];
    /** Antigravity's plan ran out (InboxState.quota): back after `until`. */
    quota?: { until: number };
  };
  /** The free cloud helpers of chats (`/api/free-cloud`'s providers). */
  freeCloud?: Array<{ id: string; name?: string; configured: boolean; enabled: boolean; state: string; until?: number; day: { used: number; limit: number }; lastOkAt?: number }>;
  /** The built-in engine: loaded or not, and its model file (a path is cut to the file name). */
  local?: { loaded: boolean; model?: string };
}

/** Limits of the snapshot (the cleaner enforces them on what arrives). */
export const QUOTA_LIMITS = { items: 24, bars: 8, nameChars: 60, labelChars: 40 } as const;

/** A share under this counts as low. */
const LOW = 0.2;
const DAY_MS = 86_400_000;

/** The next UTC midnight after `now`: when the PC's day counters (task inbox, free helpers) start again. */
export const nextUtcDay = (now: number): number => (Math.floor(now / DAY_MS) + 1) * DAY_MS;

/**
 * Antigravity's quota group of a model (models of one group share one allowance): Claude and GPT-OSS models share a
 * pool, Gemini Flash has its own, the other Gemini models theirs.
 *
 * @param name - The model's name as Antigravity reports it.
 * @returns The group's label.
 */
export function antigravityGroup(name: string): string {
  if (/claude|gpt|opus|sonnet/i.test(name)) return "Claude / GPT";
  if (/flash/i.test(name)) return "Gemini Flash";
  if (/gemini/i.test(name)) return "Gemini Pro";
  return name.slice(0, QUOTA_LIMITS.labelChars);
}

/** A row's state from its bars: out when every bar is used up, low when one is under {@link LOW}. */
function stateOf(bars: QuotaBar[]): QuotaState {
  const shares = bars.map(shareLeft).filter((x): x is number => x !== undefined);
  if (!shares.length) return "unknown";
  if (shares.every((s) => s <= 0)) return "out";
  return shares.some((s) => s < LOW) ? "low" : "ok";
}

/**
 * The share left of a bar: its own share, or 1 - used/limit when counted against a limit.
 *
 * @param b - The bar.
 * @returns 0..1, or undefined when it is not known.
 */
export function shareLeft(b: QuotaBar): number | undefined {
  if (b.left !== undefined) return b.left;
  if (b.used !== undefined && b.limit) return Math.max(0, 1 - b.used / b.limit);
  return undefined;
}

/** The file name of a model, without its folder or `.gguf` (never a path). */
const fileName = (s: string): string => (s.split(/[\\/]/).pop() ?? "").replace(/\.gguf$/i, "").slice(0, QUOTA_LIMITS.nameChars);

/**
 * Builds the Quotas snapshot from what the PC knows. The task agents come first (always listed, "unknown" when there
 * is no reading), then each connected free service of the inbox, then each set-up free cloud helper of chats.
 *
 * @param input - The inbox and free cloud state, and the clock.
 * @returns The rows (names, numbers and times only).
 */
export function buildProviderQuotas(input: ProviderQuotaInput): ProviderQuota[] {
  const { now, inbox = {} } = input;
  const out: ProviderQuota[] = [];
  const later = (t: number | undefined) => (t !== undefined && t > now ? t : undefined);

  // Antigravity: one bar per model group (the lowest share of the group, the earliest reset).
  const ag = inbox.agQuota;
  const groups = new Map<string, QuotaBar>();
  for (const m of ag?.models ?? []) {
    const label = antigravityGroup(m.name);
    const g = groups.get(label);
    const left = Math.max(0, Math.min(1, m.left));
    const resetAt = later(m.resetAt);
    if (!g) groups.set(label, { label, left, ...(resetAt ? { resetAt } : {}) });
    else {
      g.left = Math.min(g.left ?? 1, left);
      if (resetAt && (!g.resetAt || resetAt < g.resetAt)) g.resetAt = resetAt;
    }
  }
  const agBars = [...groups.values()];
  const agUntil = later(inbox.quota?.until);
  out.push({ id: "antigravity", kind: "antigravity", group: "tasks", name: "Antigravity", state: agUntil ? "out" : stateOf(agBars), bars: agBars, ...(agUntil ? { until: agUntil } : {}), ...(ag ? { readAt: ag.at } : {}) });

  // GhostCLI: no quota is published; its health check and its run counts say whether "unlimited" holds.
  const r = inbox.relay;
  if (r) {
    const dayStart = nextUtcDay(now) - DAY_MS;
    const todays = r.recent.filter((x) => x.at >= dayStart && x.status !== "probe-ok" && x.status !== "probe-failed");
    const count = (s: string) => todays.filter((x) => x.status === s).length;
    const h = r.health;
    const limitedRecently = r.lastRateLimitAt !== undefined && now - r.lastRateLimitAt < 60 * 60_000;
    out.push({
      id: "ghostcli",
      kind: "ghostcli",
      group: "tasks",
      name: "GhostCLI",
      state: h && !h.ok ? "low" : limitedRecently ? "low" : h || r.runs ? "ok" : "unknown",
      bars: [],
      today: { runs: todays.length, done: count("done"), partial: count("partial"), failed: count("failed"), rateLimited: count("rate-limited") },
      total: { runs: r.runs, done: r.done, partial: r.partial, failed: r.failed, rateLimited: r.rateLimited, ...(r.since ? { since: r.since } : {}) },
      ...(r.avgMinutes !== undefined ? { avgMinutes: r.avgMinutes } : {}),
      ...(h ? { health: { ok: h.ok, model: h.model.slice(0, QUOTA_LIMITS.nameChars), ms: h.ms, at: h.at } } : {}),
      ...(r.lastRateLimitAt ? { lastRateLimitAt: r.lastRateLimitAt } : {}),
      ...(r.recent[0] ? { readAt: Math.max(r.recent[0].at, h?.at ?? 0) } : h ? { readAt: h.at } : {}),
    });
  } else out.push({ id: "ghostcli", kind: "ghostcli", group: "tasks", name: "GhostCLI", state: "unknown", bars: [] });

  // OpenCode Go: today's tasks against the daily cap; blocked after a 429 or a used-up plan. The monthly share is not reported.
  const oc = inbox.opencode;
  if (oc) {
    const cap = inbox.opencodeDailyCap;
    const until = later(oc.until);
    const bar: QuotaBar = { label: "day", used: oc.used, ...(cap ? { limit: cap } : {}), ...(cap && oc.used >= cap ? { resetAt: nextUtcDay(now) } : {}) };
    out.push({ id: "opencode", kind: "opencode", group: "tasks", name: "OpenCode Go", state: !oc.ready ? "off" : until ? "out" : stateOf([bar]), bars: [bar], ...(until ? { until } : {}), readAt: now });
  } else out.push({ id: "opencode", kind: "opencode", group: "tasks", name: "OpenCode Go", state: "unknown", bars: [] });

  // The inbox's free services (Gemini's free key first): today's requests against the day's limit when it is known.
  const free = inbox.free ?? [];
  const gemini = free.find((f) => f.id === "gemini");
  for (const f of gemini ? [gemini, ...free.filter((x) => x !== gemini)] : free) {
    const until = later(f.until);
    const bar: QuotaBar = { label: "day", used: f.used, ...(f.limit ? { limit: f.limit } : {}), ...((f.limit && f.used >= f.limit) || until ? { resetAt: until ?? nextUtcDay(now) } : {}) };
    const isGemini = f.id === "gemini";
    out.push({ id: isGemini ? "gemini" : `inbox-${f.id}`.slice(0, 64), kind: isGemini ? "gemini" : "free", group: "tasks", name: f.name.slice(0, QUOTA_LIMITS.nameChars), state: until ? "out" : f.limit ? stateOf([bar]) : "ok", bars: [bar], ...(until ? { until } : {}), readAt: now });
  }
  if (!gemini) out.push({ id: "gemini", kind: "gemini", group: "tasks", name: "Gemini", state: "unknown", bars: [] });

  // Claude (the subscription, through Claude Code): its 5-hour and weekly windows, as Claude Code last reported them
  // (claude-usage.ts reads them every 30 minutes). Listed off, with why, when it is not installed or not signed in.
  const c = inbox.claude;
  const CLAUDE = "Claude (subscription)";
  if (c && !c.installed) out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: "off", bars: [], offWhy: "not-installed" });
  else if (c && (c.loggedIn === false || c.account === "none")) out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: "off", bars: [], offWhy: "signed-out" });
  else if (c) {
    const bars: QuotaBar[] = [];
    const q = c.quota;
    if (q?.fiveHour) bars.push({ label: "5h", left: Math.max(0, Math.min(1, 1 - q.fiveHour.usedPercentage / 100)), resetAt: q.fiveHour.resetsAt });
    if (q?.sevenDay) bars.push({ label: "week", left: Math.max(0, Math.min(1, 1 - q.sevenDay.usedPercentage / 100)), resetAt: q.sevenDay.resetsAt });
    const until = later(c.blocked?.until);
    const apiKey = c.account === "api-key";
    out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: apiKey ? "off" : until ? "out" : stateOf(bars), bars, today: { runs: c.used }, ...(until ? { until } : {}), ...(q ? { readAt: q.at } : {}), ...(apiKey ? { offWhy: "api-key" as const } : {}) });
  } else out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: "unknown", bars: [] });

  // The local model: no quota, only whether it is loaded now.
  const l = input.local;
  if (l) {
    const model = l.loaded && l.model ? fileName(l.model) : "";
    out.push({ id: "local", kind: "local", group: "tasks", name: "Local model", state: l.loaded ? "ok" : "off", bars: [], ...(model ? { model } : {}), readAt: now });
  } else out.push({ id: "local", kind: "local", group: "tasks", name: "Local model", state: "unknown", bars: [] });

  // The free cloud helpers of chats that have a key: today's requests against the day's limit.
  for (const p of input.freeCloud ?? []) {
    if (!p.configured) continue;
    const until = later(p.until);
    const bar: QuotaBar = { label: "day", used: p.day.used, ...(p.day.limit ? { limit: p.day.limit } : {}), ...(until ? { resetAt: until } : p.day.limit && p.day.used >= p.day.limit ? { resetAt: nextUtcDay(now) } : {}) };
    out.push({ id: `cloud-${p.id}`.slice(0, 64), kind: "free", group: "chat", name: (p.name ?? p.id).slice(0, QUOTA_LIMITS.nameChars), state: !p.enabled || p.state === "off" ? "off" : until ? "out" : p.day.limit ? stateOf([bar]) : "ok", bars: [bar], ...(until ? { until } : {}), readAt: now });
  }
  return out.slice(0, QUOTA_LIMITS.items);
}

const KINDS: readonly QuotaKind[] = ["antigravity", "ghostcli", "opencode", "gemini", "free", "local", "claude"];
const STATES: readonly QuotaState[] = ["ok", "low", "out", "off", "unknown"];
const OFF_WHY: readonly QuotaOffWhy[] = ["not-installed", "signed-out", "api-key"];
const ID = /^[\w-]{1,64}$/;
/** A whole number of at least 0, below 2^53; anything else is undefined. */
const n0 = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? Math.floor(v) : undefined);
/** A text on one line, trimmed and cut. */
const line = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const opt = <T>(k: string, v: T | undefined) => (v !== undefined ? { [k]: v } : {});

function cleanCounts(x: unknown): QuotaCounts | undefined {
  if (!x || typeof x !== "object") return undefined;
  const c = x as Record<string, unknown>;
  const runs = n0(c.runs);
  if (runs === undefined) return undefined;
  return { runs, ...opt("done", n0(c.done)), ...opt("partial", n0(c.partial)), ...opt("failed", n0(c.failed)), ...opt("rateLimited", n0(c.rateLimited)) };
}

function cleanBar(x: unknown): QuotaBar | null {
  if (!x || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  const label = line(b.label, QUOTA_LIMITS.labelChars);
  if (!label) return null;
  const left = typeof b.left === "number" && Number.isFinite(b.left) ? Math.max(0, Math.min(1, b.left)) : undefined;
  return { label, ...opt("left", left), ...opt("used", n0(b.used)), ...opt("limit", n0(b.limit) || undefined), ...opt("resetAt", n0(b.resetAt) || undefined) };
}

/**
 * The strict reader of a quotas snapshot from untrusted input: known kinds and states only, short one-line texts,
 * whole numbers, shares clamped to 0..1, at most {@link QUOTA_LIMITS} rows and bars. A bad row is dropped.
 *
 * @param x - What arrived.
 * @returns The clean rows.
 */
export function cleanProviderQuotas(x: unknown): ProviderQuota[] {
  if (!Array.isArray(x)) return [];
  const out: ProviderQuota[] = [];
  for (const raw of x.slice(0, QUOTA_LIMITS.items)) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    const name = line(q.name, QUOTA_LIMITS.nameChars);
    if (typeof q.id !== "string" || !ID.test(q.id) || !name || !KINDS.includes(q.kind as QuotaKind)) continue;
    const h = q.health && typeof q.health === "object" ? (q.health as Record<string, unknown>) : undefined;
    const ms = n0(h?.ms);
    const at = n0(h?.at);
    const total = cleanCounts(q.total);
    const since = n0((q.total as Record<string, unknown> | undefined)?.since);
    const avg = typeof q.avgMinutes === "number" && Number.isFinite(q.avgMinutes) && q.avgMinutes >= 0 ? Math.round(Math.min(q.avgMinutes, 10_000) * 10) / 10 : undefined;
    const model = line(q.model, QUOTA_LIMITS.nameChars);
    out.push({
      id: q.id,
      kind: q.kind as QuotaKind,
      group: q.group === "chat" ? "chat" : "tasks",
      name,
      state: STATES.includes(q.state as QuotaState) ? (q.state as QuotaState) : "unknown",
      bars: Array.isArray(q.bars) ? q.bars.slice(0, QUOTA_LIMITS.bars).map(cleanBar).filter((b): b is QuotaBar => !!b) : [],
      ...opt("today", cleanCounts(q.today)),
      ...opt("total", total ? { ...total, ...opt("since", since || undefined) } : undefined),
      ...opt("avgMinutes", avg),
      ...opt("health", h && ms !== undefined && at ? { ok: h.ok === true, model: line(h.model, QUOTA_LIMITS.nameChars), ms, at } : undefined),
      ...opt("until", n0(q.until) || undefined),
      ...opt("lastRateLimitAt", n0(q.lastRateLimitAt) || undefined),
      ...opt("model", model || undefined),
      ...opt("readAt", n0(q.readAt) || undefined),
      ...opt("offWhy", OFF_WHY.includes(q.offWhy as QuotaOffWhy) ? (q.offWhy as QuotaOffWhy) : undefined),
    });
  }
  return out;
}
