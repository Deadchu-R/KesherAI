/**
 * Study: fields of study, the tools each field gets, pictures for a topic, recordings' keep time and student benefits.
 * Re-exported by study.ts, so everything imports it from there as before.
 */

import type { StudyLecture } from "./study.js";

// ── Fields of study ───────────────────────────────────────────────────────────────────────────────────────────────

/** A field of study: what it is called and the words that show it (Hebrew and English). */
export interface StudyField {
  id: string;
  he: string;
  en: string;
  words: string[];
}

/** The fields KesherAI recognises (research: docs/RESEARCH_LOG.md "Students, part 6"). */
export const STUDY_FIELDS: StudyField[] = [
  { id: "nursing", he: "סיעוד", en: "Nursing", words: ["סיעוד", "אחות", "אחיות", "מטופל", "nursing", "nurse", "בחינת רישוי", "תרופות", "פרמקולוגיה", "pharmacology", "מתן תרופה"] },
  { id: "medicine", he: "רפואה", en: "Medicine", words: ["רפואה", "רופא", "אבחנה", "medicine", "medical", "clinical", "פתולוגיה", "pathology", "אנטומיה", "anatomy", "פיזיולוגיה", "physiology"] },
  { id: "law", he: "משפטים", en: "Law", words: ["משפטים", "חוק", "סעיף", "פסק דין", "בית המשפט", "עליון", "חוזים", "נזיקין", "law", "court", "statute", "contract", "tort", "plaintiff"] },
  { id: "engineering", he: "הנדסה", en: "Engineering", words: ["הנדסה", "מהנדס", "חוזק חומרים", "מעגלים", "engineering", "circuit", "thermodynamics", "תרמודינמיקה", "סטטיקה", "statics", "mechanics"] },
  { id: "cs", he: "מדעי המחשב", en: "Computer science", words: ["מדעי המחשב", "תכנות", "אלגוריתם", "סיבוכיות", "מבני נתונים", "programming", "algorithm", "complexity", "data structures", "python", "java", "c++", "קוד"] },
  { id: "math", he: "מתמטיקה ופיזיקה", en: "Mathematics and physics", words: ["מתמטיקה", "חדו\"א", "אינפי", "אלגברה", "לינארית", "פיזיקה", "calculus", "algebra", "linear", "physics", "derivative", "integral", "נגזרת", "אינטגרל", "משוואה"] },
  { id: "psychology", he: "פסיכולוגיה", en: "Psychology", words: ["פסיכולוגיה", "פסיכולוג", "התנהגות", "קוגניטיבי", "psychology", "cognitive", "behavior", "behaviour", "פרויד", "freud", "piaget"] },
  { id: "economics", he: "כלכלה וניהול", en: "Economics and management", words: ["כלכלה", "מיקרו", "מאקרו", "ניהול", "חשבונאות", "שיווק", "economics", "micro", "macro", "accounting", "marketing", "finance", "ביקוש", "היצע"] },
  { id: "biology", he: "ביולוגיה וכימיה", en: "Biology and chemistry", words: ["ביולוגיה", "כימיה", "תא", "גנטיקה", "ביוכימיה", "biology", "chemistry", "cell", "genetics", "biochemistry", "אורגנית", "organic"] },
  { id: "education", he: "חינוך", en: "Education", words: ["חינוך", "הוראה", "פדגוגיה", "education", "teaching", "pedagogy", "תלמידים", "בית ספר"] },
  { id: "humanities", he: "מדעי הרוח והחברה", en: "Humanities and social sciences", words: ["היסטוריה", "פילוסופיה", "ספרות", "סוציולוגיה", "מדע המדינה", "history", "philosophy", "literature", "sociology", "political science"] },
  { id: "gamedev", he: "פיתוח משחקים", en: "Game development", words: ["פיתוח משחקים", "עיצוב משחקים", "מנוע משחק", "unity", "unreal", "godot", "game design", "game dev", "level design", "blueprint", "shader", "gameplay", "c#"] },
];

