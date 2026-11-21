/**
 * The agents view of the hub page and of the phone's Cloud tab (the same page): every agent run of the owner's PCs,
 * live (docs/RESEARCH_LOG.md, "Live agent activity in the Kesher Cloud hub", plan step 5). Layout: the design doc's
 * HubAgents / HubAgentDetail and PhoneHubAgents / PhoneHubAgentDetail boards.
 *
 * - List: waiting runs pinned on top ("waiting for you"), then one group per device (PC on or off, last seen), and
 *   Claude cloud runs from this device's own task list. Each card: state dot, title, source, current step, elapsed,
 *   steps, tokens when known.
 * - Detail: the step timeline (newest first), files touched, and the buttons: Stop (a sealed `cancel`), Approve /
 *   Deny / Run (the sealed `approval_answer`), Open in Claude for a cloud run.
 *
 * Names and notes (docs/RESEARCH_LOG.md, "Agent names and notes", 2026-11-20; boards HubAgentLabel, PhoneHubAgentLabel):
 * the owner's name shows instead of the title (the title stays as a subtitle), the owner's note on the card and the
 * detail, and the run's own "doing now" line apart from it. Edited on the detail; the edit goes to the PC as a sealed
 * `agent-label` command, and the PC (the source of truth) sends the run's state again.
 *
 * Everything shown came sealed from the PC (titles, steps, tool names, counts); the hub cannot read it.
 */
import { isGoing, runWait, shownState, sortedCards } from "../../../packages/shared/src/hub-agents.js";
import { agentDoing, AGENT_LABEL_LIMITS } from "../../../packages/shared/src/agent-label.js";
import { isSafeLink } from "../../../packages/shared/src/hub-protocol.js";
import { deviceIcon, h, L, when } from "./dom.js";
import { SNAPSHOT_SOURCE } from "./drive-view.js";
import { assignBox } from "./assign.js";
const STATE = {
    queued: { dot: "off", tag: "t-off", he: "בתור", en: "Queued" },
    running: { dot: "on", tag: "t-run", he: "רץ", en: "Running" },
    waiting: { dot: "ask", tag: "t-ask", he: "מחכה לך", en: "Waiting for you" },
    done: { dot: "on", tag: "t-ok", he: "✓ הסתיים", en: "✓ Done" },
    failed: { dot: "bad", tag: "t-bad", he: "✕ נכשל", en: "✕ Failed" },
    cancelled: { dot: "off", tag: "t-off", he: "נעצר", en: "Stopped" },
    stale: { dot: "busy", tag: "t-wait", he: "לא עונה", en: "Not answering" },
};
const SOURCE = {
    "chat-helper": { icon: "🤖", he: "סוכן עוזר בצ׳אט", en: "Chat helper" },
    inbox: { icon: "📥", he: "תיבת משימות", en: "Task inbox" },
    antigravity: { icon: "✦", he: "Antigravity", en: "Antigravity" },
    "claude-cloud": { icon: "✷", he: "Claude בענן", en: "Claude cloud" },
    "claude-chat": { icon: "💬", he: "צ׳אט Claude", en: "Claude chat" },
};
const OP = { read: ["קרא", "read"], edit: ["ערך", "edited"], create: ["יצר", "created"], delete: ["מחק", "deleted"] };
/** A duration as `m:ss` or `h:mm:ss`. */
export function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
/** A state tag (with a spinner while running). */
function stateTag(st) {
    const s = STATE[st];
    return h("span", { class: `tag ${s.tag}` }, st === "running" ? h("span", { class: "spin", "aria-hidden": "true" }) : null, L(s.he, s.en));
}
/** The inbox task behind a run (an Antigravity task of a PC's task inbox), when the page has it. */
export function taskOfRun(device, c) {
    return device.tasks.find((t) => t.inbox?.runId === c.runId && t.inbox.deviceId === c.deviceId);
}
/** How a run's task waits for the owner's Run (agents whose "Run this?" ask expired are not "not answering"). */
export function runWaitOf(device, c, now) {
    return runWait(c, taskOfRun(device, c), now);
}
/** The tag of a run that waits for Run. */
export const runWaitTag = () => h("span", { class: "tag t-ask" }, L("ממתין ל\"הפעל\"", "Waiting for Run"));
/**
 * "Ask again" (the PC asks "Run this task?" once more; nothing runs until Run is pressed there or here) and, after 7
 * days, "Cancel", for a run whose task waits for Run. Nothing is offered while no PC that has the task is on.
 *
 * @param device - The page's device.
 * @param c - The run.
 * @param w - From {@link runWaitOf}.
 * @returns The buttons, or null when there is nothing to offer.
 */
