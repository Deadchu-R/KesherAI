import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Where "free the graphics card while the game plays" stands (the server's `standby` in `/api/guard`). */
export interface Standby {
  /** `waiting`: a turn still runs, the models unload right after; `paused`: unloaded, new local work waits. */
  state: "waiting" | "paused";
  editors: Array<"unreal" | "unity">;
  freed: string[];
}

let current: Standby | undefined;
const listeners = new Set<(s: Standby | undefined) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Reads the state; one poll for every screen that shows it (the phone asks the PC the same way). */
function poll(): void {
  void api<{ standby?: Standby }>("/api/guard").then((g) => {
    current = g.standby;
    for (const fn of listeners) fn(current);
  }, () => undefined);
}

/**
 * Whether the models are away because a game plays in Unity or Unreal. Polls every 4 seconds while any screen uses it.
 *
 * @returns The state, or undefined when nothing is paused.
 */
export function useStandby(): Standby | undefined {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    if (!timer) {
      poll();
      timer = setInterval(poll, 4000);
    }
    return () => {
      listeners.delete(setS);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return s;
}

/** @returns "Unreal", "Unity" or "Unreal and Unity" for the editors in Play. */
const editorsText = (s: Standby) => (s.editors.length > 1 ? L("Unreal ו-Unity", "Unreal and Unity") : s.editors[0] === "unity" ? "Unity" : "Unreal");

/**
 * The one-line note for the Models page and the model chip's tooltip.
 *
 * @param s - The state.
 * @returns For example "Paused for Play in Unreal — reloads after".
 */
export function standbyText(s: Standby): string {
  const where = editorsText(s);
  return s.state === "paused"
    ? L(`מושהה בזמן Play ב-${where} — ייטען חזרה אחרי`, `Paused for Play in ${where} — reloads after`)
    : L(`Play ב-${where}: המודל ישוחרר מיד כשהתשובה תסתיים`, `Play in ${where}: the model is freed as soon as the answer ends`);
}

/** The line a waiting turn shows in the chat while the models are away. */
export const loadingBackText = (): string => L("טוען את המודל בחזרה…", "Loading the model back…");