/** A line for the model about each field: what to favour in its answers (the computer's and the phone's). */
export const STUDY_FIELD_HINTS: Record<string, string> = {
  nursing: "This is nursing: favour what the nurse assesses, does and teaches, and patient safety.",
  medicine: "This is medicine: favour mechanisms, diagnosis and treatment, as the material states them.",
  law: "This is law: give section numbers, statute and case names exactly as the material writes them, and the rule or holding of each.",
  engineering: "This is engineering: keep formulas with their units and the conditions they hold under; a worked example shows each step.",
  cs: "This is computer science: short code in ``` blocks, the complexity of algorithms, and when to use each data structure.",
  math: "This is mathematics or physics: state definitions and theorems exactly; worked problems show each step; keep formulas as plain text.",
  psychology: "This is psychology: name the theory and its researcher, and the study and finding behind it, as the material gives them.",
  economics: "This is economics or management: definitions, models and what moves each curve or figure, with the formulas as written.",
  biology: "This is biology or chemistry: processes in order, structures and their functions, reactions as written.",
  education: "This is education: theories, their thinkers and how each is used in class.",
  humanities: "This is the humanities or social sciences: thinkers, ideas, dates and arguments as the material gives them.",
  gamedev: "This is game development: the engine's own names (Unity: GameObject, Component, Prefab, C#; Unreal: Actor, Blueprint, C++), the game loop and performance, and short code in ``` blocks.",
};

/** A tool for one field of study: it works on text she pastes, or on the course's lectures. */
export interface StudyTool {
  id: string;
  he: string;
  en: string;
  /** Who it is for (field ids). */
  fields: string[];
  /** "text": she pastes something; "course": it reads the course's lectures; "both": she says what, from the lectures. */
  input: "text" | "course" | "both";
  placeholder?: [string, string];
  prompt: string;
}

const TOOL_LANG = "Write in Hebrew unless the student's own text is in another language, keeping technical terms, names and symbols as written. Use only what is given: add no examples, numbers or details that are not in it; where something needed is missing, write [חסר] instead of inventing it. Markdown.";