export function runWaitActions(device, c, w) {
    const t = taskOfRun(device, c);
    if (!t)
        return null;
    const sent = device.taskActions.get(t.taskId);
    if (device.runStarting(t))
        return h("span", { class: "tag t-run" }, L("מתחיל…", "Starting…"));
    if (sent && !sent.result)
        return h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…"));
    const note = sent?.result ? h("span", { class: `xs ${sent.result.ok ? "mut" : "warn"} wrapl`, dir: "auto" }, sent.result.text) : null;
    if (!device.canRun(t))
        return note;
    const ask = (e) => {
        e.stopPropagation();
        void device.inboxCommand(t, "inbox-ask");
    };
    const cancel = (e) => {
        e.stopPropagation();
        if (confirm(L(`לבטל את "${t.title}"?`, `Cancel "${t.title}"?`)))
            void device.inboxCommand(t, "inbox-cancel");
    };
    return h("span", { class: "row runacts" }, w.expired ? h("button", { type: "button", class: "btn sm-btn pri", onclick: ask }, L("↻ שאל שוב", "↻ Ask again")) : null, w.old ? h("button", { type: "button", class: "btn sm-btn", onclick: cancel }, L("בטל", "Cancel")) : null, note);
}
/** The short facts line of a run: step, elapsed, tokens, files. */
function facts(c, now) {
    const s = c.state;
    const end = s.endedAt ?? (isGoing(c) ? now : s.lastEventAt);
    return [
        s.of ? L(`צעד ${s.step}/${s.of}`, `step ${s.step}/${s.of}`) : s.step ? L(`צעד ${s.step}`, `step ${s.step}`) : "",
        s.startedAt ? `⏱ ${duration(end - s.startedAt)}` : "",
        s.tokensIn !== undefined ? L(`${tokens(s.tokensIn + (s.tokensOut ?? 0))} טוקנים`, `${tokens(s.tokensIn + (s.tokensOut ?? 0))} tokens`) : "",
        s.files ? L(`${s.files} קבצים`, `${s.files} files`) : "",
    ]
        .filter(Boolean)
        .join(" · ");
}
/** What a waiting run waits for, in words. */
function waitText(c) {
    const w = c.state.waiting;
    if (!w)
        return "";
    if (w.reason === "run-press")
        return L("מחכה ללחיצה על הרצה ב-Antigravity", "Waiting for Run in Antigravity");
    if (w.reason === "approval")
        return L(`מבקש אישור: ${w.summary}`, `Asks for approval: ${w.summary}`);
    return w.summary ? L(`שואל: ${w.summary}`, `Asks: ${w.summary}`) : L("מחכה לתשובה שלך", "Waiting for your answer");
}
/** The buttons of a run: answer what it waits for, or Stop. Disabled while its PC is off. */
function actions(v, c, pc) {
    const key = `${c.deviceId}/${c.runId}`;
    const sent = v.device.agentActions.get(key);
    if (sent === "allow" && c.state.state === "waiting" && c.state.waiting?.reason === "run-press")
        return h("span", { class: "tag t-run" }, L("מתחיל…", "Starting…"));
    if (sent)
        return h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…"));
    if (!isGoing(c))
        return null;
    const off = !pc?.online || !v.device.connected;
    const btn = (label, cls, run) => h("button", { type: "button", class: `btn sm-btn ${cls}`, disabled: off, onclick: (e) => { e.stopPropagation(); void run().then((ok) => !ok && v.render()); } }, label);
    const w = c.state.state === "waiting" ? c.state.waiting : undefined;
    const answer = w
        ? w.reason === "run-press"
            ? [btn(L("▶ הרץ", "▶ Run"), "pri", () => v.device.answerAgent(c, "allow")), btn(L("לא עכשיו", "Not now"), "", () => v.device.answerAgent(c, "deny"))]
            : w.reason === "ask"
                ? [btn(L("כן", "Yes"), "pri", () => v.device.answerAgent(c, "allow")), btn(L("לא", "No"), "", () => v.device.answerAgent(c, "deny"))]
                : [btn(L("✓ אשר", "✓ Approve"), "pri", () => v.device.answerAgent(c, "allow")), btn(L("דחה", "Deny"), "", () => v.device.answerAgent(c, "deny"))]
        : [];
    const stop = btn(L("■ עצור", "■ Stop"), "bad", async () => (confirm(L(`לעצור את "${c.state.name || c.state.title}"?`, `Stop "${c.state.name || c.state.title}"?`)) ? v.device.stopAgent(c) : true));
    return h("div", { class: "row wrap acts" }, ...answer, stop, off ? h("span", { class: "mut xs" }, L("המחשב כבוי", "The PC is off")) : null);
}
/** The run's own "doing now" line (a going run, from its latest tool and file), in words. */
function doingOf(c, st) {
    if (st !== "running")
        return undefined;
    return agentDoing({ state: "running", tool: c.state.label, target: c.state.fileNames.at(-1) });
}
/** "Now: …" as a line. */
const doingLine = (d) => h("div", { class: "sm wrapl adoing", dir: "auto" }, h("span", { class: "alab-k" }, L("עכשיו", "Now")), " ", L(d.he, d.en));
/** The owner's note as a line (wraps; never cut). */
const noteLine = (note) => h("div", { class: "sm wrapl anote", dir: "auto" }, h("span", { "aria-hidden": "true" }, "📝 "), note);
/** One card of the list. */
function card(v, c, now, pc) {
    const st = shownState(c, now);
    const src = SOURCE[c.state.source];
    const key = `${c.deviceId}/${c.runId}`;
    const { label } = v.device.shownLabel(c);
    const name = label.name || c.state.title;
    const doing = doingOf(c, st);
    const rw = runWaitOf(v.device, c, now);
    const line = rw?.expired ? L("הבקשה להפעיל פגה. אפשר לשאול שוב.", "The ask to run it expired. You can ask again.") : st === "waiting" ? waitText(c) : st === "stale" ? L(`אין דופק מ-${when(c.at)}`, `No heartbeat since ${when(c.at)}`) : (!isGoing(c) && c.state.summary) || "";
    return h("div", { class: `acard${st === "waiting" ? " wait" : ""}`, role: "button", tabindex: 0, "aria-label": name, onclick: () => v.setOpen(key), onkeydown: (e) => e.key === "Enter" && v.setOpen(key) }, h("div", { class: "row" }, h("span", { class: `dot ${STATE[st].dot}`, "aria-hidden": "true" }), h("b", { class: `grow ${label.name ? "min0 wrapl" : "ell1"}`, dir: "auto" }, name), rw ? runWaitTag() : stateTag(st)), label.name ? h("div", { class: "xs mut wrapl", dir: "auto" }, c.state.title) : null, h("div", { class: "row wrap mut sm" }, h("span", { title: L(src.he, src.en) }, `${src.icon} ${L(src.he, src.en)}`), c.state.model ? h("span", { class: "chip" }, c.state.model) : null, h("span", { class: "grow" }), h("span", { class: "mono xs" }, facts(c, now))), doing ? doingLine(doing) : null, line ? h("div", { class: `sm wrapl${st === "waiting" ? " warn" : ""}`, dir: "auto" }, line) : null, label.note ? noteLine(label.note) : null, st === "waiting" ? actions(v, c, pc) : null, rw ? runWaitActions(v.device, c, rw) : null);
}
/** The name-and-note form open on a run's detail (kept across redraws, so typing survives live updates). */
let edit;
/**
 * A run's name and note on its detail: the note, "✎ Name and note", and the form. Saving sends it to the run's PC
 * (disabled while that PC is off); the PC's "no" shows here in its words.
 */
