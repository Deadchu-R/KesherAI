/**
 * The Run button with a 5-second undo, for the hub page: a tap does not send anything; the button turns into
 * "Starting in 5… Undo" (same size, so the card does not move under the finger) and the command is sent only when the
 * 5 seconds end. Undo cancels it. The count itself is `RunUndo` (packages/shared/src/run-undo.ts), kept by the device.
 */
import { RUN_ALL_KEY } from "../../../packages/shared/src/run-undo.js";
import { h, L } from "./dom.js";
import type { HubDevice } from "./device.js";

/**
 * A Run-like button (Run, Start, Run all) with the undo window.
 *
 * @param device - The page's device (it keeps the windows and redraws).
 * @param key - The window's key: a task id, an approval's request id, or {@link RUN_ALL_KEY}.
 * @param label - The button's words (e.g. "▶ Run").
 * @param send - Sends the command after the window (once).
 * @param o - `cls`: the button's extra classes; `off`: disabled.
 */
export function runWithUndo(device: HubDevice, key: string, label: string, send: () => void, o: { cls?: string; off?: boolean } = {}): HTMLElement {
  const left = device.runCountdown(key);
  if (left === undefined) {
    return h("button", { type: "button", class: `btn sm-btn ${o.cls ?? "pri"} runbtn`, disabled: o.off, onclick: (e: Event) => { e.stopPropagation(); device.armRun(key, send); } }, label);
  }
  return h(
    "span",
    { class: "row runcount", role: "status", "aria-live": "polite" },
    h("span", { class: "tag t-run runbtn" }, L(`מתחיל בעוד ${left}…`, `Starting in ${left}…`)),
    h("button", { type: "button", class: "btn sm-btn runbtn", onclick: (e: Event) => { e.stopPropagation(); device.undoRun(key); } }, L("בטל", "Undo")),
  );
}

/**
 * "Run all (N)" for the tasks that wait for Run (shown from two tasks up): one button with the same undo window.
 *
 * @param device - The page's device.
 * @returns The button, or null when fewer than two tasks wait (and no window is open).
 */
export function runAllButton(device: HubDevice): HTMLElement | null {
  const n = device.runnableTasks().length;
  if (n < 2 && device.runCountdown(RUN_ALL_KEY) === undefined) return null;
  return runWithUndo(device, RUN_ALL_KEY, L(`▶ הפעל הכל (${n})`, `▶ Run all (${n})`), () => void device.runAll(), { off: !device.connected });
}