/** The tools for each field (the same on the computer and the phone). */
export const STUDY_TOOLS: StudyTool[] = [
  // For every field ("*"): a comparison table and a mind map from her own lectures (RESEARCH_LOG students, NotebookLM's data tables and mind map).
  { id: "compare", he: "טבלת השוואה", en: "Comparison table", fields: ["*"], input: "both", placeholder: ["מה להשוות? למשל: חוסמי בטא מול חוסמי תעלות סידן", "What to compare? e.g. beta blockers vs calcium channel blockers"],
    prompt: `Make a comparison table of what the student asks to compare, from her lectures only: one markdown table, a column for each thing compared and a row for each point of comparison that the lectures cover (mechanism, uses, advantages, disadvantages, examples, numbers… whatever fits). Short cells. Under the table, one line on the most important difference, then the lectures it came from. ${TOOL_LANG}` },
  { id: "mindmap", he: "מפת חשיבה", en: "Mind map", fields: ["*"], input: "both", placeholder: ["על מה? (ריק: כל הקורס)", "About what? (empty: the whole course)"],
    prompt: `Make a mind map of the topic the student asks about (or of the whole course when she asks nothing), from her lectures only, as one Mermaid mindmap in a \`\`\`mermaid block: "mindmap", then the root in (( )), then the main branches and up to two levels under each, a few words per node, indented with two spaces per level, no brackets or quotes inside node text except the root. At most 40 nodes. Under it, one line naming the lectures it came from. ${TOOL_LANG}` },
  { id: "formulas", he: "דף נוסחאות מהקורס", en: "Formula sheet from the course", fields: ["engineering", "math", "cs", "economics", "biology", "gamedev"], input: "course",
    prompt: `Make a formula sheet from these lectures: every formula, law and rule written in them, grouped by topic (## heading per topic). For each: the formula (plain text, like F = m * a, no LaTeX), what each symbol means with its units, and when to use it, in one line. Then the lecture it came from in brackets. ${TOOL_LANG}` },
  { id: "brief", he: "תקציר פסק דין (IRAC)", en: "Case brief (IRAC)", fields: ["law"], input: "text", placeholder: ["הדביקי את פסק הדין או חלק ממנו", "Paste the ruling or part of it"],
    prompt: `Write a case brief of this ruling: ## העובדות (short), ## השאלה המשפטית, ## הכלל (statutes and precedents exactly as cited, with section numbers), ## היישום (the court's reasoning), ## ההכרעה, and ## דעות נוספות (minority or concurring opinions, if any). ${TOOL_LANG}` },
  { id: "statute", he: "פירוק סעיף לרכיבים", en: "A section broken into elements", fields: ["law"], input: "text", placeholder: ["הדביקי את סעיף החוק", "Paste the section"],
    prompt: `Break this statutory section into its elements: the conditions that must all hold (numbered), the exceptions, the result or remedy, and the defined terms it uses. Then one short example that meets every element, and one that misses one, saying which. ${TOOL_LANG}` },
  { id: "trace", he: "הסבר קוד ומעקב", en: "Explain and trace code", fields: ["cs", "gamedev"], input: "text", placeholder: ["הדביקי קוד", "Paste code"],
    prompt: `Explain this code for a student: what it does in two sentences, then line by line (short), then a trace table of the variables for a small example input (a markdown table, one row per step, at most 15 rows), then its time and space complexity with the reason, and any bug or edge case it misses. Write code in code blocks. ${TOOL_LANG}` },
  { id: "research", he: "ניתוח מאמר מחקר", en: "Analyze a research paper", fields: ["psychology", "education", "humanities", "biology", "medicine", "nursing", "economics"], input: "text", placeholder: ["הדביקי את התקציר או המאמר", "Paste the abstract or paper"],
    prompt: `Analyze this study for a student: ## שאלת המחקר והשערות, ## משתנים (independent, dependent, controlled, with how each was measured), ## מערך המחקר (design, sample and size, how it was chosen), ## ממצאים (with the numbers given: effect sizes, p values), ## מגבלות (as the paper states them, then others a reader would raise, marked as such), ## במשפט אחד. ${TOOL_LANG}` },
  { id: "apa", he: "רשימה ביבליוגרפית APA 7", en: "APA 7 references", fields: ["psychology", "education", "humanities", "economics", "nursing", "medicine", "biology"], input: "text", placeholder: ["פרטי המקורות: מחברים, שנה, כותרת, כתב עת, כרך, עמודים, DOI (מקור בכל שורה)", "Source details: authors, year, title, journal, volume, pages, DOI (one per line)"],
    prompt: `Write each source as an APA 7th edition reference entry, sorted alphabetically, then the in-text citation for each, e.g. (Cohen & Levi, 2020). Use only the details given; any missing part becomes [חסר]. Hebrew sources follow the Hebrew APA conventions (ו׳ for &, עמ׳). Plain list. ${TOOL_LANG}` },
  { id: "lesson", he: "מערך שיעור", en: "Lesson plan", fields: ["education"], input: "text", placeholder: ["נושא, גיל או כיתה, משך השיעור, מטרות", "Topic, age or grade, length, goals"],
    prompt: `Write a lesson plan: ## מטרות (measurable), ## ידע קודם, ## מהלך השיעור (opening, main part, closing, with minutes for each and what the teacher and the pupils do), ## הבחנה בין תלמידים (for those who need more help and those who need more challenge), ## הערכה (how she will know the goals were met), ## חומרים. ${TOOL_LANG}` },
  { id: "source", he: "ניתוח מקור או טקסט", en: "Analyze a source or text", fields: ["humanities", "education", "law"], input: "text", placeholder: ["הדביקי את הטקסט או המקור", "Paste the text or source"],
    prompt: `Analyze this text for a student: ## מי, מתי ולמי (author, time, audience, as far as the text shows), ## הטענה המרכזית, ## הנימוקים והראיות, ## מושגי מפתח, ## הקשר (what the text answers or argues with, only if it says so), ## שאלות לדיון (three). ${TOOL_LANG}` },
  { id: "reflection", he: "רפלקציה על משמרת (גיבס)", en: "Shift reflection (Gibbs)", fields: ["nursing", "medicine", "education", "psychology"], input: "text", placeholder: ["מה קרה במשמרת או בשיעור, בלי שמות ופרטים מזהים של מטופלים או תלמידים", "What happened in the shift or lesson, with no names or identifying details of patients or pupils"],
    prompt: `Write a reflective journal entry by Gibbs' cycle from her notes: ## תיאור, ## רגשות ומחשבות, ## הערכה (what went well and what did not), ## ניתוח (why, linked to what the course teaches, only where her notes allow), ## מסקנות, ## תוכנית פעולה (what she will do next time). First person, her voice, honest and short. If her notes include a name, ID number or other identifying detail of a patient or pupil, leave it out and write [הוסר]. ${TOOL_LANG}` },
  { id: "sbar", he: "העברת משמרת (SBAR)", en: "Handoff (SBAR)", fields: ["nursing", "medicine"], input: "text", placeholder: ["הערות על המטופל לתרגול, בלי שם ומספר זהות", "Notes on the patient, for practice, with no name or ID"],
    prompt: `Turn these practice notes into an SBAR handoff: ## S – מצב (now, in one or two lines), ## B – רקע, ## A – הערכה (vital signs and findings as given, what she thinks is going on), ## R – המלצה (what the next shift should do and watch). Short lines, numbers exactly as given. Leave out any name, ID number or address and write [הוסר]. This is practice for a student, not a real handoff. ${TOOL_LANG}` },
  { id: "gdd", he: "מסמך עיצוב משחק (GDD)", en: "Game design document (GDD)", fields: ["gamedev"], input: "text", placeholder: ["רעיון המשחק, הפלטפורמה, כמה זמן יש לפרויקט וכמה אנשים", "The game idea, platform, how long the project has and how many people"],
    prompt: `Write a one-page game design document for a student project from her idea: ## הרעיון במשפט, ## לולאת המשחק (core loop), ## מכניקות ושליטה, ## התקדמות ואתגר, ## סגנון אמנותי וסאונד, ## היקף (what fits the time and team she gave, and what to cut first), ## אבני דרך (a prototype first). Use only her idea and the course's terms; where something is open, write [חסר] as a question for her. ${TOOL_LANG}` },
  { id: "playtest", he: "סיכום משוב בודקים", en: "Playtest feedback summary", fields: ["gamedev"], input: "text", placeholder: ["ההערות מהבודקים, כמו שנכתבו", "The playtesters' notes, as written"],
    prompt: `Turn these playtest notes into: ## מה עבד, ## בעיות לפי חומרה (what blocks play first, with how many testers raised each), ## הצעות לתיקון (one per problem, smallest change first), ## מה לבדוק בסבב הבא. Quote only what the notes say; do not invent testers or numbers. ${TOOL_LANG}` },
  { id: "case", he: "תוכנית טיפול למקרה", en: "Care plan for a case", fields: ["nursing", "medicine", "psychology"], input: "text", placeholder: ["תיאור המקרה", "The case"],
    prompt: `From this case, write: ## בעיות עיקריות (by priority, with the findings that show each), ## מטרות, ## התערבויות (with the reason for each), ## מה לעקוב ולהעריך. Base everything on the case and on standard principles the course would teach; mark anything that needs a doctor's order or the ward's protocol. This is practice for a student, not care for a real patient. ${TOOL_LANG}` },
];

