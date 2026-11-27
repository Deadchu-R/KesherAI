import { EXECUTOR_NAMES } from "./quota-failover.js";
/** Limits of the snapshot (the cleaner enforces them on what arrives). */
export const QUOTA_LIMITS = { items: 24, bars: 8, nameChars: 60, labelChars: 40, moves: 6 };
/** A share under this counts as low. */
const LOW = 0.2;
const DAY_MS = 86_400_000;
/** The next UTC midnight after `now`: when the PC's day counters (task inbox, free helpers) start again. */
export const nextUtcDay = (now) => (Math.floor(now / DAY_MS) + 1) * DAY_MS;
/**
 * Antigravity's quota group of a model (models of one group share one allowance): Claude and GPT-OSS models share a
 * pool, Gemini Flash has its own, the other Gemini models theirs.
 *
 * @param name - The model's name as Antigravity reports it.
 * @returns The group's label.
 */
export function antigravityGroup(name) {
    if (/claude|gpt|opus|sonnet/i.test(name))
        return "Claude / GPT";
    if (/flash/i.test(name))
        return "Gemini Flash";
    if (/gemini/i.test(name))
        return "Gemini Pro";
    return name.slice(0, QUOTA_LIMITS.labelChars);
}
/** A row's state from its bars: out when every bar is used up, low when one is under {@link LOW}. */
function stateOf(bars) {
    const shares = bars.map(shareLeft).filter((x) => x !== undefined);
    if (!shares.length)
        return "unknown";
    if (shares.every((s) => s <= 0))
        return "out";
    return shares.some((s) => s < LOW) ? "low" : "ok";
}
/**
 * The share left of a bar: its own share, or 1 - used/limit when counted against a limit.
 *
 * @param b - The bar.
 * @returns 0..1, or undefined when it is not known.
 */
export function shareLeft(b) {
    if (b.left !== undefined)
        return b.left;
    if (b.used !== undefined && b.limit)
        return Math.max(0, 1 - b.used / b.limit);
    return undefined;
}
/** The file name of a model, without its folder or `.gguf` (never a path). */
const fileName = (s) => (s.split(/[\\/]/).pop() ?? "").replace(/\.gguf$/i, "").slice(0, QUOTA_LIMITS.nameChars);
/**
 * Builds the Quotas snapshot from what the PC knows. The task agents come first (always listed, "unknown" when there
 * is no reading), then each connected free service of the inbox, then each set-up free cloud helper of chats.
 *
 * @param input - The inbox and free cloud state, and the clock.
 * @returns The rows (names, numbers and times only).
 */
