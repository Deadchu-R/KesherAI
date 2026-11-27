/**
 * "Task chat" on the hub's Tasks page (design doc: HubTaskChat, desktop and phone): a chat whose only job is organising
 * the task board. The owner writes; a small model on the PC's processor answers and PROPOSES changes; each proposal
 * is a card with Apply / Cancel, and nothing changes before Apply.
 *
 * Everything is sealed between this page and the PC (kinds `taskchat` / `taskchat_answer`): the hub relays ciphertext
 * and never sees a message. The transcript (the newest {@link KEEP} messages) is kept in this browser only. When no
 * PC is on, the panel says "PC is off" and sends nothing.
 */
import { randomB64url } from "../../../packages/shared/src/hub-crypto.js";
import { ASSIGN_CHOICES } from "../../../packages/shared/src/task-assign.js";
import { TASK_CHAT_LIMITS } from "../../../packages/shared/src/hub-task-chat.js";
import { h, L } from "./dom.js";
import { get, put } from "./device.js";
/** Messages kept in this browser. */
const KEEP = 30;
/** How long the page waits for the small model before it says it did not answer (a CPU model can take a while). */
const WAIT_MS = 150_000;
/** The panel's state: the transcript, the draft, whether it is open (undefined = open when there are messages). */
const chat = { msgs: [], draft: "", loaded: false, wired: false, applying: new Map() };
/** Loads the saved transcript once (an ask older than the wait is marked unanswered). */
export function loadTaskChat(render) {
    if (chat.loaded)
        return;
    chat.loaded = true;
    void get("taskchat")
        .then((saved) => {
        if (!Array.isArray(saved))
            return;
        chat.msgs = saved.slice(-KEEP).map((m) => ({ ...m, ...(m.pending && Date.now() - m.at > WAIT_MS ? { pending: false, failed: true } : {}), ...(m.proposal?.state === "applying" ? { proposal: { ...m.proposal, state: "expired" } } : {}) }));
        render();
    })
        .catch(() => undefined);
}
/** Saves the transcript in this browser. */
function save() {
    chat.msgs = chat.msgs.slice(-KEEP);
    void put("taskchat", chat.msgs).catch(() => undefined);
}
/** The PC the chat talks to: the first one that is on. */
function target(d) {
    return d.onlinePcs()[0];
}
/** Puts an answer into the transcript (the page calls this for every sealed `taskchat_answer`). */
export function onChatAnswer(a, render) {
    const ask = chat.msgs.find((m) => m.id === a.chatId && m.who === "me");
    const applyOf = chat.applying.get(a.chatId);
    chat.applying.delete(a.chatId);
    const card = applyOf ? chat.msgs.find((m) => m.proposal?.id === applyOf) : undefined;
    if (a.kind === "applied" && card?.proposal) {
        card.proposal.state = "applied";
        card.proposal.result = a.text;
    }
    else if (a.kind === "refused" && card?.proposal) {
        // The PC no longer has it (expired, or a restart): the card cannot be applied any more.
        card.proposal.state = "expired";
        card.proposal.result = a.text;
    }
    else if (a.kind === "cancelled") {
        // The card already shows "cancelled" (set when pressed).
    }
    else if (ask) {
        ask.pending = false;
        chat.msgs.push({ id: randomB64url(6), who: "pc", text: a.text, at: Date.now(), ...(a.kind === "refused" ? { failed: true } : {}), ...(a.proposal ? { proposal: { ...a.proposal, state: "open" } } : {}) });
    }
    else
        return;
    save();
    render();
}
/** Sends the draft as a message. */
async function say(v) {
    const text = chat.draft.trim().slice(0, TASK_CHAT_LIMITS.textChars);
    const pc = target(v.device);
    if (!text || !pc)
        return;
    const id = randomB64url(9);
    chat.msgs.push({ id, who: "me", text, at: Date.now(), pending: true });
    chat.draft = "";
    save();
    v.render();
    const sent = await v.device.sendTaskChat(pc, { type: "taskchat", chatId: id, op: "say", text, at: Date.now() });
    if (!sent)
        fail(id, v.render);
    else
        setTimeout(() => fail(id, v.render), WAIT_MS);
}
/** A message that got no answer in time is marked, once. */
function fail(id, render) {
    const m = chat.msgs.find((x) => x.id === id);
    if (!m?.pending)
        return;
    m.pending = false;
    m.failed = true;
    save();
    render();
}
/** Apply or Cancel on a proposal card. */
async function decide(v, msg, op) {
    const p = msg.proposal;
    const pc = target(v.device);
    if (!p || p.state !== "open")
        return;
    if (op === "cancel")
        p.state = "cancelled";
    else if (!pc)
        return;
    else
        p.state = "applying";
    const id = randomB64url(9);
    if (op === "apply")
        chat.applying.set(id, p.id);
    save();
    v.render();
    if (!pc)
        return;
    const sent = await v.device.sendTaskChat(pc, { type: "taskchat", chatId: id, op, proposalId: p.id, at: Date.now() });
    if (!sent && op === "apply") {
        p.state = "open";
        chat.applying.delete(id);
        save();
        v.render();
    }
}
/** One proposed change, in words. */
export function actionText(a) {
    const who = (to) => {
        const c = ASSIGN_CHOICES.find((x) => x.to === to);
        return c ? L(c.he, c.en) : to;
    };
    switch (a.op) {
        case "add":
            return L(`＋ משימה חדשה: ${a.title}${a.executor !== "auto" ? ` (${who(a.executor)})` : ""}`, `＋ New task: ${a.title}${a.executor !== "auto" ? ` (${who(a.executor)})` : ""}`);
        case "split":
            return L(`✂ פיצול "${a.title}" ל-${a.parts.length} משימות: ${a.parts.map((p) => p.title).join(" · ")}. המקורית נדלגת.`, `✂ Split "${a.title}" into ${a.parts.length}: ${a.parts.map((p) => p.title).join(" · ")}. The original is skipped.`);
        case "assign":
            return L(`↪ "${a.title}" ← ${who(a.to)}`, `↪ "${a.title}" → ${who(a.to)}`);
        case "queue":
            return L(`⏭ הוספה לתור: ${a.title}`, `⏭ Add to the queue: ${a.title}`);
        case "unqueue":
            return L(`⏏ הוצאה מהתור: ${a.title}`, `⏏ Take out of the queue: ${a.title}`);
        case "skip":
            return L(`🗑 דילוג (סגירה): ${a.title}`, `🗑 Skip (close): ${a.title}`);
    }
}
/** The proposal card: the changes, and Apply / Cancel while it is open. */
function proposalCard(v, m) {
    const p = m.proposal;
    const done = {
        applied: ["✓ הוחל", "✓ Applied", "t-ok"],
        cancelled: ["בוטל", "Cancelled", "t-off"],
        expired: ["פג תוקף", "Expired", "t-off"],
    };
    const d = p.state === "open" || p.state === "applying" ? undefined : done[p.state];
    return h("div", { class: "tc-prop", role: "group", "aria-label": L("שינויים מוצעים", "Proposed changes") }, h("div", { class: "row wrap" }, h("b", { class: "sm grow" }, L("שינויים מוצעים", "Proposed changes")), d ? h("span", { class: `tag ${d[2]}` }, L(d[0], d[1])) : null), h("ul", { class: "tc-acts sm" }, p.actions.map((a) => h("li", { dir: "auto" }, actionText(a)))), p.result ? h("div", { class: "xs mut", dir: "auto" }, p.result) : null, p.state === "open" || p.state === "applying"
        ? h("div", { class: "row wrap" }, h("button", { type: "button", class: "btn pri", disabled: p.state === "applying" || !target(v.device), onclick: () => void decide(v, m, "apply") }, p.state === "applying" ? L("מחיל…", "Applying…") : L("החל", "Apply")), h("button", { type: "button", class: "btn", disabled: p.state === "applying", onclick: () => void decide(v, m, "cancel") }, L("בטל", "Cancel")), h("span", { class: "xs mut" }, L("שום דבר לא משתנה לפני ההחלה", "Nothing changes before Apply")))
        : null);
}
/** One message bubble. */
function bubble(v, m) {
    return h("div", { class: `tc-msg ${m.who === "me" ? "tc-me" : "tc-pc"}${m.failed ? " tc-bad" : ""}` }, h("div", { class: "tc-text sm", dir: "auto" }, m.text), m.pending ? h("div", { class: "xs mut", role: "status" }, L("חושב במעבד של המחשב…", "Thinking on the PC's processor…")) : null, m.who === "me" && m.failed ? h("div", { class: "xs tc-err" }, L("אין תשובה מהמחשב. נסו שוב.", "No answer from the PC. Try again.")) : null, m.proposal ? proposalCard(v, m) : null);
}
/**
 * The panel on the Tasks page: a header that folds it, the messages, and the input.
 *
 * @param v - The page's device and its redraw.
 * @returns The section.
 */
