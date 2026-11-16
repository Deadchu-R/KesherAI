/**
 * Notification titles in Hebrew. The server writes them in English (they also go to ntfy, Telegram and logs); the
 * app shows the known ones in the reader's language, and anything it does not know stays as written.
 */

/** Fixed titles. */
const FIXED: Record<string, string> = {
  "🤖 Self-work started": "🤖 העבודה העצמית התחילה",
  "✋ Self-work waits for your approval": "✋ העבודה העצמית מחכה לאישור שלך",
  "✅ Self-work finished": "✅ העבודה העצמית הסתיימה",
  "✋ Self-work needs you": "✋ העבודה העצמית צריכה אותך",
  "⏹ Self-work stopped": "⏹ העבודה העצמית נעצרה",
  "🤖 Skipped an item": "🤖 פריט דולג",
  "The drive is almost full": "הכונן כמעט מלא",
  "Graphics card": "כרטיס המסך",
  "📱 A phone asks to control this computer": "📱 טלפון מבקש לשלוט במחשב",
  "📱 Remote control started": "📱 השליטה מרחוק התחילה",
  "A new device key was made": "נוצר מפתח מכשיר חדש",
  "A connector key was made": "נוצר מפתח חיבור",
  "Many refused tries on KesherAI": "הרבה ניסיונות כניסה נדחו",
  "A device was refused a few times": "מכשיר נדחה כמה פעמים",
  "Someone tried to get into KesherAI": "מישהו ניסה להיכנס ל-KesherAI",
  "Telegram locked": "טלגרם ננעל",
  "Telegram: pairing closed": "טלגרם: ההתאמה נסגרה",
};

/** Titles with a name after them. */
const PREFIX: Array<[string, string]> = [
  ["Done: ", "הסתיים: "],
  ["Stopped with an error: ", "נעצר עם שגיאה: "],
  ["Waiting for you: ", "מחכה לך: "],
  ["Downloaded: ", "הורד: "],
  ["Download failed: ", "ההורדה נכשלה: "],
];

/**
 * A notification's title for the reader.
 *
 * @param title - As the server wrote it.
 * @param lang - The app's language.
 */
export function noteTitle(title: string, lang: string): string {
  if (lang !== "he") return title;
  const fixed = FIXED[title];
  if (fixed) return fixed;
  for (const [en, he] of PREFIX) if (title.startsWith(en)) return he + title.slice(en.length);
  return title;
}