export function buildProviderQuotas(input) {
    const { now, inbox = {} } = input;
    const out = [];
    const later = (t) => (t !== undefined && t > now ? t : undefined);
    // Antigravity: one bar per model group (the lowest share of the group, the earliest reset).
    const ag = inbox.agQuota;
    const groups = new Map();
    for (const m of ag?.models ?? []) {
        const label = antigravityGroup(m.name);
        const g = groups.get(label);
        const left = Math.max(0, Math.min(1, m.left));
        const resetAt = later(m.resetAt);
        if (!g)
            groups.set(label, { label, left, ...(resetAt ? { resetAt } : {}) });
        else {
            g.left = Math.min(g.left ?? 1, left);
            if (resetAt && (!g.resetAt || resetAt < g.resetAt))
                g.resetAt = resetAt;
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
        const count = (s) => todays.filter((x) => x.status === s).length;
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
    }
    else
        out.push({ id: "ghostcli", kind: "ghostcli", group: "tasks", name: "GhostCLI", state: "unknown", bars: [] });
    // OpenCode Go: today's tasks against the daily cap; blocked after a 429 or a used-up plan. The monthly share is not reported.
    const oc = inbox.opencode;
    if (oc) {
        const cap = inbox.opencodeDailyCap;
        const until = later(oc.until);
        const bar = { label: "day", used: oc.used, ...(cap ? { limit: cap } : {}), ...(cap && oc.used >= cap ? { resetAt: nextUtcDay(now) } : {}) };
        out.push({ id: "opencode", kind: "opencode", group: "tasks", name: "OpenCode Go", state: !oc.ready ? "off" : until ? "out" : stateOf([bar]), bars: [bar], ...(until ? { until } : {}), readAt: now });
    }
    else
        out.push({ id: "opencode", kind: "opencode", group: "tasks", name: "OpenCode Go", state: "unknown", bars: [] });
    // The inbox's free services (Gemini's free key first): today's requests against the day's limit when it is known.
    const free = inbox.free ?? [];
    const gemini = free.find((f) => f.id === "gemini");
    for (const f of gemini ? [gemini, ...free.filter((x) => x !== gemini)] : free) {
        const until = later(f.until);
        const bar = { label: "day", used: f.used, ...(f.limit ? { limit: f.limit } : {}), ...((f.limit && f.used >= f.limit) || until ? { resetAt: until ?? nextUtcDay(now) } : {}) };
        const isGemini = f.id === "gemini";
        out.push({ id: isGemini ? "gemini" : `inbox-${f.id}`.slice(0, 64), kind: isGemini ? "gemini" : "free", group: "tasks", name: f.name.slice(0, QUOTA_LIMITS.nameChars), state: until ? "out" : f.limit ? stateOf([bar]) : "ok", bars: [bar], ...(until ? { until } : {}), readAt: now });
    }
    if (!gemini)
        out.push({ id: "gemini", kind: "gemini", group: "tasks", name: "Gemini", state: "unknown", bars: [] });
    // Claude (the subscription, through Claude Code): its 5-hour and weekly windows, as Claude Code last reported them
    // (claude-usage.ts reads them every 30 minutes). Listed off, with why, when it is not installed or not signed in.
    const c = inbox.claude;
    const CLAUDE = "Claude (subscription)";
    if (c && !c.installed)
        out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: "off", bars: [], offWhy: "not-installed" });
    else if (c && (c.loggedIn === false || c.account === "none"))
        out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: "off", bars: [], offWhy: "signed-out" });
    else if (c) {
        const bars = [];
        const q = c.quota;
        if (q?.fiveHour)
            bars.push({ label: "5h", left: Math.max(0, Math.min(1, 1 - q.fiveHour.usedPercentage / 100)), resetAt: q.fiveHour.resetsAt });
        if (q?.sevenDay)
            bars.push({ label: "week", left: Math.max(0, Math.min(1, 1 - q.sevenDay.usedPercentage / 100)), resetAt: q.sevenDay.resetsAt });
        const until = later(c.blocked?.until);
        const apiKey = c.account === "api-key";
        out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: apiKey ? "off" : until ? "out" : stateOf(bars), bars, today: { runs: c.used }, ...(until ? { until } : {}), ...(q ? { readAt: q.at } : {}), ...(apiKey ? { offWhy: "api-key" } : {}) });
    }
    else
        out.push({ id: "claude", kind: "claude", group: "tasks", name: CLAUDE, state: "unknown", bars: [] });
    // The local model: no quota, only whether it is loaded now.
    const l = input.local;
    if (l) {
        const model = l.loaded && l.model ? fileName(l.model) : "";
        out.push({ id: "local", kind: "local", group: "tasks", name: "Local model", state: l.loaded ? "ok" : "off", bars: [], ...(model ? { model } : {}), readAt: now });
    }
    else
        out.push({ id: "local", kind: "local", group: "tasks", name: "Local model", state: "unknown", bars: [] });
    // The free cloud helpers of chats that have a key: today's requests against the day's limit.
    for (const p of input.freeCloud ?? []) {
        if (!p.configured)
            continue;
        const until = later(p.until);
        const bar = { label: "day", used: p.day.used, ...(p.day.limit ? { limit: p.day.limit } : {}), ...(until ? { resetAt: until } : p.day.limit && p.day.used >= p.day.limit ? { resetAt: nextUtcDay(now) } : {}) };
        out.push({ id: `cloud-${p.id}`.slice(0, 64), kind: "free", group: "chat", name: (p.name ?? p.id).slice(0, QUOTA_LIMITS.nameChars), state: !p.enabled || p.state === "off" ? "off" : until ? "out" : p.day.limit ? stateOf([bar]) : "ok", bars: [bar], ...(until ? { until } : {}), readAt: now });
    }
    // Where the work of each task agent went while it was out (the row ids are the executors' ids).
    for (const row of out) {
        const to = new Map();
        for (const m of inbox.moves ?? [])
            if (m.from === row.id && row.group === "tasks")
                to.set(EXECUTOR_NAMES[m.to], (to.get(EXECUTOR_NAMES[m.to]) ?? 0) + 1);
        if (to.size)
            row.movedTo = [...to].map(([name, tasks]) => ({ name, tasks })).slice(0, QUOTA_LIMITS.moves);
    }
    return out.slice(0, QUOTA_LIMITS.items);
}
const KINDS = ["antigravity", "ghostcli", "opencode", "gemini", "free", "local", "claude"];
const STATES = ["ok", "low", "out", "off", "unknown"];
const OFF_WHY = ["not-installed", "signed-out", "api-key"];
const ID = /^[\w-]{1,64}$/;
/** A whole number of at least 0, below 2^53; anything else is undefined. */
const n0 = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? Math.floor(v) : undefined);
/** A text on one line, trimmed and cut. */
const line = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const opt = (k, v) => (v !== undefined ? { [k]: v } : {});
function cleanCounts(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const c = x;
    const runs = n0(c.runs);
    if (runs === undefined)
        return undefined;
    return { runs, ...opt("done", n0(c.done)), ...opt("partial", n0(c.partial)), ...opt("failed", n0(c.failed)), ...opt("rateLimited", n0(c.rateLimited)) };
}
/** "Where the work went" from untrusted input: one-line names and whole counts, at most {@link QUOTA_LIMITS}.moves. */
function cleanMoves(x) {
    if (!Array.isArray(x))
        return undefined;
    const out = x.slice(0, QUOTA_LIMITS.moves).flatMap((m) => {
        const r = m && typeof m === "object" ? m : {};
        const name = line(r.name, QUOTA_LIMITS.nameChars);
        const tasks = n0(r.tasks);
        return name && tasks ? [{ name, tasks }] : [];
    });
    return out.length ? out : undefined;
}
function cleanBar(x) {
    if (!x || typeof x !== "object")
        return null;
    const b = x;
    const label = line(b.label, QUOTA_LIMITS.labelChars);
    if (!label)
        return null;
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
export function cleanProviderQuotas(x) {
    if (!Array.isArray(x))
        return [];
    const out = [];
    for (const raw of x.slice(0, QUOTA_LIMITS.items)) {
        if (!raw || typeof raw !== "object")
            continue;
        const q = raw;
        const name = line(q.name, QUOTA_LIMITS.nameChars);
        if (typeof q.id !== "string" || !ID.test(q.id) || !name || !KINDS.includes(q.kind))
            continue;
        const h = q.health && typeof q.health === "object" ? q.health : undefined;
        const ms = n0(h?.ms);
        const at = n0(h?.at);
        const total = cleanCounts(q.total);
        const since = n0(q.total?.since);
        const avg = typeof q.avgMinutes === "number" && Number.isFinite(q.avgMinutes) && q.avgMinutes >= 0 ? Math.round(Math.min(q.avgMinutes, 10_000) * 10) / 10 : undefined;
        const model = line(q.model, QUOTA_LIMITS.nameChars);
        out.push({
            id: q.id,
            kind: q.kind,
            group: q.group === "chat" ? "chat" : "tasks",
            name,
            state: STATES.includes(q.state) ? q.state : "unknown",
            bars: Array.isArray(q.bars) ? q.bars.slice(0, QUOTA_LIMITS.bars).map(cleanBar).filter((b) => !!b) : [],
            ...opt("today", cleanCounts(q.today)),
            ...opt("total", total ? { ...total, ...opt("since", since || undefined) } : undefined),
            ...opt("avgMinutes", avg),
            ...opt("health", h && ms !== undefined && at ? { ok: h.ok === true, model: line(h.model, QUOTA_LIMITS.nameChars), ms, at } : undefined),
            ...opt("until", n0(q.until) || undefined),
            ...opt("lastRateLimitAt", n0(q.lastRateLimitAt) || undefined),
            ...opt("model", model || undefined),
            ...opt("readAt", n0(q.readAt) || undefined),
            ...opt("offWhy", OFF_WHY.includes(q.offWhy) ? q.offWhy : undefined),
            ...opt("movedTo", cleanMoves(q.movedTo)),
        });
    }
    return out;
}
