/**
 * "Waiting for you" on the hub page and the phone's Cloud tab (the same page): everything on the owner's PCs that
 * waits for an answer, at the top of the dashboard and the Tasks tab, with a count on the tabs. Layout: the design
 * doc's HubWaiting / PhoneHubWaiting boards.
 *
 * - A chat's or a sub-agent's step (the PC's sealed `approvals` snapshot): what (the chat, the tool, a short preview),
 *   who asks and why, with Approve once / Allow for a while / Deny.
 * - "Run this task in Antigravity?": Run / Not now (one press is one run, as on the PC).
 * - A live agent card that waits (a helper's yes/no, an Antigravity step) and is not in a snapshot: its own buttons.
 *
 * Every answer is a sealed `approval_answer` to that PC, which applies it exactly as its own approval card does; the
 * hub only relays it. Nothing here is stored.
 */
import { isGoing } from "../../../packages/shared/src/hub-agents.js";
import { h, L, when } from "./dom.js";
/**
 * Everything waiting for the owner on the PCs that are on: the PCs' approval snapshots, then waiting agent cards that
 * no snapshot lists (by request id), newest first.
 *
 * @param device - The page's device.
 * @returns The entries.
 */
export function waitingEntries(device) {
    const out = device.waiting();
    const listed = new Set(out.map((e) => `${e.pc.id}/${e.item.requestId}`));
    for (const c of device.agents.values()) {
        const w = c.state.state === "waiting" ? c.state.waiting : undefined;
        const pc = device.presence.find((d) => d.id === c.deviceId && d.online);
        if (!w || !pc || !isGoing(c) || listed.has(`${pc.id}/${w.requestId}`))
            continue;
        const sent = device.agentActions.get(`${c.deviceId}/${c.runId}`);
        out.push({ pc, card: c, ...(sent ? { sent } : {}) });
    }
    return out;
}
/** "Allow for a while": how long, as on the PC's own card (minutes). */
const FOR = [
    [15, "15 דקות", "15 minutes"],
    [60, "שעה", "1 hour"],
    [240, "4 שעות", "4 hours"],
];
let forMinutes = 60;
/** The buttons of one entry, or "Sent to the PC…" once answered. */
function buttons(v, e) {
    if (e.sent)
        return h("div", { class: "row wrap acts" }, h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…")));
    const off = !v.device.connected;
    const btn = (label, cls, run, title) => h("button", { type: "button", class: `btn sm-btn ${cls}`, disabled: off, title, onclick: (ev) => { ev.stopPropagation(); void run().then((ok) => !ok && v.render()); } }, label);
    if (e.card) {
        const c = e.card;
        const w = c.state.waiting;
        const [yes, no] = w.reason === "run-press" ? [L("▶ הרץ", "▶ Run"), L("לא עכשיו", "Not now")] : w.reason === "ask" ? [L("כן", "Yes"), L("לא", "No")] : [L("✓ אשר פעם אחת", "✓ Approve once"), L("דחה", "Deny")];
        return h("div", { class: "row wrap acts" }, btn(yes, "pri", () => v.device.answerAgent(c, "allow")), btn(no, "", () => v.device.answerAgent(c, "deny")), h("button", { type: "button", class: "btn sm-btn", onclick: () => v.openAgent(`${c.deviceId}/${c.runId}`) }, L("כרטיס ›", "Card ›")));
    }
    const a = e.item;
    const pc = e.pc.id;
    if (a.kind === "run")
        return h("div", { class: "row wrap acts" }, btn(L("▶ הרץ", "▶ Run"), "pri", () => v.device.answerApproval(pc, a, "allow")), btn(L("לא עכשיו", "Not now"), "", () => v.device.answerApproval(pc, a, "deny")));
    const label = FOR.find(([m]) => m === forMinutes) ?? FOR[1];
    return h("div", { class: "row wrap acts" }, btn(L("✓ אשר פעם אחת", "✓ Approve once"), "pri", () => v.device.answerApproval(pc, a, "allow")), a.forWhile
        ? h("span", { class: "row wfor" }, btn(L(`אשר ל${label[1]}`, `Allow for ${label[2].toLowerCase()}`), "", () => v.device.answerApproval(pc, a, "allow", forMinutes), L(`בלי לשאול שוב על ${a.tool} בצ׳אט הזה`, `No more asking for ${a.tool} in this chat`)), h("select", { class: "inp wsel", "aria-label": L("לכמה זמן לאשר", "Allow for how long"), onchange: (ev) => { forMinutes = Number(ev.target.value); v.render(); } }, FOR.map(([m, he, en]) => h("option", { value: m, selected: m === forMinutes }, L(he, en)))))
        : null, btn(L("דחה", "Deny"), "bad", () => v.device.answerApproval(pc, a, "deny")));
}
/** One entry: what, who and why, then the buttons. */
function entry(v, e) {
    const a = e.item;
    const c = e.card;
    const what = a ? (a.kind === "run" ? a.title.replace(/^Run in Antigravity\? /, "") : a.title || a.tool) : c.state.title;
    const icon = a ? (a.kind === "run" ? "✦" : a.who ? "🤖" : "💬") : c.state.waiting?.reason === "run-press" ? "✦" : "🤖";
    const who = a ? (a.kind === "run" ? L("להריץ ב-Antigravity?", "Run in Antigravity?") : a.who ? L(`סוכן משנה: ${a.who}`, `Sub-agent: ${a.who}`) : L("הסוכן של הצ׳אט", "The chat's agent")) : L("סוכן", "Agent");
    const why = a ? a.reason : (c.state.waiting?.summary ?? "");
    return h("div", { class: "acard wait wentry", role: "group", "aria-label": what }, h("div", { class: "row" }, h("span", { "aria-hidden": "true" }, icon), h("b", { class: "grow ell1", dir: "auto" }, what), a && a.kind === "tool" ? h("span", { class: "chip mono" }, a.tool) : null), h("div", { class: "row wrap mut xs" }, h("span", null, who), h("span", null, `🖥 ${e.pc.name}`), a?.at ? h("span", null, when(a.at)) : null), why ? h("div", { class: "sm warn wrapl", dir: "auto" }, why) : null, a?.preview ? h("pre", { class: "xs mono wprev", dir: "ltr" }, a.preview) : null, buttons(v, e));
}
/**
 * The "Waiting for you" section, or nothing when nothing waits.
 *
 * @param v - The page's parts.
 * @returns The section.
 */
export function waitingSection(v) {
    const list = waitingEntries(v.device);
    if (!list.length)
        return null;
    return h("section", { class: "card clip waiting", "aria-label": L("מחכה לך", "Waiting for you"), "aria-live": "polite" }, h("div", { class: "row head" }, h("b", null, L("⏳ מחכה לך", "⏳ Waiting for you")), h("span", { class: "tag t-ask" }, String(list.length)), h("span", { class: "grow" }), h("span", { class: "mut xs" }, L("התשובה נשלחת נעולה למחשב", "The answer goes sealed to the PC"))), list.map((e) => entry(v, e)));
}
