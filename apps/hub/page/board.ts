/**
 * "Shared board" on the hub page's Tasks tab, under "Computer" (the design doc's HubBoard / PhoneHubBoard scenario):
 * the task board Claude and KesherAI's self-work share, as the PC reports it (a sealed snapshot of metadata, never the
 * tasks' details). Filters (Open / Waiting on me / Done), owner chips (Claude / KesherAI / Roee), size and priority,
 * the result line of done items, and the board's own actions: reopen, a higher priority, hand to the local model, a
 * note. Each action is a sealed command the PC applies through the board's own rules; nothing is stored here.
 */
import { boardView, boardWaitsOnMe, boardWho, type HubBoardCommand, type HubBoardItem, type HubBoardWho, type HubPresence } from "../../../packages/shared/src/hub-protocol.js";
import { h, L, when } from "./dom.js";
import type { HubDevice } from "./device.js";

/** What the section needs from the page. */
export interface BoardView {
  device: HubDevice;
  render: () => void;
}

type Filter = "open" | "me" | "done";

const WHO: Record<HubBoardWho, [string, string]> = { claude: ["Claude", "Claude"], kesher: ["KesherAI", "KesherAI"], roee: ["אתה", "You"] };
const STATUS: Record<HubBoardItem["status"], [string, string, string]> = {
  claimed: ["בעבודה", "In progress", "t-run"],
  open: ["פתוחה", "Open", "t-off"],
  blocked: ["תקועה", "Blocked", "t-ask"],
  done: ["הושלמה", "Done", "t-ok"],
};

/** The page's choices here (in memory): the filter, an owner chip, the open rows, note drafts and "show all". */
const state = { filter: "open" as Filter, who: undefined as HubBoardWho | undefined, open: new Set<string>(), drafts: new Map<string, string>(), all: false };

/** Rows shown before "Show all" (a phone's screen is short). */
const FIRST = 25;
/** How long a PC's answer stays on its row (ms). */
const ANSWER_MS = 8000;

/**
 * The "Shared board" group of the Tasks tab, or a short hint when an online PC has not reported its board yet (an
 * older KesherAI), or nothing when there is no PC.
 *
 * @param v - The page's parts.
 * @param q - The search text (lower case), shared with the task list.
 * @returns The group.
 */
export function boardGroup(v: BoardView, q: string): HTMLElement | null {
  const d = v.device;
  const pcs = d.presence.filter((p) => p.kind === "pc");
  const reported = pcs.filter((p) => d.boards.has(p.id));
  if (!reported.length) {
    if (!d.paired || !pcs.some((p) => p.online)) return null;
    return h("section", { class: "card clip sboard", "aria-label": L("הלוח המשותף", "Shared board") }, h("div", { class: "row head" }, h("b", null, L("🖥 מחשב · לוח משותף", "🖥 Computer · Shared board"))), h("div", { class: "trow mut sm" }, L("המחשב עוד לא שלח את הלוח. עדכנו את KesherAI במחשב ודאו שהוא פתוח.", "The PC has not sent its board yet. Update KesherAI on the PC and keep it open.")));
  }
  return h("section", { class: "card clip sboard", "aria-label": L("הלוח המשותף", "Shared board") }, ...reported.map((pc, n) => pcBoard(v, pc, q, n === 0 && reported.length === 1)));
}

/** One PC's board: header, filters, owner chips and rows. */
function pcBoard(v: BoardView, pc: HubPresence, q: string, single: boolean): HTMLElement {
  const snap = v.device.boards.get(pc.id)!;
  const count = (f: Filter) => boardView(snap.items, f, state.who).length;
  const chip = (f: Filter, he: string, en: string, n: number) =>
    h("button", { type: "button", class: `chip${state.filter === f ? " chip-on" : ""}`, "aria-pressed": String(state.filter === f), onclick: () => { state.filter = f; state.all = false; v.render(); } }, `${L(he, en)} ${n}`);
  const whoChip = (w: HubBoardWho) => {
    const n = boardView(snap.items, state.filter).filter((i) => boardWho(i) === w).length;
    return h("button", { type: "button", class: `chip${state.who === w ? " chip-on" : ""}`, "aria-pressed": String(state.who === w), onclick: () => { state.who = state.who === w ? undefined : w; state.all = false; v.render(); } }, `${L(...WHO[w])} ${n}`);
  };
  const rows = boardView(snap.items, state.filter, state.who).filter((i) => !q || `${i.title} ${i.id}`.toLowerCase().includes(q));
  const shown = state.all ? rows : rows.slice(0, FIRST);
  return h(
    "div",
    { class: "sb-pc" },
    h("div", { class: "row wrap head" }, h("b", null, L("🖥 מחשב · לוח משותף", "🖥 Computer · Shared board")), h("span", { class: "mut xs" }, single ? pc.name : `🖥 ${pc.name}`), pc.online ? null : h("span", { class: "tag t-off" }, L("המחשב כבוי · הלוח כפי שהיה", "PC off · the board as it was")), h("span", { class: "grow" }), h("span", { class: "mut xs" }, when(snap.at))),
    h("div", { class: "row wrap filters sb-filters", role: "group", "aria-label": L("סינון", "Filter") }, chip("open", "פתוחות", "Open", count("open")), chip("me", "מחכות לי", "Waiting on me", count("me")), chip("done", "הושלמו", "Done", state.who ? count("done") : Math.max(snap.doneTotal, count("done")))),
    h("div", { class: "row wrap filters sb-filters", role: "group", "aria-label": L("מי עובד על זה", "Owner") }, (["claude", "kesher", "roee"] as const).map(whoChip)),
    shown.length ? shown.map((i) => row(v, pc, i)) : h("div", { class: "trow mut sm" }, L("אין משימות כאלה.", "No such tasks.")),
    rows.length > shown.length ? h("div", { class: "trow" }, h("button", { type: "button", class: "btn sm-btn", onclick: () => { state.all = true; v.render(); } }, L(`הצג הכול (${rows.length})`, `Show all (${rows.length})`))) : null,
    state.filter === "done" && snap.doneTotal > snap.items.filter((i) => i.status === "done").length ? h("div", { class: "trow mut xs" }, L(`מוצגות ${snap.items.filter((i) => i.status === "done").length} האחרונות מתוך ${snap.doneTotal}.`, `The last ${snap.items.filter((i) => i.status === "done").length} of ${snap.doneTotal} are shown.`)) : null,
  );
}

