import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Why the chat model was loaded (the server's LoadReason in llamacpp.ts). */
export interface LoadReason {
  kind: "chosen" | "chat" | "request" | "startup" | "settings" | "update" | "calibration" | "setup" | "benchmark";
  chats?: string[];
  at?: number;
}

/**
 * Says why the loaded model was loaded and how long ago, in the interface's language: shown beside it (the Models page,
 * the computer's details), so a load nobody expected has a name (Roee, 2026-11-18: "loaded again in the background").
 *
 * @param r - The engine's `loadedFor`.
 * @param now - The time now (ms), for "minutes ago".
 * @returns One short line, or "" when there is no reason.
 */
export function loadReasonText(r: LoadReason | undefined, now = Date.now()): string {
  if (!r) return "";
  const why: Record<LoadReason["kind"], string> = {
    chosen: L("נבחר בדף המודלים או דרך ה-API", "chosen on the Models page or through the API"),
    chat: r.chats?.length ? L(`צ׳אט ביקש אותו: "${r.chats.join('", "')}"`, `a chat needed it: "${r.chats.join('", "')}"`) : L("צ׳אט ביקש אותו", "a chat needed it"),
    request: L("בקשה ברקע (כותרת, דוח, צינור או הטלפון)", "a request in the background (a title, a report, a pipeline or the phone)"),
    startup: L("המודל האחרון, בהפעלה", "the last model, at start-up"),
    settings: L("טעינה מחדש אחרי שינוי הגדרות", "reloaded after a settings change"),
    update: L("חזר אחרי עדכון", "back after an update"),
    calibration: L("חזר אחרי כיול", "back after calibration"),
    setup: L("ההגדרה הראשונה", "first-run setup"),
    benchmark: L("בדיקת מהירות", "a speed test"),
  };
  const mins = r.at ? Math.max(0, Math.round((now - r.at) / 60_000)) : undefined;
  const ago = mins === undefined ? "" : mins < 1 ? L(" · עכשיו", " · just now") : mins < 60 ? L(` · לפני ${mins} דק׳`, ` · ${mins} min ago`) : L(` · לפני ${Math.round(mins / 60)} שע׳`, ` · ${Math.round(mins / 60)} h ago`);
  return `${L("נטען כי: ", "Loaded because: ")}${why[r.kind] ?? r.kind}${ago}`;
}
