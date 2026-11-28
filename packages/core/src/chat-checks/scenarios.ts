/**
 * The chat checks' scenarios: each is one user message (Hebrew or English), its fixtures (fake pages on the fixture
 * server, files in the chat's folder, a seeded past chat) and the checks over the finished turn. Together they
 * measure whether KesherAI's chat behaves like Claude with the selected model (docs/WORK_LIST.md, 28.11).
 */
import {
  answerHas,
  answerLanguage,
  answerMaxLines,
  asksBeforeActing,
  filesExist,
  firstTool,
  noRecap,
  noRepeatedCalls,
  noTool,
  noTools,
  noWholeRead,
  saysBeforeTools,
  sendsFile,
  stopsAtSignIn,
  todoKeptAndDone,
  toolBeforeAnswer,
  usesTool,
  type Check,
} from "./checks.js";
import type { FixtureFile } from "./fixtures.js";

/** What a scenario's message may refer to: the fixture server's addresses. */
export interface ScenarioContext {
  /** @returns The full address of a fixture page. */
  url(path: string): string;
}

/** One chat check. */
export interface Scenario {
  id: string;
  he: string;
  en: string;
  /** The user's message. */
  message(ctx: ScenarioContext): string;
  /** Uses the fixture server's pages (browser scenarios). */
  web?: boolean;
  /** Files put in the chat's folder before the message. */
  files?: Record<string, FixtureFile>;
  /** Commands the auto-answer may approve (each matches the whole command), run in the chat's folder. */
  commands?: readonly RegExp[];
  /** A past chat seeded for the search (runs this scenario in a normal chat: incognito chats cannot search). */
  pastChat?: { title: string; messages: Array<{ role: "user" | "assistant"; text: string }> };
  /** Runs in a normal chat, not an incognito one: incognito chats have no timer or schedule tools. The chat is deleted after. */
  normalChat?: boolean;
  /** The turn ends as soon as the model asks a question (the check is that it asked). */
  stopOnQuestion?: boolean;
  /** Skipped unless the chat's tool has this input option (e.g. `run_command.background`, not built yet). */
  needs?: { tool: string; option?: string };
  /** The most seconds the turn may take (default 180). */
  limitSec?: number;
  checks: readonly Check[];
}

/** A log with one error line in the middle: big enough that reading it whole is wrong, under read_file's 5 MB cap. */
function bigLog(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 60_000; i++) {
    lines.push(i === 41_234 ? "2026-11-28 03:12:09 ERROR E4711 disk full on volume data2" : `2026-11-28 03:${String(i % 60).padStart(2, "0")}:00 INFO heartbeat ok seq=${i}`);
  }
  return lines.join("\n") + "\n";
}

/** A "build" that prints a line every 2 s for 60 s (the background-command scenario). */
const SLOW_BUILD = `// A slow fake build for KesherAI's chat checks.
let n = 0;
const t = setInterval(() => { n++; console.log("building step " + n + "/30"); if (n >= 30) { clearInterval(t); console.log("build ok"); } }, 2000);
`;

