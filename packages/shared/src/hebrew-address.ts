/**
 * Addressing the user in Hebrew by her setting (feminine, masculine or plural): the interface's commands and
 * second-person words are written in one form and turned into the chosen one here. Only words with one meaning are
 * in the list (not "אשר" which is also "that", "עבור" also "for", "צלם" also "photographer", "סמן" also "cursor").
 */

/** f: feminine, m: masculine, p: plural (neutral). */
export type HebrewAddress = "f" | "m" | "p";

/** Masculine, feminine, plural. */
const WORDS: Array<[string, string, string]> = [
  ["התחל", "התחילי", "התחילו"], ["כתוב", "כתבי", "כתבו"], ["בחר", "בחרי", "בחרו"], ["הוסף", "הוסיפי", "הוסיפו"],
  ["הדבק", "הדביקי", "הדביקו"], ["לחץ", "לחצי", "לחצו"], ["שאל", "שאלי", "שאלו"], ["נסה", "נסי", "נסו"],
  ["הקלט", "הקליטי", "הקליטו"], ["פתח", "פתחי", "פתחו"], ["חזור", "חזרי", "חזרו"], ["הקלד", "הקלידי", "הקלידו"],
  ["שמור", "שמרי", "שמרו"], ["התחבר", "התחברי", "התחברו"], ["בדוק", "בדקי", "בדקו"], ["הורד", "הורידי", "הורידו"],
  ["התקן", "התקיני", "התקינו"], ["העתק", "העתיקי", "העתיקו"], ["מחק", "מחקי", "מחקו"], ["סגור", "סגרי", "סגרו"],
  ["שלח", "שלחי", "שלחו"], ["צור", "צרי", "צרו"], ["ערוך", "ערכי", "ערכו"], ["הפעל", "הפעילי", "הפעילו"],
  ["גרור", "גררי", "גררו"], ["הצג", "הציגי", "הציגו"], ["עדכן", "עדכני", "עדכנו"], ["המתן", "המתיני", "המתינו"],
  ["הזן", "הזיני", "הזינו"], ["הסתר", "הסתירי", "הסתירו"], ["אשר את", "אשרי את", "אשרו את"], ["סרוק", "סרקי", "סרקו"],
  ["חפש", "חפשי", "חפשו"], ["הקשב", "הקשיבי", "הקשיבו"], ["דבר איתי", "דברי איתי", "דברו איתי"], ["קרא את", "קראי את", "קראו את"],
  ["תן", "תני", "תנו"], ["שים", "שימי", "שימו"], ["קח", "קחי", "קחו"], ["עצור", "עצרי", "עצרו"], ["המשך", "המשיכי", "המשיכו"],
  ["אתה", "את", "אתם"], ["עליך", "עלייך", "עליכם"], ["אליך", "אלייך", "אליכם"], ["שלך", "שלך", "שלכם"], ["לך", "לך", "לכם"], ["תרצה", "תרצי", "תרצו"], ["רוצה לנסות", "רוצה לנסות", "רוצים לנסות"],
  ["אתה לומד", "את לומדת", "אתם לומדים"], ["אתה עושה", "את עושה", "אתם עושים"], ["שלמדת", "שלמדת", "שלמדתם"],
  ["תוכל", "תוכלי", "תוכלו"], ["כשתתחבר", "כשתתחברי", "כשתתחברו"], ["תתחבר", "תתחברי", "תתחברו"], ["כשתדבר", "כשתדברי", "כשתדברו"], ["קיבלת", "קיבלת", "קיבלתם"], ["אם תרצה", "אם תרצי", "אם תרצו"],
];

/** For each target form: every other form of a word → the target's form. */
const MAPS: Record<HebrewAddress, Map<string, string>> = { m: new Map(), f: new Map(), p: new Map() };
for (const [m, f, p] of WORDS) {
  for (const [from, to] of [[f, m], [p, m]] as const) if (from !== to && !MAPS.m.has(from)) MAPS.m.set(from, to);
  for (const [from, to] of [[m, f], [p, f]] as const) if (from !== to && from !== "את" && !MAPS.f.has(from)) MAPS.f.set(from, to);
  for (const [from, to] of [[m, p], [f, p]] as const) if (from !== to && from !== "את" && !MAPS.p.has(from)) MAPS.p.set(from, to);
}
// "את" is also the object marker: it is never turned into "אתה"/"אתם" (only "אתה" turns into it).
MAPS.m.delete("את");
MAPS.p.delete("את");
// "לחץ" is also the noun "pressure": these phrases stay as they are (the longer match wins over the command).
for (const phrase of ["בלי לחץ", "תחת לחץ", "לחץ דם", "לחץ הדם", "לחץ נפשי"]) for (const a of ["m", "f", "p"] as const) MAPS[a].set(phrase, phrase);

const RE: Partial<Record<HebrewAddress, RegExp>> = {};
const regex = (a: HebrewAddress) => {
  if (RE[a]) return RE[a]!;
  const keys = [...MAPS[a].keys()].sort((x, y) => y.length - x.length).map((k) => k.replace(/ /g, "\\s"));
  // A whole word, possibly after ו (and): not inside a longer word.
  RE[a] = new RegExp(`(?<![\\u05d0-\\u05ea])(ו?)(${keys.join("|")})(?![\\u05d0-\\u05ea])`, "g");
  return RE[a]!;
};

/**
 * Hebrew text in the form she chose.
 *
 * @param text - Hebrew, in any of the forms.
 * @param a - Her setting; undefined leaves the text as written.
 * @returns The text.
 */
export function hebrewFor(text: string, a: HebrewAddress | undefined): string {
  if (!a || !text) return text;
  return text.replace(regex(a), (_all, vav: string, word: string) => `${vav}${MAPS[a].get(word.replace(/\s/g, " ")) ?? word}`);
}
