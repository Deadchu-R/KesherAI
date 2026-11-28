/**
 * The short web-search query for a typed question, by cheap rules (no model): question words, politeness and
 * punctuation go; the entities, numbers and dates stay. Measured on the PC (28.11): the whole sentence as the query
 * ("What is the weather forecast for Haifa tomorrow?") found pages about another town, so the model searched again.
 * English and Hebrew: "מה מזג האוויר בחיפה מחר" gives "מזג אוויר חיפה מחר".
 */

/** The most words a query keeps (the same limit web_search accepts). */
const MAX_WORDS = 12;

/** English words that carry no search meaning (question words, politeness, articles, the verb "to be"). */
const EN_STOP = new Set(
  "what whats what's which who whom whose when where why how is are was were be been am do does did can could would should will shall may might please pls tell me us my i we you your the a an of for about to on in at is it its this that these those there any some give show find look up search google check know want need like let lets let's just hey hi hello thanks thank".split(" "),
);

/** Hebrew question words, fillers and politeness (whole words only). */
const HE_STOP = new Set(
  "מה מהו מהי מהם מהן איך איזה איזו אילו מתי איפה היכן כמה האם למה מדוע מי מיהו מי־ תגיד תגידי תגיד־לי תספר תספרי תראה תראי תחפש תחפשי חפש חפשי תמצא תמצאי מצא אפשר בבקשה לי לנו אותי את אתה אתם יש אם זה זו זאת הזה הזאת".split(" "),
);

/** Israeli towns: a leading ב/ל/מ before one is a preposition ("בחיפה" is "in Haifa"), so the name alone is searched. */
const HE_PLACES = new Set(["חיפה", "תל", "ירושלים", "אילת", "נתניה", "אשדוד", "אשקלון", "רמת", "הרצליה", "חולון", "פתח", "ראשון", "רחובות", "טבריה", "נצרת", "עכו", "קריות", "קיסריה", "עפולה", "כרמיאל", "בית", "באר", "מודיעין", "בני", "כפר", "הוד", "רעננה", "נהריה", "צפת", "דימונה", "לונדון", "פריז", "ברלין", "רומא", "ניו", "אמסטרדם", "ברצלונה", "מדריד", "וינה", "פראג", "אתונה", "איסטנבול", "דובאי", "בודפשט"]);

/**
 * Turns the typed message into a short search query.
 *
 * @param typed - What the user wrote.
 * @returns The key words (never empty: the trimmed message itself when the rules would leave nothing).
 */
export function searchQueryOf(typed: string): string {
  const clean = typed
    .replace(/https?:\/\/\S+/g, " ")
    // Punctuation off, but keep a dot or colon or slash between digits (3.5, 18:30, 28/11) and a hyphen inside a word.
    .replace(/[?!؟"“”„«»()[\]{}<>,;]/g, " ")
    .replace(/(?<!\d)[.:/]|[.:/](?!\d)/g, " ")
    .replace(/(?<![\p{L}\d])-|-(?![\p{L}\d])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = clean.split(" ").filter(Boolean);
  const kept: string[] = [];
  for (let w of words) {
    const lower = w.toLowerCase().replace(/’/g, "'");
    if (EN_STOP.has(lower) || HE_STOP.has(w)) continue;
    if (/[֐-׿]/.test(w)) w = hebrewWord(w);
    kept.push(w);
  }
  // "מזג האוויר" is searched as "מזג אוויר" (the article is no search word).
  const out = kept.map((w) => (w === "האוויר" ? "אוויר" : w === "המזג" ? "מזג" : w)).slice(0, MAX_WORDS).join(" ");
  return out || clean.slice(0, 200) || typed.trim().slice(0, 200);
}

/** A Hebrew word without a preposition glued to a known town ("בחיפה", "לאילת", "מתל אביב" → the town). */
function hebrewWord(w: string): string {
  if (w.length >= 3 && /^[בלמ]/.test(w) && HE_PLACES.has(w.slice(1))) return w.slice(1);
  if (w.length >= 5 && /^[בלמ]ה/.test(w) && HE_PLACES.has(w.slice(2))) return w.slice(2);
  return w;
}

/**
 * Asks a small model for a better query, within a time budget; the rules' query stands on any failure or oddity.
 *
 * @param typed - What the user wrote.
 * @param ask - The small model (one call: system, user text, signal), or undefined when none is loaded.
 * @param budgetMs - How long to wait for it.
 * @returns The query and who made it.
 */
export async function searchQueryFor(typed: string, ask: ((system: string, user: string, signal: AbortSignal) => Promise<string>) | undefined, budgetMs = 1500): Promise<{ query: string; by: "rules" | "model" }> {
  const rules = searchQueryOf(typed);
  if (!ask || rules.split(" ").length <= 3) return { query: rules, by: "rules" };
  try {
    // Raced against the budget too: a model that is still loading may not honour the signal.
    const raw = await Promise.race([ask("Write one short web-search query (2 to 7 key words, same language as the message, no punctuation, keep names, places and dates) for the user's message. Reply with the query only.", typed.slice(0, 300), AbortSignal.timeout(budgetMs)), new Promise<string>((_, no) => setTimeout(() => no(new Error("over budget")), budgetMs).unref())]);
    const q = raw.replace(/^["'`\s]+|["'`\s]+$/g, "").split("\n")[0]!.replace(/\s+/g, " ").trim();
    const n = q.split(" ").length;
    return q && n >= 1 && n <= 9 && q.length <= 100 ? { query: q, by: "model" } : { query: rules, by: "rules" };
  } catch {
    return { query: rules, by: "rules" };
  }
}
