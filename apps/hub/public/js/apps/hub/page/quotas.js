/**
 * "Quotas" (מכסות) page of the hub (`#quotas`, the design doc's HubQuotas board): what is left of every provider each
 * PC's agents use, as the PC reports it (a sealed `quotas` snapshot: names, numbers and times only; see
 * packages/shared/src/provider-quotas.ts). One row per provider with the Tasks tab's icon, a bar per window or model
 * group, "back at HH:MM" when it is used up, and how old the reading is. Anything the PC does not know is "unknown".
 * Reached from the Tasks and Agents tabs (the "📊 Quotas" button); nothing is stored here.
 */
import { shareLeft } from "../../../packages/shared/src/provider-quotas.js";
import { h, L } from "./dom.js";
/** The same icons as the Tasks tab's agent chips (work.ts). */
const ICON = { antigravity: "✦", gemini: "✧", opencode: "◈", ghostcli: "👻", local: "◆", claude: "✷", free: "☁" };
const STATE = {
    ok: ["יש מכסה", "Available", "t-ok"],
    low: ["נמוך", "Low", "t-wait"],
    out: ["נגמר", "Used up", "t-bad"],
    off: ["כבוי", "Off", "t-off"],
    unknown: ["לא ידוע", "Unknown", "t-off"],
};
/** Bar labels the PC sends as words; model groups are shown as written. */
/** Why a row is off, in words. */
const OFF_WHY = {
    "not-installed": ["Claude Code לא מותקן במחשב", "Claude Code is not installed on the PC"],
    "signed-out": ["Claude Code לא מחובר למנוי", "Claude Code is not signed in to the plan"],
    "api-key": ["מחובר במפתח API (לא בשימוש: רק המנוי)", "Signed in with an API key (not used: the plan only)"],
};
const LABEL = { "5h": ["5 שעות", "5 hours"], week: ["שבוע", "Week"], day: ["היום", "Today"], month: ["חודש", "Month"] };
/** "HH:MM" today, or the weekday and time when it is another day. */
function clock(t, now) {
    const d = new Date(t);
    const sameDay = new Date(now).toDateString() === d.toDateString();
    return d.toLocaleString(L("he-IL", "en-GB"), sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
/** "now", "N min ago", "N h ago". */
function ago(t, now) {
    const m = Math.max(0, Math.round((now - t) / 60_000));
    if (m < 1)
        return L("עכשיו", "just now");
    if (m < 60)
        return L(`לפני ${m} דק׳`, `${m} min ago`);
    const hrs = Math.round(m / 60);
    return hrs < 48 ? L(`לפני ${hrs} שע׳`, `${hrs} h ago`) : L(`לפני ${Math.round(hrs / 24)} ימים`, `${Math.round(hrs / 24)} days ago`);
}
/** One bar: its label, the share left as a bar (or "unknown"), the count, and when it fills again. */
function bar(b, now) {
    const left = shareLeft(b);
    const pct = left === undefined ? undefined : Math.round(left * 100);
    const cls = left === undefined ? "" : left <= 0 ? " q-out" : left < 0.2 ? " q-low" : "";
    const label = LABEL[b.label] ? L(...LABEL[b.label]) : b.label;
    const count = b.used !== undefined ? (b.limit ? `${b.used}/${b.limit}` : L(`${b.used} (אין מגבלה ידועה)`, `${b.used} (no known limit)`)) : "";
    const back = b.resetAt && b.resetAt > now ? (left !== undefined && left <= 0 ? L(`חוזר ב-${clock(b.resetAt, now)}`, `back at ${clock(b.resetAt, now)}`) : L(`מתאפס ${clock(b.resetAt, now)}`, `resets ${clock(b.resetAt, now)}`)) : "";
    return h("div", { class: "q-bar" }, h("div", { class: "row wrap xs q-bar-head" }, h("span", { class: "grow", dir: "auto" }, label), count ? h("span", { class: "mono" }, count) : null, h("span", { class: "mono" }, pct === undefined ? (count ? "" : L("לא ידוע", "unknown")) : L(`${pct}% נשאר`, `${pct}% left`)), back ? h("span", { class: left !== undefined && left <= 0 ? "warn" : "mut" }, back) : null), pct === undefined ? null : h("div", { class: `q-track${cls}`, role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": `${label}: ${pct}%` }, h("i", { style: `width:${pct}%` })));
}
/** Today's runs and the report's totals (GhostCLI). */
function counts(q) {
    const t = q.today;
    const all = q.total;
    if (!t && !all)
        return null;
    const part = (c) => [L(`${c.runs} ריצות`, `${c.runs} runs`), c.done !== undefined ? L(`${c.done} הושלמו`, `${c.done} done`) : "", c.partial ? L(`${c.partial} חלקיות`, `${c.partial} partial`) : "", c.failed ? L(`${c.failed} נכשלו`, `${c.failed} failed`) : "", c.rateLimited ? L(`${c.rateLimited} הגבלות קצב`, `${c.rateLimited} rate-limited`) : ""].filter(Boolean).join(" · ");
    return h("div", { class: "xs q-facts" }, t ? h("div", null, h("b", null, L("היום: ", "Today: ")), part(t)) : null, all && q.kind === "ghostcli" ? h("div", { class: "mut" }, L("מאז ההתחלה: ", "Since the start: "), part(all), q.avgMinutes !== undefined ? L(` · ממוצע ${q.avgMinutes} דק׳`, ` · avg ${q.avgMinutes} min`) : "") : null);
}
/** One provider's row. */
function row(q, now) {
    const st = STATE[q.state];
    const blocked = q.until && q.until > now ? q.until : undefined;
    const name = q.kind === "local" ? L("סוכן מקומי", "Local model") : q.id === "claude" ? L("Claude (מנוי)", "Claude (subscription)") : q.name;
    return h("div", { class: `q-row q-${q.state}`, "data-id": q.id }, h("div", { class: "row wrap q-head" }, h("span", { class: "q-ic", "aria-hidden": "true" }, ICON[q.kind]), h("b", { class: "grow min0 ell1", dir: "auto" }, name), h("span", { class: `tag ${st[2]}` }, L(st[0], st[1]))), blocked ? h("div", { class: "xs warn" }, L(`חסום עד ${clock(blocked, now)}`, `Blocked until ${clock(blocked, now)}`)) : null, q.kind === "local" ? h("div", { class: "xs mut", dir: "auto" }, q.state === "ok" ? L(`טעון${q.model ? `: ${q.model}` : ""} · אין מכסה, רק המחשב`, `Loaded${q.model ? `: ${q.model}` : ""} · no quota, only the PC`) : q.state === "off" ? L("לא טעון עכשיו", "Not loaded now") : L("לא ידוע", "Unknown")) : null, q.health ? h("div", { class: `xs ${q.health.ok ? "mut" : "warn"}`, dir: "auto" }, q.health.ok ? L(`בדיקה אחרונה: ענה (${q.health.model}, ${(q.health.ms / 1000).toFixed(1)} ש׳) ${ago(q.health.at, now)}`, `Last check: answered (${q.health.model}, ${(q.health.ms / 1000).toFixed(1)} s) ${ago(q.health.at, now)}`) : L(`בדיקה אחרונה: לא ענה ${ago(q.health.at, now)}`, `Last check: no answer ${ago(q.health.at, now)}`)) : null, q.offWhy ? h("div", { class: "xs mut" }, L(...OFF_WHY[q.offWhy])) : null, q.bars.map((b) => bar(b, now)), counts(q), q.lastRateLimitAt ? h("div", { class: "xs mut" }, L(`הגבלת קצב אחרונה ${ago(q.lastRateLimitAt, now)}`, `Last rate limit ${ago(q.lastRateLimitAt, now)}`)) : null, !q.bars.length && !q.offWhy && q.kind !== "local" && q.kind !== "ghostcli" ? h("div", { class: "xs mut" }, q.state === "unknown" ? L("המחשב עוד לא קרא את המכסה", "The PC has not read its quota yet") : L("אין מכסה מדווחת", "No quota reported")) : null, h("div", { class: "xs mut q-age" }, q.readAt ? L(`נקרא ${ago(q.readAt, now)}`, `Read ${ago(q.readAt, now)}`) : L("לא נקרא", "Not read")));
}
/** One PC's rows: the task agents, then the chat's free cloud helpers. */
function pcQuotas(pc, snap, single, now) {
    const tasks = snap.items.filter((q) => q.group === "tasks");
    const chat = snap.items.filter((q) => q.group === "chat");
    return h("section", { class: "card clip q-pc", "aria-label": L(`מכסות ${pc.name}`, `Quotas of ${pc.name}`) }, h("div", { class: "row wrap head" }, h("b", null, single ? L("🖥 מחשב", "🖥 Computer") : `🖥 ${pc.name}`), pc.online ? null : h("span", { class: "tag t-off" }, L("המחשב כבוי · כפי שהיה", "PC off · as it was")), h("span", { class: "grow" }), h("span", { class: "mut xs" }, L(`עודכן ${ago(snap.at, now)}`, `Updated ${ago(snap.at, now)}`))), h("div", { class: "q-sub mut xs" }, L("סוכני המשימות", "Task agents")), h("div", { class: "q-list" }, tasks.map((q) => row(q, now))), chat.length ? h("div", { class: "q-sub mut xs" }, L("עוזרי ענן חינמיים (צ׳אט)", "Free cloud helpers (chat)")) : null, chat.length ? h("div", { class: "q-list" }, chat.map((q) => row(q, now))) : null);
}
/**
 * The Quotas page: each PC that reported, or a short hint when none did yet (an older KesherAI, or the PC is off).
 *
 * @param v - The page's parts.
 * @returns The page.
 */
export function quotasPage(v) {
    const now = Date.now();
    const pcs = v.devices().filter((p) => p.kind === "pc");
    const reported = pcs.filter((p) => v.device.quotas.has(p.id));
    return h("main", { class: "page" }, h("div", { class: "row wrap" }, h("h1", null, L("📊 מכסות", "📊 Quotas")), h("span", { class: "mut sm" }, L("כמה נשאר לכל ספק, ומתי הוא חוזר", "What is left of each provider, and when it is back")), h("span", { class: "grow" }), h("a", { class: "btn", href: "#agents" }, L("סוכנים ›", "Agents ›"))), reported.length
        ? reported.map((pc) => pcQuotas(pc, v.device.quotas.get(pc.id), reported.length === 1, now))
        : h("section", { class: "card" }, h("div", { class: "trow mut sm" }, !v.device.paired ? L("חברו את המכשיר הזה כדי לראות את המכסות (לשונית חיבור).", "Pair this device to see the quotas (Pair tab).") : pcs.some((p) => p.online) ? L("המחשב עוד לא שלח מכסות. עדכנו את KesherAI במחשב ודאו שהוא פתוח.", "The PC has not sent its quotas yet. Update KesherAI on the PC and keep it open.") : L("המחשב כבוי: המכסות יגיעו כשהוא יפעל.", "The PC is off: the quotas come when it is on."))), h("div", { class: "mut xs q-note" }, L("נשלח נעול מהמחשב: שמות, מספרים ושעות בלבד. מה שהמחשב לא יודע מסומן \"לא ידוע\".", "Sealed on the PC: names, numbers and times only. What the PC does not know shows as \"unknown\".")));
}
/**
 * The "📊 Quotas" button for the Tasks and Agents headers.
 *
 * @returns The link.
 */
export function quotasLink() {
    return h("a", { class: "btn q-link", href: "#quotas" }, L("📊 מכסות", "📊 Quotas"));
}