/** What to search Wikimedia Commons for, for a lecture: its English terms first (Commons is mostly English), else its title. */
export function pictureQuery(l: Pick<StudyLecture, "title" | "terms" | "picture">): string {
  return pictureQueries(l)[0]!;
}

/**
 * Searches to try in order until one finds pictures: the summary's own picture words, then the first two English
 * terms together (Commons needs every word), then the first term with "diagram". A lone term alone found portraits of
 * people with that surname on the PC ("chambers" → William Chambers), so it comes last.
 */
export function pictureQueries(l: Pick<StudyLecture, "title" | "terms" | "picture">): string[] {
  const clean = (q: string) => q.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const en = (l.terms ?? []).map((t) => t.en?.trim()).filter((t): t is string => !!t && /^[\x20-\x7e]+$/.test(t));
  const pic = l.picture?.trim() && /^[\x20-\x7e]+$/.test(l.picture) ? l.picture : undefined;
  const all = [pic, en[0] && en[1] ? `${en[0]} ${en[1]}` : undefined, en[0] ? `${en[0]} diagram` : undefined, en[0] ?? l.title].filter((q): q is string => !!q).map(clean).filter(Boolean);
  return [...new Set(all)];
}

/**
 * Keeps the pictures whose file name has a word of the search (4+ letters): Commons answers a search with nothing
 * close by with unrelated files (on the PC, "Cardiac output" animations were company logos with "Co").
 */