/** Every scenario, in the order they run. */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: "browser-open",
    he: "פתח כתובת מקומית וענה ממנה",
    en: "Open a local page and answer from it",
    web: true,
    message: (c) => `Open ${c.url("/article")} and tell me who the lighthouse's last keeper was.`,
    checks: [firstTool(/^browser_(open|navigate)$/), noTool("web_search"), answerHas("Ada Marlow")],
  },
  {
    id: "todo-steps",
    he: "עבודה בארבעה שלבים עם רשימת משימות",
    en: "A 4-step job with a task list",
    message: () => "Create three files: a.txt containing \"one\", b.txt containing \"two\", c.txt containing \"three\". Then write summary.md that lists the three files and what each contains.",
    checks: [saysBeforeTools, todoKeptAndDone, filesExist("a.txt", "b.txt", "c.txt", "summary.md"), noRepeatedCalls],
  },
  {
    id: "ask-first",
    he: "בקשה עמומה ויקרה: שואל קודם",
    en: "Ambiguous costly ask: asks first",
    files: { "app.js": "const total = (xs) => xs.reduce((a, b) => a + b, 0);\nmodule.exports = { total };\n", "util.js": "exports.pad = (s, n) => String(s).padStart(n);\n", "README.md": "# Tiny app\n" },
    message: () => "Rewrite the whole project.",
    stopOnQuestion: true,
    checks: [asksBeforeActing],
  },
  {
    id: "background-build",
    he: "בנייה ארוכה ברקע",
    en: "Long build in the background",
    files: { "build.js": SLOW_BUILD, "package.json": "{\n  \"name\": \"harbor-lights\",\n  \"version\": \"1.0.0\"\n}\n" },
    commands: [/^node\s+(\.\/)?build\.js$/],
    needs: { tool: "run_command", option: "background" },
    message: () => "Run `node build.js` (it takes about a minute) and meanwhile tell me the package name in package.json.",
    checks: [usesTool("run_command", { key: "background", match: /^true$/ }), answerHas("harbor-lights")],
  },
  {
    id: "schedule-daily",
    he: "תזכורת יומית ב-9",
    en: "Daily reminder at 9",
    normalChat: true,
    message: () => "Every morning at 9 remind me to drink a glass of water.",
    checks: [usesTool("schedule_task", { key: "when", match: /^daily 0?9:00$/i })],
  },
  {
    id: "past-chat",
    he: "מה החלטנו אתמול (חיפוש בצ'אטים)",
    en: "What we decided yesterday (chat search)",
    pastChat: {
      title: "Logo ideas for the bakery site",
      messages: [
        { role: "user", text: "Let's settle the bakery logo. Teal or burgundy?" },
        { role: "assistant", text: "Decided: the logo will be teal with a rounded K, on a cream background." },
      ],
    },
    message: () => "What did we decide yesterday about the logo?",
    checks: [toolBeforeAnswer("search_chats", "recent_chats"), answerHas(/teal/i)],
  },
  {
    id: "sign-in",
    he: "דף התחברות: עוצר עם כרטיס",
    en: "Login page: stops with the card",
    web: true,
    message: (c) => `Open ${c.url("/login")} and sign in to my account.`,
    checks: [stopsAtSignIn],
  },
  {
    id: "summary-file",
    he: "קובץ סיכום נשלח לצ'אט",
    en: "Summary file sent to the chat",
    files: { "notes.txt": "Meeting 27.11\n- Ship the chat checks this week\n- Move the design review to Monday\n- Ask about the new GPU budget\n" },
    message: () => "Make me a summary file of notes.txt.",
    checks: [usesTool("write_file"), sendsFile],
  },
  {
    id: "plain-math",
    he: "שאלה פשוטה בלי כלים",
    en: "Plain question, no tools",
    message: () => "What's 17*23?",
    checks: [noTools, answerHas("391"), answerMaxLines(3)],
  },
  {
    id: "hebrew-reply",
    he: "עברית נכנסת, עברית יוצאת",
    en: "Hebrew in, Hebrew out",
    message: () => "מה עיר הבירה של צרפת? בקצרה.",
    checks: [noTools, answerLanguage("he"), answerHas("פריז")],
  },
  {
    id: "english-reply",
    he: "אנגלית נכנסת, אנגלית יוצאת",
    en: "English in, English out",
    message: () => "In one line: what is the capital of Japan?",
    checks: [noTools, answerLanguage("en"), answerHas("Tokyo"), answerMaxLines(2)],
  },
  {
    id: "short-final",
    he: "תשובה סופית קצרה בלי סיכום שלבים",
    en: "Short final answer, no step recap",
    commands: [/^node\s+(\.\/)?hello\.js$/],
    message: () => "Create hello.js that prints \"hello from kesher\", run it with node, and tell me what it printed.",
    checks: [answerHas("hello from kesher"), answerMaxLines(6), noRecap, noRepeatedCalls],
  },
  {
    id: "huge-file",
    he: "קובץ ענק: לא קורא את כולו",
    en: "Huge file: does not read it all",
    files: { "big.log": bigLog },
    message: () => "There's one ERROR line in big.log. What is its error code?",
    checks: [noWholeRead("big.log"), answerHas("E4711"), noRepeatedCalls],
  },
  {
    id: "says-first",
    he: "משפט פתיחה לפני הכלים",
    en: "A sentence before the tools",
    files: { "notes.txt": "Buy flour and yeast\nCall the printer about the menus\n" },
    message: () => "Read notes.txt and tell me its first line.",
    checks: [saysBeforeTools, answerHas(/flour/i), noRepeatedCalls],
  },
  {
    id: "count-files",
    he: "ספירת קבצים בלי קריאות כפולות",
    en: "Count files without repeated calls",
    files: { "one.txt": "1", "two.txt": "2", "three.txt": "3", "docs/four.md": "4", "docs/five.md": "5" },
    message: () => "How many files are in this folder, including subfolders?",
    checks: [noRepeatedCalls, answerHas(/\b5\b|five/i), answerMaxLines(8)],
  },
];

/**
 * The scenarios to run.
 *
 * @param ids - Scenario ids; empty or undefined for all.
 * @returns The matching scenarios, in their usual order.
 * @throws Error when an id is unknown.
 */
export function pickScenarios(ids?: readonly string[]): Scenario[] {
  if (!ids?.length) return [...SCENARIOS];
  const unknown = ids.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown chat check: ${unknown.join(", ")}`);
  return SCENARIOS.filter((s) => ids.includes(s.id));
}
