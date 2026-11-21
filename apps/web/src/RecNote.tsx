import { getLocale, he$ } from "./i18n";
import type { LongStatus } from "./long-recorder";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * One line under a long recording that says what happens to it: in the phone app it goes on in the background (the
 * notification), why it is paused when the system paused it, and that a stopped one is kept and can go on.
 * Shared by Open mind and the lecture recorder.
 *
 * @param props.status - The recorder's status (useLongRecorder).
 * @param props.native - Whether the phone app records it natively.
 */
export function RecNote({ status, native }: { status: LongStatus; native: boolean }) {
  const text =
    status === "silenced" ? L("⏸ מושהה: אפליקציה אחרת משתמשת במיקרופון. ההקלטה תמשיך לבד כשהוא יתפנה, והפער יסומן.", "⏸ Paused: another app is using the microphone. The recording goes on by itself when it is free, and the gap is marked.")
    : status === "interrupted" ? L("ההקלטה נעצרה (האפליקציה נסגרה או שהמערכת עצרה אותה). כל מה שהוקלט עד אז שמור: אפשר להמשיך לאותה הקלטה או לסיים.", "The recording stopped (the app was closed or the system stopped it). Everything up to then is kept: go on into the same recording, or finish.")
    : status === "recording" && native ? L("ממשיך להקליט גם כשהמסך כבוי או באפליקציה אחרת. השהיה ועצירה גם מההתראה.", "Keeps recording with the screen off or in another app. Pause and stop from the notification too.")
    : status === "recording" ? L("נשמר כל 5 שניות, כך שיציאה מהדף או קריסה לא מאבדות את ההקלטה.", "Saved every 5 seconds, so leaving the page or a crash does not lose the recording.")
    : "";
  return text ? <p className={`rec-note small ${status === "silenced" || status === "interrupted" ? "warn" : "muted"}`} role="status" dir="auto">{text}</p> : null;
}