export function relevantPictures<T extends { page: string }>(pictures: T[], query: string): T[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 6));
  if (!words.length) return pictures;
  return pictures.filter((p) => {
    const name = decodeURIComponent(p.page.split("File:")[1] ?? p.page).toLowerCase();
    return words.some((w) => name.includes(w));
  });
}

/** What happens to kept lecture recordings (Settings → Study). */
export interface StudyRecordingSettings {
  /** Keep the audio of new recordings (the default). */
  keep: boolean;
  /** Delete kept recordings: never, some days after the lecture, or after the course's semester ends. */
  deleteAfter: "never" | "30" | "90" | "semester";
  /** She was asked once whether to change it (after her first kept recording). */
  asked?: boolean;
}

export const RECORDING_DEFAULTS: StudyRecordingSettings = { keep: true, deleteAfter: "never" };

/**
 * When a course's semester ends, for deleting its recordings "after the semester": the date she wrote, else the last
 * exam in the syllabus, else the course's exam date.
 *
 * @returns YYYY-MM-DD, or undefined when nothing says.
 */
export function semesterEnd(d: { course: { semesterEnd?: string; examDate?: string }; syllabus?: { exams?: Array<{ date: string }> } | null }): string | undefined {
  if (d.course.semesterEnd) return d.course.semesterEnd;
  const exams = (d.syllabus?.exams ?? []).map((e) => e.date).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
  return exams.at(-1) ?? d.course.examDate;
}

/**
 * Whether a kept recording is due for deleting.
 *
 * @param rec - The recording (when it was kept).
 * @param end - The course's semester end (YYYY-MM-DD), if known.
 * @param now - Now (ms).
 */
export function recordingExpired(rec: { t: number }, settings: Pick<StudyRecordingSettings, "deleteAfter">, end: string | undefined, now = Date.now()): boolean {
  if (settings.deleteAfter === "never") return false;
  if (settings.deleteAfter === "semester") return !!end && now > Date.parse(`${end}T23:59:59`) + 24 * 3600_000;
  return now - rec.t > Number(settings.deleteAfter) * 24 * 3600_000;
}

/** A free picture from Wikimedia Commons for a lecture, with its credit. */
export interface StudyPicture {
  /** The picture, or a video's still (an upload.wikimedia.org address, or a data: copy the computer fetched). */
  src: string;
  page: string;
  license: string;
  artist: string;
  /** A video's file (WebM or Ogg on upload.wikimedia.org), to play on the phone or open on Commons. */
  video?: string;
}

/** What to look for on Commons: still pictures and diagrams, animations (GIF), or videos. */
export type StudyMediaKind = "image" | "gif" | "video";

/**
 * The address of a Commons picture search (the phone calls it itself; `origin=*` lets a page read the answer).
 * Diagrams (Commons' PNG copy of a drawing) and photos, nothing unsuitable.
 */