function labelSection(v, c, pc) {
    const key = `${c.deviceId}/${c.runId}`;
    const shown = v.device.shownLabel(c);
    const off = !pc?.online || !v.device.connected;
    if (edit && edit.key !== key)
        edit = undefined;
    const status = shown.pending ? h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…")) : shown.error ? h("span", { class: "sm bad wrapl" }, L("המחשב לא שמר: ", "The PC did not save it: ") + shown.error) : null;
    if (!edit) {
        return h("section", { class: "card pad stack alabel" }, h("div", { class: "row wrap" }, h("b", { class: "grow" }, L("שם והערה", "Name and note")), status, h("button", { type: "button", class: "btn sm-btn", disabled: off, onclick: () => { edit = { key, name: shown.label.name ?? "", note: shown.label.note ?? "" }; v.render(); } }, shown.label.name || shown.label.note ? L("✎ ערוך", "✎ Edit") : L("✎ הוסף", "✎ Add"))), shown.label.note ? noteLine(shown.label.note) : h("span", { class: "sm mut" }, L("אין הערה. אפשר לתת לסוכן שם ולכתוב לעצמך מה הוא עושה.", "No note. You can name the agent and note for yourself what it does.")), off ? h("span", { class: "mut xs" }, L("המחשב כבוי: אפשר לערוך כשהוא מחובר.", "The PC is off: edit when it is on.")) : null);
    }
    const e = edit;
    const save = (name, note) => void v.device.labelAgent(c, { name, note }).then((ok) => {
        if (ok)
            edit = undefined;
        v.render();
    });
    return h("section", { class: "card pad stack alabel" }, h("b", null, L("שם והערה", "Name and note")), h("label", { class: "stack sm mut" }, L("שם לסוכן", "Agent name"), h("input", { class: "inp", dir: "auto", maxlength: AGENT_LABEL_LIMITS.nameChars, "aria-label": L("שם לסוכן", "Agent name"), placeholder: c.state.title, value: e.name, oninput: (ev) => { e.name = ev.target.value; } })), h("label", { class: "stack sm mut" }, L("הערה (רק בשבילך, לא נשלחת לסוכן)", "Note (just for you, not sent to the agent)"), h("textarea", { class: "inp area", rows: 3, dir: "auto", maxlength: AGENT_LABEL_LIMITS.noteChars, "aria-label": L("הערה לסוכן", "Agent note"), placeholder: L("למשל: בודק את הבאג של ההתחברות", "For example: checking the login bug"), value: e.note, oninput: (ev) => { e.note = ev.target.value; } })), h("div", { class: "row wrap" }, h("button", { type: "button", class: "btn pri", disabled: off, onclick: () => save(e.name, e.note) }, L("שמור במחשב", "Save on the PC")), h("button", { type: "button", class: "btn", onclick: () => { edit = undefined; v.render(); } }, L("ביטול", "Cancel")), h("span", { class: "grow" }), shown.label.name || shown.label.note ? h("button", { type: "button", class: "link sm", disabled: off, onclick: () => save("", "") }, L("נקה שם והערה", "Clear name and note")) : null), off ? h("span", { class: "mut xs" }, L("המחשב כבוי: אפשר לשמור כשהוא מחובר.", "The PC is off: save when it is on.")) : status);
}
/** Claude cloud runs this device started (from its own task list): the hub fired them, so only "started" is known. */
function cloudTasks(v, now) {
    return v.device.tasks.filter((t) => t.route === "claude-cloud" && t.status !== "outbox" && now - t.createdAt < 7 * 86_400_000);
}
function cloudCard(v, t) {
    const st = t.status === "done" ? "done" : t.status === "failed" || t.status === "blocked" ? "failed" : t.status === "cancelled" ? "cancelled" : undefined;
    return h("div", { class: "acard", role: "button", tabindex: 0, "aria-label": t.title, onclick: () => v.setOpen(`cloud:${t.taskId}`), onkeydown: (e) => e.key === "Enter" && v.setOpen(`cloud:${t.taskId}`) }, h("div", { class: "row" }, h("span", { class: `dot ${st ? STATE[st].dot : "busy"}`, "aria-hidden": "true" }), h("b", { class: "grow ell1" }, t.title), st ? stateTag(st) : h("span", { class: "tag t-off" }, L("מצב לא ידוע", "Status unknown"))), h("div", { class: "row wrap mut sm" }, h("span", null, `✷ ${L("Claude בענן", "Claude cloud")}`), h("span", { class: "grow" }), h("span", { class: "xs" }, L("התחיל ", "Started ") + when(t.createdAt))), h("div", { class: "row wrap" }, h("span", { class: "sm mut grow" }, L("רץ ב-Claude. פתחו כדי לצפות.", "Runs in Claude. Open it to watch.")), t.link && isSafeLink(t.link) ? h("a", { class: "btn sm-btn", href: t.link, target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, L("פתח ב-Claude ↗", "Open in Claude ↗")) : null));
}
/**
 * A run's last snapshot from Google Drive ("last seen" while the PC is off): read-only. A run that was still going
 * when its PC went off shows "Did not finish" and when it was last seen.
 */
function snapshotCard(a) {
    const b = a.body;
    const st = ["done", "failed", "cancelled"].find((x) => x === b.state);
    const src = SNAPSHOT_SOURCE[b.source];
    const span = b.startedAt && b.endedAt ? Date.parse(b.endedAt) - Date.parse(b.startedAt) : NaN;
    return h("div", { class: "acard snap" }, h("div", { class: "row" }, h("span", { class: `dot ${st ? STATE[st].dot : "off"}`, "aria-hidden": "true" }), h("b", { class: `grow ${b.name ? "min0 wrapl" : "ell1"}`, dir: "auto" }, b.name || b.title), st ? stateTag(st) : h("span", { class: "tag t-off" }, L("לא הסתיים", "Did not finish"))), b.name ? h("div", { class: "xs mut wrapl", dir: "auto" }, b.title) : null, h("div", { class: "row wrap mut sm" }, h("span", null, `${src.icon} ${L(src.he, src.en)}`), h("span", { class: "xs" }, `· ${L(a.device.he, a.device.en)}`), b.model ? h("span", { class: "xs ell1" }, `· ${b.model}`) : null, h("span", { class: "grow" }), h("span", { class: "mono xs" }, [b.steps ? L(`${b.steps} צעדים`, `${b.steps} steps`) : "", Number.isFinite(span) ? `⏱ ${duration(span)}` : "", b.endedAt ? when(b.endedAt) : b.updatedAt ? L("נראה לאחרונה ", "last seen ") + when(b.updatedAt) : ""].filter(Boolean).join(" · "))), b.summary ? h("div", { class: "sm wrapl", dir: "auto" }, b.summary) : null, b.note ? noteLine(b.note) : null);
}
/** A device's group header: name, on/off, last seen (the Claude chat, which only connects to report: its last report). */
function groupHead(name, icon, pc, count) {
    const on = pc?.online;
    if (pc?.kind === "claude-chat") {
        return h("div", { class: "row head wrap" }, h("span", { "aria-hidden": "true" }, icon), h("b", null, name), pc.lastSeen ? h("span", { class: "sm mut" }, L("דיווח אחרון ", "last report ") + when(pc.lastSeen)) : null, h("span", { class: "grow" }), h("span", { class: "tag t-off" }, String(count)));
    }
    return h("div", { class: "row head wrap" }, h("span", { "aria-hidden": "true" }, icon), h("b", null, name), pc ? h("span", { class: `dot ${on ? (pc.busy ? "busy" : "on") : "off"}`, "aria-hidden": "true" }) : null, pc ? h("span", { class: `sm ${on ? "ok" : "mut"}` }, on ? L("מחובר", "Online") : L("כבוי", "Off") + (pc.lastSeen ? L(" · נראה לאחרונה ", " · last seen ") + when(pc.lastSeen) : "")) : null, h("span", { class: "grow" }), h("span", { class: "tag t-off" }, String(count)));
}
/**
 * The agents list (HubAgents / PhoneHubAgents), or the open run's detail.
 *
 * @param v - The page's device, devices and open card.
 * @returns The tab's content.
 */
export function agentsTab(v) {
    const now = Date.now();
    const open = v.open;
    if (open?.startsWith("cloud:")) {
        const t = v.device.tasks.find((x) => x.taskId === open.slice(6));
        if (t)
            return cloudDetail(v, t);
    }
    else if (open) {
        const c = v.device.agents.get(open);
        if (c)
            return agentDetail(v, c, now);
    }
    const cards = sortedCards(v.device.agents.values(), now);
    const pcOf = (id) => v.devices().find((d) => d.id === id);
    const waiting = cards.filter((c) => c.state.state === "waiting");
    const rest = cards.filter((c) => c.state.state !== "waiting");
    const going = cards.filter(isGoing).length;
    const pcs = v.devices().filter((d) => d.kind === "pc");
    // The Claude chat's runs are one group, however many chats paired (each chat pairs once); newest report first.
    const chats = v.devices().filter((d) => d.kind === "claude-chat").sort((a, b) => Date.parse(b.lastSeen ?? "") - Date.parse(a.lastSeen ?? ""));
    // A run is the chat's by its device, or by its source while the device list has not caught up yet.
    const isChat = (c) => c.state.source === "claude-chat" || chats.some((d) => d.id === c.deviceId);
    const chatRuns = rest.filter(isChat);
    const ids = [...new Set([...pcs.map((d) => d.id), ...rest.filter((c) => !isChat(c)).map((c) => c.deviceId)])];
    const cloud = cloudTasks(v, now);
    const snaps = v.snapshots?.() ?? [];
    const empty = !cards.length && !cloud.length && !snaps.length;
    return h("main", { class: "page" }, h("div", { class: "row wrap" }, h("h1", null, L("סוכנים", "Agents")), h("span", { class: "mut" }, L(`· ${going} פעילים${waiting.length ? ` · ${waiting.length} מחכים לך` : ""}`, `· ${going} active${waiting.length ? ` · ${waiting.length} waiting for you` : ""}`)), h("span", { class: "grow" }), v.device.connected ? h("span", { class: "chip" }, h("span", { class: "dot on", "aria-hidden": "true" }), L(" חי", " Live")) : h("span", { class: "chip" }, h("span", { class: "dot off", "aria-hidden": "true" }), L(" לא מחובר", " Not connected"))), h("div", { class: "relay" }, "🔐 ", h("span", null, L("נעול במחשב: כותרות, צעדים ושמות כלים בלבד. בלי הנחיות, בלי תוכן קבצים ובלי תשובות. המרכז שומר 50 אירועים אחרונים לכל סוכן, 7 ימים.", "Sealed on the PC: titles, steps and tool names only. No prompts, file contents or answers. The hub keeps the last 50 events per agent, 7 days."))), waiting.length ? h("section", { class: "card clip pin" }, h("div", { class: "row head" }, h("b", null, L("⏳ מחכים לך", "⏳ Waiting for you")), h("span", { class: "grow" }), h("span", { class: "tag t-ask" }, String(waiting.length))), h("div", { class: "alist" }, waiting.map((c) => card(v, c, now, pcOf(c.deviceId))))) : null, ...ids.map((id) => {
        const pc = pcOf(id);
        const list = rest.filter((c) => c.deviceId === id);
        return h("section", { class: "card clip" }, groupHead(pc?.name ?? L("מחשב", "PC"), "🖥", pc, list.length), list.length ? h("div", { class: "alist" }, list.map((c) => card(v, c, now, pc))) : h("div", { class: "trow mut sm" }, pc && !pc.optIn.reportActivity ? L("המחשב הזה לא משתף פעילות סוכנים. במחשב: הגדרות › ענן Kesher › לשתף מה הסוכנים עושים.", "This PC does not share agent activity. On the PC: Settings › Kesher Cloud › Share what the agents do.") : L("אין סוכנים פעילים עכשיו.", "No agents running now.")));
    }), chats.length || chatRuns.length ? h("section", { class: "card clip" }, groupHead(L("צ׳אט Claude", "Claude chat"), deviceIcon("claude-chat"), chats[0], chatRuns.length), chatRuns.length ? h("div", { class: "alist" }, chatRuns.map((c) => card(v, c, now, pcOf(c.deviceId)))) : h("div", { class: "trow mut sm" }, L("הצ׳אט לא מריץ סוכנים עכשיו.", "The chat runs no agents now."))) : null, cloud.length ? h("section", { class: "card clip" }, groupHead(L("Claude בענן", "Claude cloud"), "✷", undefined, cloud.length), h("div", { class: "alist" }, cloud.map((t) => cloudCard(v, t)))) : null, snaps.length ? h("section", { class: "card clip drive-agents" }, h("div", { class: "row head wrap" }, h("span", { "aria-hidden": "true" }, "📁"), h("b", null, L("נראו לאחרונה", "Last seen")), h("span", { class: "sm mut" }, L("מ-Google Drive, כשהמחשב כבוי", "From Google Drive, while the PC is off")), h("span", { class: "grow" }), h("span", { class: "tag t-off" }, String(snaps.length))), h("div", { class: "alist" }, snaps.map(snapshotCard))) : null, empty && !pcs.length ? h("p", { class: "mut sm" }, L("עוד אין מחשבים מחוברים. לשונית חיבור ›", "No PCs are paired yet. Pair tab ›")) : null);
}
/** One timeline row. */
function eventRow(e) {
    const [icon, text] = (() => {
        switch (e.type) {
            case "started":
                return ["▶", L(`התחיל · ${SOURCE[e.source].he}${e.model ? ` · ${e.model}` : ""}`, `Started · ${SOURCE[e.source].en}${e.model ? ` · ${e.model}` : ""}`)];
            case "step":
                return ["•", L(`צעד ${e.n}${e.of ? `/${e.of}` : ""}${e.label ? ` · ${e.label}` : ""}`, `Step ${e.n}${e.of ? `/${e.of}` : ""}${e.label ? ` · ${e.label}` : ""}`)];
            case "tool":
                return [e.ok ? "🔧" : "⚠", `${e.name}${e.ms !== undefined ? ` · ${(e.ms / 1000).toFixed(1)}s` : ""}`];
            case "file":
                return ["📄", `${L(...(OP[e.op] ?? OP.read))} ${e.path}`];
            case "usage":
                return ["Σ", L(`${tokens(e.tokensIn)} נכנסו · ${tokens(e.tokensOut)} יצאו`, `${tokens(e.tokensIn)} in · ${tokens(e.tokensOut)} out`)];
            case "waiting":
                return ["⏳", e.reason === "run-press" ? L("מחכה להרצה", "Waiting for Run") : L(`מחכה: ${e.summary}`, `Waiting: ${e.summary}`)];
            case "done":
                return ["✓", L(`הסתיים · ${e.steps} צעדים${e.branch ? ` · ${e.branch}` : ""}`, `Done · ${e.steps} steps${e.branch ? ` · ${e.branch}` : ""}`)];
            case "failed":
                return ["✕", L(`נכשל${e.reason ? ` · ${e.reason}` : ""}`, `Failed${e.reason ? ` · ${e.reason}` : ""}`)];
            case "cancelled":
                return ["■", L("נעצר", "Stopped")];
        }
    })();
    return h("li", { class: `tl-${e.type}` }, h("span", { class: "tl-ic", "aria-hidden": "true" }, icon), h("span", { class: "grow min0 wrapl" }, text), h("span", { class: "mut xs mono" }, new Date(e.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
}
const back = (v) => h("button", { type: "button", class: "link back", onclick: () => v.setOpen(undefined) }, L("› כל הסוכנים", "‹ All agents"));
/** One run's detail (HubAgentDetail / PhoneHubAgentDetail). */
function agentDetail(v, c, now) {
    const st = shownState(c, now);
    const s = c.state;
    const pc = v.devices().find((d) => d.id === c.deviceId);
    const src = SOURCE[s.source];
    const fact = (he, en, value) => h("div", { class: "card stat" }, h("b", null, value), h("div", { class: "mut xs" }, L(he, en)));
    const end = s.endedAt ?? (isGoing(c) ? now : s.lastEventAt);
    const name = v.device.shownLabel(c).label.name;
    const doing = doingOf(c, st);
    const rw = runWaitOf(v.device, c, now);
    return h("main", { class: "page" }, back(v), h("div", { class: "row wrap" }, h("span", { class: `dot ${rw ? "ask" : STATE[st].dot}`, "aria-hidden": "true" }), h("h1", { class: "grow min0 wrapl", dir: "auto" }, name || s.title), rw ? runWaitTag() : stateTag(st)), name ? h("div", { class: "sm mut wrapl", dir: "auto" }, L("משימה: ", "Task: "), s.title) : null, h("div", { class: "row wrap mut sm" }, `${src.icon} ${L(src.he, src.en)}`, " · ", `${deviceIcon(pc?.kind)} ${pc?.name ?? L("מחשב", "PC")}`, s.model ? h("span", { class: "chip" }, s.model) : null, " · ", L("התחיל ", "started ") + when(s.startedAt)), st === "waiting" ? h("section", { class: "card pad stack pin" }, h("b", { class: "warn" }, waitText(c)), actions(v, c, pc)) : rw ? h("section", { class: "card pad stack pin" }, h("b", { class: "warn" }, rw.expired ? L("הבקשה להפעיל פגה. המשימה ממתינה ל\"הפעל\".", "The ask to run it expired. The task is waiting for Run.") : L("ממתין ל\"הפעל\"", "Waiting for Run")), runWaitActions(v.device, c, rw)) : st === "stale" ? h("div", { class: "note bad-note" }, s.source === "claude-chat" ? L(`הצ׳אט לא דיווח על הסוכן מאז ${when(c.at)}. ייתכן שהסתיים בלי דיווח.`, `The chat has not reported on this agent since ${when(c.at)}. It may have ended without a report.`) : L(`לא הגיע דופק מהסוכן מאז ${when(c.at)}. ייתכן שנתקע או שהמחשב נרדם.`, `No heartbeat from the agent since ${when(c.at)}. It may be stuck, or the PC is asleep.`)) : null, st !== "waiting" ? actions(v, c, pc) : null, h("div", { class: "grid4" }, fact("צעדים", "Steps", s.of ? `${s.step}/${s.of}` : String(s.step)), fact("זמן", "Elapsed", s.startedAt ? duration(end - s.startedAt) : "–"), fact("טוקנים", "Tokens", s.tokensIn !== undefined ? tokens(s.tokensIn + (s.tokensOut ?? 0)) : "–"), fact("קבצים", "Files", String(s.files))), doing ? doingLine(doing) : null, labelSection(v, c, pc), 
    // An inbox run is a task of its PC's inbox: it can be given to another executor ("Who does it").
    c.runId.startsWith("in-") ? h("section", { class: "card pad" }, assignBox({ device: v.device, render: v.render, taskId: c.runId.slice(3), pcs: pc?.online ? [pc] : [], current: c.state.source === "antigravity" ? "antigravity" : undefined })) : null, s.summary && !isGoing(c) ? h("section", { class: "card pad sm lines" }, s.summary) : null, s.fileNames.length ? h("section", { class: "sec" }, h("h3", { class: "sm" }, L(`קבצים שנגעו בהם (${s.files})`, `Files touched (${s.files})`)), h("ul", { class: "files" }, s.fileNames.map((f) => h("li", { class: "mono xs ell", dir: "ltr" }, f)))) : s.files ? h("div", { class: "mut sm" }, L(`נגע ב-${s.files} קבצים (השמות לא משותפים; במחשב: הגדרות › ענן Kesher).`, `Touched ${s.files} files (names are not shared; on the PC: Settings › Kesher Cloud).`)) : null, s.branch ? h("div", { class: "sm" }, L("ענף ", "Branch "), h("span", { class: "mono", dir: "ltr" }, s.branch)) : null, s.link && isSafeLink(s.link) ? h("a", { class: "btn", href: s.link, target: "_blank", rel: "noopener noreferrer" }, L("פתח ↗", "Open ↗")) : null, h("section", { class: "card clip" }, h("div", { class: "row head" }, h("b", null, L("ציר זמן", "Timeline")), h("span", { class: "grow" }), h("span", { class: "mut xs" }, L(`${c.events.length} אחרונים`, `last ${c.events.length}`))), c.events.length ? h("ul", { class: "tl" }, [...c.events].reverse().map(eventRow)) : h("div", { class: "trow mut sm" }, L("האירועים הקודמים כבר לא שמורים במרכז.", "Earlier events are no longer kept at the hub."))));
}
/** A Claude cloud run's detail: started, the link, and an honest "status unknown". */
function cloudDetail(v, t) {
    return h("main", { class: "page" }, back(v), h("div", { class: "row wrap" }, h("span", { "aria-hidden": "true" }, "✷"), h("h1", { class: "grow" }, t.title), h("span", { class: "tag t-off" }, L("מצב לא ידוע", "Status unknown"))), h("div", { class: "mut sm" }, L("התחיל ", "Started ") + when(t.createdAt), " · ", L("Claude בענן", "Claude cloud")), h("section", { class: "card pad stack" }, h("span", { class: "sm" }, L("המרכז רק הפעיל את המשימה ב-Claude. Claude לא מדווח מצב חי למרכז, אז את ההתקדמות רואים בשיחה עצמה.", "The hub only started the task in Claude. Claude does not report live status to the hub, so the progress is seen in the session itself.")), t.link && isSafeLink(t.link) ? h("a", { class: "btn pri", href: t.link, target: "_blank", rel: "noopener noreferrer" }, L("פתח ב-Claude ↗", "Open in Claude ↗")) : h("span", { class: "mut sm" }, L("אין קישור לשיחה.", "No session link."))), h("div", { class: "pl" }, t.history.map((x) => `${when(x.t)} ${L(x.he, x.en)}`).join(" · ")));
}
/**
 * A short "agents now" block for the dashboard: what waits, then what runs (at most 3).
 *
 * @param v - The view.
 * @returns The block, or null when nothing is going.
 */
export function agentsSummary(v) {
    const now = Date.now();
    const going = sortedCards(v.device.agents.values(), now).filter(isGoing);
    if (!going.length)
        return null;
    return h("section", { class: "card clip" }, h("div", { class: "row head" }, h("b", null, L("סוכנים עכשיו", "Agents now")), h("span", { class: "tag t-run" }, String(going.length)), h("span", { class: "grow" }), h("a", { class: "mut sm", href: "#agents" }, L("הכול ›", "All ›"))), going.slice(0, 3).map((c) => {
        const st = shownState(c, now);
        const rw = runWaitOf(v.device, c, now);
        return h("a", { class: "trow sm", href: "#agents", onclick: () => v.setOpen(`${c.deviceId}/${c.runId}`) }, h("span", { class: `dot ${rw ? "ask" : STATE[st].dot}`, "aria-hidden": "true" }), h("span", { class: "grow ell", dir: "auto" }, v.device.shownLabel(c).label.name || c.state.title), rw ? runWaitTag() : stateTag(st));
    }));
}