/** One task: a row (status, title, owner, size, priority, the result of a done one) that opens its actions. */
function row(v: BoardView, pc: HubPresence, i: HubBoardItem): HTMLElement {
  const key = `${pc.id}/${i.id}`;
  const open = state.open.has(key);
  const st = STATUS[i.status];
  const who = boardWho(i);
  const size = i.fable ? "Fable" : i.size === "small" ? L("קטנה", "Small") : L("גדולה", "Big");
  return h(
    "div",
    { class: `sb-item ${i.status}` },
    h(
      "button",
      { type: "button", class: "trow sb-row", "aria-expanded": String(open), onclick: () => { if (open) state.open.delete(key); else state.open.add(key); v.render(); } },
      h("span", { class: `tag ${st[2]}` }, L(st[0], st[1])),
      h(
        "span",
        { class: "grow min0" },
        h("span", { class: "sb-title", dir: "auto" }, i.title),
        h("span", { class: "row wrap mut xs sb-meta" }, h("span", { class: "mono" }, i.id), h("span", null, L(...WHO[who])), h("span", null, size), i.status !== "done" ? h("span", null, `p${i.priority}`) : null, i.forKesher && i.status !== "done" ? h("span", { class: "tag t-run" }, L("🤖 למודל המקומי", "🤖 Local model")) : null, boardWaitsOnMe(i) ? h("span", { class: "tag t-ask" }, L("מחכה לך", "Waits on you")) : null, h("span", null, when(i.at))),
        i.status === "done" && i.result ? h("span", { class: "sb-result sm", dir: "auto" }, i.result) : null,
      ),
      h("span", { class: "mut xs", "aria-hidden": "true" }, open ? "▴" : "▾"),
    ),
    open ? actions(v, pc, i, key) : null,
  );
}

/** The actions of an open task, and the PC's answer to the last one. */
function actions(v: BoardView, pc: HubPresence, i: HubBoardItem, key: string): HTMLElement {
  const d = v.device;
  const off = !d.connected || !pc.online;
  const sent = d.boardActions.get(key);
  const answer = sent?.result && Date.now() - sent.result.at < ANSWER_MS ? sent.result : undefined;
  const send = (cmd: HubBoardCommand) => void d.boardCommand(pc, i.id, cmd).then((ok) => !ok && v.render());
  const btn = (label: string, run: () => void, title?: string, pressed?: boolean) => h("button", { type: "button", class: "btn sm-btn", disabled: off, title, "aria-pressed": pressed === undefined ? undefined : String(pressed), onclick: run }, label);
  const draft = state.drafts.get(key) ?? "";
  const label = `${L("הערה", "Note")} ${i.id}`;
  const submit = () => {
    const text = draft.trim();
    if (!text || off) return;
    state.drafts.delete(key);
    send({ op: "note", text });
  };
  return h(
    "div",
    { class: "sb-body" },
    h("div", { class: "row wrap acts" },
      i.status !== "open" ? btn(L("החזר לפתוחה", "Reopen"), () => send({ op: "reopen" })) : null,
      i.status !== "done" ? btn(`↑ p${i.priority}`, () => send({ op: "raise" }), L("עדיפות גבוהה יותר", "Higher priority")) : null,
      i.status !== "done" ? btn(i.forKesher ? L("בטל: לא למודל המקומי", "Undo: not for the local model") : L("🤖 תן למודל המקומי", "🤖 Give to the local model"), () => send({ op: "for-kesher", on: !i.forKesher }), L("העבודה העצמית תיקח אותה ראשונה, בלי קשר לגודל", "Self-work takes it first, whatever its size"), !!i.forKesher) : null,
    ),
    h(
      "form",
      { class: "row sb-note", onsubmit: (e: Event) => { e.preventDefault(); submit(); } },
      h("input", { class: "inp grow", type: "text", dir: "auto", maxlength: "1000", "aria-label": label, placeholder: L("הערה ללוח…", "A note on the board…"), value: draft, oninput: (e: Event) => state.drafts.set(key, (e.target as HTMLInputElement).value) }),
      h("button", { type: "submit", class: "btn sm-btn pri", disabled: off }, L("שלח", "Send")),
    ),
    sent && !sent.result ? h("div", { class: "mut xs", role: "status" }, L("נשלח למחשב…", "Sent to the PC…")) : null,
    answer ? h("div", { class: `xs ${answer.ok ? "ok" : "warn"}`, role: "status", dir: "auto" }, answer.text) : null,
    off ? h("div", { class: "mut xs" }, L("המחשב כבוי: אפשר לשנות רק כשהוא פועל.", "The PC is off: changes work only while it is on.")) : null,
  );
}