export function taskChatPanel(v) {
    if (!chat.wired) {
        chat.wired = true;
        v.device.chatListener = (_pc, a) => onChatAnswer(a, v.render);
    }
    loadTaskChat(v.render);
    const pc = target(v.device);
    const open = chat.open ?? chat.msgs.length > 0;
    const toggle = h("button", { type: "button", class: "btn grow tc-head", "aria-expanded": String(open), onclick: () => { chat.open = !open; v.render(); } }, h("span", null, `💬 ${L("צ'אט משימות", "Task chat")}`), h("span", { class: "mut xs" }, open ? "▾" : "▸"));
    if (!open)
        return h("section", { class: "card tchat" }, h("div", { class: "row wrap" }, toggle, !pc ? h("span", { class: "tag t-off" }, L("המחשב כבוי", "PC is off")) : null));
    const send = () => void say(v);
    const input = h("textarea", {
        class: "inp area tc-input",
        rows: 2,
        maxlength: TASK_CHAT_LIMITS.textChars,
        dir: "auto",
        placeholder: pc ? L("למשל: פצל את המשימה הגדולה, או סגור כפילויות", "e.g. split the big task, or close duplicates") : L("המחשב כבוי", "PC is off"),
        "aria-label": L("הודעה לצ'אט המשימות", "Message to the task chat"),
        disabled: !pc,
        oninput: (e) => { chat.draft = e.target.value; },
        onkeydown: (e) => { const k = e; if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) {
            k.preventDefault();
            send();
        } },
    });
    input.value = chat.draft;
    return h("section", { class: "card tchat" }, h("div", { class: "row wrap" }, toggle, pc ? h("span", { class: "tag t-ok" }, pc.name) : h("span", { class: "tag t-off" }, L("המחשב כבוי", "PC is off"))), h("div", { class: "xs mut tc-note" }, L("מודל קטן על המעבד של המחשב מארגן את הלוח. ההודעות מוצפנות בינך לבין המחשב; המרכז לא רואה אותן.", "A small model on the PC's processor organises the board. Messages are sealed between you and the PC; the hub never sees them.")), !pc ? h("div", { class: "tc-off sm", role: "status" }, L("המחשב כבוי. הצ'אט יחזור כשיידלק.", "The PC is off. The chat is back when it is on.")) : null, h("div", { class: "tc-list", role: "log", "aria-live": "polite" }, chat.msgs.length ? chat.msgs.map((m) => bubble(v, m)) : h("div", { class: "mut sm" }, L("עוד אין הודעות. אפשר לבקש: להוסיף משימה, לפצל, להעביר למבצע אחר, להוסיף לתור או לסגור כפילות.", "No messages yet. Ask it to add a task, split one, give one to another executor, queue it or close a duplicate."))), h("div", { class: "row tc-send" }, input, h("button", { type: "button", class: "btn pri", disabled: !pc, onclick: send }, L("שלח", "Send"))), chat.msgs.length ? h("button", { type: "button", class: "btn xs tc-clear", onclick: () => { chat.msgs = []; save(); v.render(); } }, L("נקה שיחה", "Clear chat")) : null);
}