export function commonsSearchUrl(query: string, width = 480, kind: StudyMediaKind = "image"): string {
  const q = query.replace(/["\\]/g, " ").trim().slice(0, 100);
  const only = kind === "video" ? " filetype:video" : kind === "gif" ? " filemime:gif" : "";
  const params = new URLSearchParams({ action: "query", format: "json", origin: "*", generator: "search", gsrsearch: `${q}${only} -nude -naked -nudity -erotic -sexy -porn -gore`, gsrnamespace: "6", gsrlimit: "16", prop: "imageinfo", iiprop: "url|mime|extmetadata", iiextmetadatafilter: "LicenseShortName|Artist", iiurlwidth: String(width) });
  return `https://commons.wikimedia.org/w/api.php?${params}`;
}

/** Reads a Commons search answer into pictures: only scaled copies on upload.wikimedia.org, over HTTPS. */
export function parseCommonsPictures(json: unknown, max = 8, kind: StudyMediaKind = "image"): StudyPicture[] {
  const pages = (json as { query?: { pages?: Record<string, { index?: number; imageinfo?: Array<Record<string, unknown>> }> } })?.query?.pages ?? {};
  const plain = (h: unknown) => String(h ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const out: StudyPicture[] = [];
  for (const p of Object.values(pages).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    const info = p.imageinfo?.[0];
    const mime = String(info?.mime ?? "");
    const wanted = kind === "video" ? /^(video\/(webm|ogg)|application\/ogg)$/ : kind === "gif" ? /^image\/gif$/ : /^image\/(png|jpeg|webp|svg\+xml)$/;
    if (!info || !wanted.test(mime)) continue;
    const src = String(info.thumburl ?? "");
    const onCommons = (url: string, ext: RegExp) => {
      try {
        const u = new URL(url);
        return u.protocol === "https:" && u.hostname === "upload.wikimedia.org" && ext.test(u.pathname);
      } catch {
        return false;
      }
    };
    // A video's still is a JPEG; a GIF's scaled copy stays a GIF (it moves).
    if (!onCommons(src, kind === "gif" ? /\.gif$/i : /\.(png|jpe?g|webp)$/i)) continue;
    const video = kind === "video" ? String(info.url ?? "") : "";
    if (kind === "video" && !onCommons(video, /\.(webm|ogv|ogg)$/i)) continue;
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown }>;
    const page = String(info.descriptionurl ?? "");
    out.push({ src, page: /^https:\/\/commons\.wikimedia\.org\//.test(page) ? page : "", license: plain(meta.LicenseShortName?.value) || "free licence", artist: plain(meta.Artist?.value) || "unknown", ...(video ? { video } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/** The tools that fit a course's field (all of them when the field is unknown). */
export function toolsFor(field: string | undefined): StudyTool[] {
  if (!field) return STUDY_TOOLS;
  return STUDY_TOOLS.filter((t) => t.fields.includes(field) || t.fields.includes("*"));
}

/** The course's material for a "course" tool: summaries (or text), each with its title, within a budget. */
export function toolMaterial(lectures: StudyLecture[], budget = 40_000): string {
  const each = Math.max(1500, Math.floor(budget / Math.max(1, lectures.length)));
  return lectures.map((l) => `### ${l.title}\n${(l.summary || l.text).slice(0, each)}`).join("\n\n").slice(0, budget);
}

/**
 * Guesses a course's field from its name and its lectures' words (the name counts three times).
 *
 * @param name - The course's name.
 * @param text - Its lectures' titles and the start of their text.
 * @returns The field's id, or undefined when nothing stands out.
 */
export function detectField(name: string, text: string): string | undefined {
  const hay = ` ${name} ${name} ${name} ${text} `.toLowerCase();
  let best: { id: string; score: number } | undefined;
  for (const f of STUDY_FIELDS) {
    let score = 0;
    for (const w of f.words) {
      // Hebrew joins one-letter words to the next (ו, ה, ב, ל, מ, ש, כ).
      const re = new RegExp(`(^|[^\\p{L}])[והבלמשכ]{0,2}${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu");
      score += hay.match(re)?.length ?? 0;
    }
    if (score > (best?.score ?? 1)) best = { id: f.id, score };
  }
  return best?.id;
}

/** Whether a field gets the nursing tools (drug cards, lab values, medication calculations). */
export const clinicalField = (field: string | undefined): boolean => field === "nursing" || field === "medicine";

// ── Student benefits ──────────────────────────────────────────────────────────────────────────────────────────────

/** A student benefit: what it gives and how to turn it on, with its official page. Offers change: each says when
 *  it was checked, and the page asks the web for what is current before relying on it. */
export interface StudentBenefit {
  id: string;
  group: "transport" | "ai" | "software" | "design" | "dev" | "money";
  name: { he: string; en: string };
  what: { he: string; en: string };
  how: { he: string[]; en: string[] };
  url: string;
  /** Fields of study it matters most for (empty: everyone). */
  fields?: string[];
  checked: string;
  note?: { he: string; en: string };
}

export const STUDENT_BENEFITS: StudentBenefit[] = [
  {
    id: "transit", group: "transport", checked: "2026-11-16", url: "https://www.kolzchut.org.il/he/%D7%94%D7%A0%D7%97%D7%94_%D7%9C%D7%A1%D7%98%D7%95%D7%93%D7%A0%D7%98_%D7%91%D7%A0%D7%A1%D7%99%D7%A2%D7%94_%D7%91%D7%90%D7%95%D7%98%D7%95%D7%91%D7%95%D7%A1",
    name: { he: "הנחה בתחבורה ציבורית", en: "Public transport discount" },
    what: { he: "סטודנטים זכאים ל-33%–50% הנחה בנסיעות, לפי סוג הלימודים.", en: "Students get 33%–50% off fares, by type of studies." },
    how: { he: ["מבקשים מהמוסד אישור לימודים או מעדכנים פרופיל סטודנט ברב-קו.", "טוענים את הפרופיל בעמדת רב-קו, באתר או באפליקציה של רב-קו.", "באפליקציות תשלום (מוביט, פנגו ועוד) בוחרים פרופיל סטודנט."], en: ["Get a study certificate from your school, or update the student profile on your Rav-Kav.", "Load the profile at a Rav-Kav station, the Rav-Kav site or app.", "In payment apps (Moovit, Pango and others) choose the student profile."] },
  },
  {
    id: "gemini", group: "ai", checked: "2026-11-16", url: "https://support.google.com/gemini/answer/16417758",
    name: { he: "Google Gemini לסטודנטים", en: "Google Gemini for students" },
    what: { he: "שנה של מנוי Gemini בתשלום בחינם לסטודנטים, עם NotebookLM.", en: "A free year of a paid Gemini plan for students, with NotebookLM." },
    how: { he: ["נכנסים ל-Google One מהחשבון האישי.", "מאמתים סטודנטיות דרך SheerID (מייל של המוסד או אישור לימודים).", "בוחרים את מבצע הסטודנטים ומוסיפים אמצעי תשלום (בלי חיוב בשנה הראשונה). לבטל לפני החידוש אם לא רוצים להמשיך."], en: ["Open Google One with your personal account.", "Verify you are a student with SheerID (school email or certificate).", "Pick the student offer and add a payment method (no charge in the first year). Cancel before it renews if you do not want to continue."] },
    note: { he: "בבדיקה ב-16.11.2026: לפי עמוד העזרה של Google ההצעה החדשה מוגבלת כרגע לסטודנטים בארה\"ב; מקורות אחרים מזכירים גרסה מצומצמת ב-140 מדינות. לבדוק מה זמין בישראל עכשיו.", en: "Checked 16.11.2026: Google's help page says new claims are limited to US students for now; other sources mention a smaller plan in 140 countries. Check what Israel gets now." },
  },
  {
    id: "m365", group: "software", checked: "2026-11-16", url: "https://www.microsoft.com/education/products/office",
    name: { he: "Microsoft 365 (Word, Excel, Teams)", en: "Microsoft 365 (Word, Excel, Teams)" },
    what: { he: "לרוב חינם דרך המוסד.", en: "Usually free through your school." },
    how: { he: ["נכנסים עם המייל של המוסד באתר של Microsoft 365.", "אם לא עובד, שואלים את מחלקת המחשוב של המוסד."], en: ["Sign in with your school email on the Microsoft 365 site.", "If that does not work, ask your school's IT."] },
  },
  {
    id: "github", group: "dev", checked: "2026-11-16", url: "https://education.github.com/pack", fields: ["cs", "engineering", "math"],
    name: { he: "GitHub Student Developer Pack", en: "GitHub Student Developer Pack" },
    what: { he: "עשרות כלי פיתוח בחינם: JetBrains, קרדיט לענן, דומיין ועוד.", en: "Dozens of free developer tools: JetBrains, cloud credit, a domain and more." },
    how: { he: ["נרשמים ב-education.github.com/pack.", "מאמתים עם המייל של המוסד או צילום של כרטיס/אישור סטודנט."], en: ["Sign up at education.github.com/pack.", "Verify with your school email or a photo of your student card or certificate."] },
  },
  {
    id: "notion", group: "software", checked: "2026-11-16", url: "https://www.notion.com/product/notion-for-education",
    name: { he: "Notion לחינוך", en: "Notion for education" },
    what: { he: "תוכנית Plus בחינם לסטודנטים.", en: "The Plus plan free for students." },
    how: { he: ["נרשמים עם המייל של המוסד.", "בהגדרות: מעבר לתוכנית Education."], en: ["Sign up with your school email.", "In settings: switch to the Education plan."] },
  },
  {
    id: "canva", group: "design", checked: "2026-11-16", url: "https://www.canva.com/education/",
    name: { he: "Canva לחינוך", en: "Canva for education" },
    what: { he: "Canva Pro בחינם לסטודנטים מאומתים (לרוב דרך המוסד).", en: "Canva Pro free for verified students (often through the school)." },
    how: { he: ["בודקים באתר Canva Education אם המוסד שלך רשום.", "מאמתים לפי ההוראות שם."], en: ["Check on Canva Education whether your school is listed.", "Verify as it explains."] },
  },
  {
    id: "figma", group: "design", checked: "2026-11-16", url: "https://www.figma.com/education/", fields: ["cs", "engineering", "humanities"],
    name: { he: "Figma לחינוך", en: "Figma for education" },
    what: { he: "Figma ו-FigJam בחינם לסטודנטים.", en: "Figma and FigJam free for students." },
    how: { he: ["נכנסים ל-figma.com/education.", "מאמתים סטודנטיות."], en: ["Go to figma.com/education.", "Verify you are a student."] },
  },
  {
    id: "autodesk", group: "software", checked: "2026-11-16", url: "https://www.autodesk.com/education/edu-software/overview", fields: ["engineering"],
    name: { he: "Autodesk (AutoCAD, Fusion, Revit)", en: "Autodesk (AutoCAD, Fusion, Revit)" },
    what: { he: "רישיונות חינוך בחינם.", en: "Free education licences." },
    how: { he: ["נרשמים באתר Autodesk Education.", "מאמתים עם אישור לימודים."], en: ["Sign up on Autodesk Education.", "Verify with a study certificate."] },
  },
];

/**
 * The benefits that matter for these fields first, then everyone's.
 *
 * @param fields - The student's courses' fields.
 */
export function benefitsFor(fields: Array<string | undefined>): StudentBenefit[] {
  const set = new Set(fields.filter(Boolean));
  const score = (b: StudentBenefit) => (b.fields?.some((f) => set.has(f)) ? 0 : b.fields?.length ? 2 : 1);
  return [...STUDENT_BENEFITS].sort((a, b) => score(a) - score(b));
}
