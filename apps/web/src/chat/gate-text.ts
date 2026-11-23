/**
 * The safety gates' words in the user's language. The server (agent/permissions.ts, agent/session.ts and
 * core/control-gate.ts) writes its gate decisions in English; these turn the known sentences into Hebrew, and leave
 * anything they do not know as it came. Pure, so the phone and the computer show the same text.
 */

/** Picks the Hebrew or the English text (the caller's `L`). */
export type Pick = (he: string, en: string) => string;

/** The always-ask reasons from agent/permissions.ts (`DANGEROUS` and the delete check), in Hebrew. */
const DANGER_HE: Record<string, string> = {
  "deletes files recursively or forcefully": "מוחקת קבצים בכוח או עם כל התיקיות שבתוכן",
  "deletes a folder tree": "מוחקת תיקייה עם כל מה שבתוכה",
  "deletes files in bulk": "מוחקת הרבה קבצים בבת אחת",
  "can erase a disk": "יכולה למחוק כונן שלם",
  "rewrites or publishes git history": "משכתבת או מפרסמת היסטוריה של git",
  "publishes a package": "מפרסמת חבילה",
  "runs code downloaded from the internet": "מריצה קוד שהורד מהאינטרנט",
  "runs with administrator rights": "רצה עם הרשאות מנהל",
  "shuts the computer down": "מכבה את המחשב",
  "changes the Windows registry": "משנה את הרישום של Windows",
  "opens file permissions to everyone": "פותחת את הרשאות הקבצים לכולם",
  "writes directly to a disk": "כותבת ישר לכונן",
  "installs or removes programs on the computer": "מתקינה או מסירה תוכנות במחשב",
  "installs or changes programs on the computer": "מתקינה או משנה תוכנות במחשב",
  "installs programs or modules on the computer": "מתקינה תוכנות או מודולים במחשב",
  "turns off a security protection": "מכבה הגנת אבטחה",
  "sends or publishes something in your name": "שולחת או מפרסמת משהו בשמך",
  "throws away work that git cannot bring back": "זורקת עבודה ש-git לא יוכל להחזיר",
  "deletes files outside the project folder": "מוחקת קבצים מחוץ לתיקיית הפרויקט",
};

/**
 * Why a command is on the always-ask list, in the user's language.
 *
 * @param what - The English reason ("deletes files outside the project folder").
 * @param L - Picks Hebrew or English.
 */
export function dangerWhat(what: string, L: Pick): string {
  const he = DANGER_HE[what];
  return he ? L(he, what) : what;
}

/** The suffix agent/session.ts adds to a question when the command reviewer did not approve it. */
const LEFT_TO_YOU = / The reviewer left it to you: ([\s\S]*)$/;

/**
 * Splits off the command reviewer's "left it to you" note from an approval reason.
 *
 * @param reason - The server's reason.
 * @returns The reason without the note, and the reviewer's own words ("" when there is no note).
 */
export function splitReview(reason: string): { base: string; review: string } {
  const m = LEFT_TO_YOU.exec(reason);
  return m ? { base: reason.slice(0, m.index), review: m[1]!.replace(/\.$/, "") } : { base: reason, review: "" };
}

/**
 * The line under a question when the reviewer held the step for the user.
 *
 * @param review - The reviewer's words.
 * @param L - Picks Hebrew or English.
 */
export function reviewHeldText(review: string, L: Pick): string {
  return `${L("הבודק השאיר לך את ההחלטה", "The reviewer left it to you")}: ${review}`;
}

/**
 * A gate's note in the chat ("✓ Approved by the reviewer: …"), in the user's language; other notes as they are.
 *
 * @param text - The note from the server.
 * @param L - Picks Hebrew or English.
 */
export function gateNoteText(text: string, L: Pick): string {
  const m = /^✓ Approved by the (local )?reviewer: ([\s\S]*)$/.exec(text);
  if (!m) return text;
  return `✓ ${m[1] ? L("הבודק המקומי אישר", "Approved by the local reviewer") : L("הבודק אישר", "Approved by the reviewer")}: ${m[2]}`;
}
