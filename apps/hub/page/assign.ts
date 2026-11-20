/**
 * "Who does it" on the hub page and the phone's Cloud tab (Roee, 2026-11-20; boards HubAssign, PhoneHubAssign): a
 * button that opens the list of executors for an inbox task, a Drive task, a work-list item or an inbox run's agent
 * card. With several PCs on, a work-list item first gets which PC takes it. The choice goes to the PC as a sealed
 * `assign` command (device.ts); the PC is the source of truth and answers done, why not, or a question before it
 * stops a running task or runs a finished one again (shown here with Yes / No, never decided for the user).
 */
import { ASSIGN_CHOICES, assignQuestion, type AssignTo } from "../../../packages/shared/src/task-assign.js";
import type { HubPresence } from "../../../packages/shared/src/hub-protocol.js";
import { h, L } from "./dom.js";
import type { HubDevice } from "./device.js";

/** The open picker (one at a time) and the PC chosen for it, kept across redraws. */
let open: { key: string; pc?: string } | undefined;

/** What a picker needs. */
export interface AssignBoxOptions {
  device: HubDevice;
  render: () => void;
  /** The id sent to the PC (an inbox task, its Drive record, a work-list item's record). */
  taskId: string;
  /** The PCs that may have it (one: it goes there; several for a work-list item: the user picks one). */
  pcs: HubPresence[];
  /** Pick one PC of `pcs` (a work-list item) instead of sending to all (a Drive task: only its PC acts). */
  onePc?: boolean;
  /** Who has it now. */
  current?: AssignTo;
  /** The button's words (default "Who does it"). */
  label?: { he: string; en: string };
}

/**
 * The picker: the button, the open list, the PC's answer or question.
 *
 * @param o - The task, its PCs and the page.
 * @returns The element.
 */
export function assignBox(o: AssignBoxOptions): HTMLElement {
  const { device, render, taskId } = o;
  const key = taskId;
  const sent = device.assignActions.get(taskId);
  const isOpen = open?.key === key;
  const stop = (e: Event) => e.stopPropagation();
  const pcs = o.onePc && o.pcs.length > 1 ? o.pcs.filter((p) => p.id === (open?.pc ?? o.pcs[0]!.id)) : o.pcs;
  const off = !device.connected || !o.pcs.length;
  const send = (to: AssignTo, confirm = false) => void device.assign(taskId, confirm && sent ? o.pcs.filter((p) => sent.pcs.includes(p.id)) : pcs, to, confirm).then(() => { open = undefined; render(); });
  const answer: HTMLElement | null = !sent
    ? null
    : !sent.result
      ? h("span", { class: "tag t-run" }, L("נשלח למחשב…", "Sent to the PC…"))
      : sent.result.ask
        ? (() => {
            const q = assignQuestion(sent.result.ask, sent.to);
            return h(
              "div",
              { class: "stack assign-ask", onclick: stop },
              h("span", { class: "sm warn wrapl", dir: "auto" }, L(q.he, q.en)),
              h("div", { class: "row wrap" }, h("button", { type: "button", class: "btn sm-btn pri", disabled: off, onclick: () => send(sent.to, true) }, L("כן", "Yes")), h("button", { type: "button", class: "btn sm-btn", onclick: () => { device.assignActions.delete(taskId); render(); } }, L("לא", "No"))),
            );
          })()
        : h("span", { class: `xs ${sent.result.ok ? "mut" : "warn"} wrapl`, dir: "auto" }, sent.result.text);
  return h(
    "div",
    { class: "stack assign", onclick: stop },
    h("div", { class: "row wrap" }, h("button", { type: "button", class: "btn sm-btn", "aria-expanded": String(isOpen), disabled: off, onclick: () => { open = isOpen ? undefined : { key }; render(); } }, `👤 ${o.label ? L(o.label.he, o.label.en) : L("מי עושה", "Who does it")} ▾`), off ? h("span", { class: "mut xs" }, L("המחשב כבוי", "The PC is off")) : null),
    isOpen && o.onePc && o.pcs.length > 1
      ? h(
          "div",
          { class: "row wrap", role: "group", "aria-label": L("איזה מחשב", "Which PC") },
          h("span", { class: "sm mut" }, L("במחשב:", "On:")),
          o.pcs.map((p) => {
            const on = (open?.pc ?? o.pcs[0]!.id) === p.id;
            return h("button", { type: "button", class: `chip${on ? " chip-on" : ""}`, "aria-pressed": String(on), onclick: () => { open = { key, pc: p.id }; render(); } }, `🖥 ${p.name}`);
          }),
        )
      : null,
    isOpen
      ? h(
          "div",
          { class: "assign-list", role: "group", "aria-label": L("למי לתת את המשימה", "Who to give the task to") },
          ASSIGN_CHOICES.map((c) =>
            h(
              "button",
              { type: "button", class: `trow assign-opt${c.to === o.current ? " sel" : ""}`, "aria-pressed": String(c.to === o.current), onclick: () => send(c.to) },
              h("span", { "aria-hidden": "true" }, c.icon),
              h("span", { class: "grow min0" }, h("b", { class: "wrapl" }, L(c.he, c.en)), h("span", { class: "xs mut wrapl" }, c.to === o.current ? L("אצלו עכשיו", "Has it now") : L(c.noteHe, c.noteEn))),
            ),
          ),
        )
      : null,
    answer,
  );
}
