/**
 * A Run button with a 5-second undo, for the PC's task inbox page: a tap sends nothing; the button turns into
 * "Starting in 5… Undo" (the same size, so the card does not move under the finger) and the command is sent only
 * when the 5 seconds end (Undo cancels it). The count is `RunUndo` (packages/shared/src/run-undo.ts, shared with the
 * hub page); the windows live at module level so the page's 3-second reload does not lose them.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { RunUndo } from "@kesher/shared";
import { getLocale, he$ } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

const undo = new RunUndo();
const sends = new Map<string, () => void>();
const subs = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Sends what is due, tells the buttons to redraw, and ticks every 250 ms only while a window is open. */
function pump(): void {
  for (const k of undo.due(Date.now())) {
    const send = sends.get(k);
    sends.delete(k);
    send?.();
  }
  version++;
  for (const f of subs) f();
  if (undo.active && timer === undefined) timer = setInterval(pump, 250);
  else if (!undo.active && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** The seconds "Starting in N…" shows for a key, or undefined when no window is open (reads the live count). */
export function runCountdown(key: string): number | undefined {
  return undo.left(key, Date.now());
}

/**
 * @param id - The window's key (a task id, an ask's request id, or `RUN_ALL_KEY`).
 * @param label - The button's words (e.g. "▶ Run").
 * @param send - Sends the command once, after the 5 seconds.
 * @param o - `disabled`: the page is busy; `primary`: the main button style.
 */
export function RunUndoButton({ id, label, send, disabled, primary = true }: { id: string; label: ReactNode; send: () => void; disabled?: boolean; primary?: boolean }) {
  useSyncExternalStore(subscribe, () => version);
  const left = undo.left(id, Date.now());
  if (left === undefined) {
    return (
      <button type="button" className={`${primary ? "primary " : ""}tinbox-runbtn`} disabled={disabled} onClick={() => { if (undo.left(id, Date.now()) === undefined) sends.set(id, send); undo.arm(id, Date.now()); pump(); }}>
        {label}
      </button>
    );
  }
  return (
    <span className="row tinbox-runcount" role="status" aria-live="polite">
      <span className="chip tinbox-runbtn">{L(`מתחיל בעוד ${left}…`, `Starting in ${left}…`)}</span>
      <button type="button" className="tinbox-runbtn" onClick={() => { undo.cancel(id); sends.delete(id); pump(); }}>{L("בטל", "Undo")}</button>
    </span>
  );
}
