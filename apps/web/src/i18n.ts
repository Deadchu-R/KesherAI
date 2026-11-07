/**
 * UI strings. Every visible word goes through `t()`, so adding a language is
 * one new object here (and RTL languages get `dir="rtl"` automatically).
 * Strings with `{name}` placeholders are filled by `t(key, { name })`.
 */
export type Locale = "he" | "en";

const en = {
  chat: "Chat",
  images: "Images",
  models: "Models & downloads",
  connections: "Connections",
  settings: "Settings",
  newChat: "New chat",
  newCode: "New code session",
  projects: "Projects",
  newProject: "New project",
  chats: "Chats",
  noConversations: "No conversations yet.",
  send: "Send",
  stop: "Stop",
  undo: "Undo last change",
  pickModel: "Pick a model",
  noModels: "No models yet. Connect a server or download a model.",
  messagePlaceholder: "Write a message…",
  codePlaceholder: "Describe what to build or fix…",
  generate: "Generate",
  prompt: "Prompt",
  width: "Width",
  height: "Height",
  steps: "Steps",
  search: "Search",
  searchHub: "Search Hugging Face",
  download: "Download",
  files: "Files",
  downloads: "Downloads",
  localFiles: "Downloaded files",
  load: "Load",
  add: "Add",
  remove: "Remove",
  save: "Save",
  cancel: "Cancel",
  delete: "Delete",
  rename: "Rename",
  connected: "Connected",
  offline: "Offline",
  autodetected: "Auto-detected",
  presets: "Quick add",
  id: "Id",
  name: "Name",
  baseUrl: "Base URL",
  apiKey: "API key",
  type: "Type",
  plugins: "Plugins",
  yourHardware: "Your computer",
  serverOffline: "The core server is not answering. Is it running?",
  language: "English",
  // conversation
  working: "Working…",
  waitingForYou: "Waiting for you",
  allow: "Allow",
  allowAlways: "Always allow",
  deny: "Deny",
  noteForAgent: "Note for the agent (optional)",
  reasonWrite: "The agent wants to change a file.",
  reasonExec: "The agent wants to run a command on your computer.",
  reasonDanger: "This command {what}, so it always needs your approval.",
  answer: "Answer",
  allowed: "Allowed",
  denied: "Denied",
  expired: "Expired",
  output: "Output",
  mode: "Permissions",
  modeAsk: "Ask before changes",
  modeAutoEdit: "Auto-approve edits",
  modeAuto: "Fully automatic",
  folder: "Project folder",
  browse: "Browse…",
  folderHint: "Full path, e.g. C:\\Users\\you\\Projects\\game",
  project: "Project",
  noProject: "No project",
  instructions: "Instructions for every conversation (optional)",
  create: "Create",
  undone: "Undid the change to {path}",
  emptyChat: "Ask anything. Active media models are available as tools.",
  emptyCode: "The agent can read, search, edit and run commands in {folder}. It asks before changes unless you choose otherwise.",
  // engine and models
  startHere: "Start here — runs on this computer, no other app needed",
  engine: "Built-in engine (llama.cpp)",
  engineNotInstalled: "Not installed. It is downloaded automatically the first time you run a model.",
  engineInstalled: "Installed · {version}",
  running: "Running: {model}",
  installEngine: "Install engine",
  stopEngine: "Stop",
  downloadAndRun: "Download & run",
  run: "Run",
  ratingGood: "Runs well",
  ratingOk: "Runs OK",
  ratingSlow: "Slow here",
  "ratingToo-big": "Too big",
  perSecond: "~{n} words/s",
  "task-short-answer": "Short answer",
  "task-long-answer": "Long answer",
  "task-read-file": "Read a 2,000-line file",
  "task-load": "Load the model",
  estimateNote: "Estimates for your hardware, often within ×2.",
  goodForCode: "Good for code",
  // settings
  activeModels: "Active models",
  activeModelsHint: "The chat model can use the active image model as a tool. Video, speech and music models can be chosen now and will be used once those engines arrive.",
  none: "None",
  sync: "Cloud backup",
  syncHint: "Pick a folder that Google Drive for desktop, OneDrive or Dropbox syncs. Projects and conversations are saved there too, and loaded from it on your other computers.",
  syncFolder: "Sync folder",
  syncOff: "Off",
  synced: "Synced {n} files",
  version: "Version",
  checkUpdates: "Check for updates",
  upToDate: "You have the latest version.",
  updateAvailable: "{n} new change(s) available",
  installUpdate: "Download and install",
  updating: "Updating…",
  updateDone: "Updated. KesherAI reloads by itself; if not, restart it.",
  updateRestart: "Updated. Restart KesherAI to finish.",
  localChanges: "You have local changes; the update may fail: {files}",
  phone: "Phone",
  phoneHint: "Use KesherAI from your phone while this computer is on.",
  remoteOff: "Remote access is off. Turn it on in config.json (remote.enabled) and restart, then scan the code here.",
  scanToConnect: "Scan with your phone's camera",
  copyLink: "Copy link",
  copied: "Copied",
  phoneApp: "Scan the code to open KesherAI in the phone's browser, or paste the link into the KesherAI Android app. Outside your home network, use the Tailscale address.",
  saved: "Saved",
} as const;

/** A key of the strings table. */
export type StringKey = keyof typeof en;

const he: Record<StringKey, string> = {
  chat: "צ'אט",
  images: "תמונות",
  models: "מודלים והורדות",
  connections: "חיבורים",
  settings: "הגדרות",
  newChat: "שיחה חדשה",
  newCode: "סשן קוד חדש",
  projects: "פרויקטים",
  newProject: "פרויקט חדש",
  chats: "שיחות",
  noConversations: "אין עדיין שיחות.",
  send: "שלח",
  stop: "עצור",
  undo: "בטל שינוי אחרון",
  pickModel: "בחר מודל",
  noModels: "אין עדיין מודלים. חבר שרת או הורד מודל.",
  messagePlaceholder: "כתוב הודעה…",
  codePlaceholder: "תאר מה לבנות או לתקן…",
  generate: "צור",
  prompt: "פרומפט",
  width: "רוחב",
  height: "גובה",
  steps: "צעדים",
  search: "חיפוש",
  searchHub: "חפש ב-Hugging Face",
  download: "הורד",
  files: "קבצים",
  downloads: "הורדות",
  localFiles: "קבצים שהורדו",
  load: "טען",
  add: "הוסף",
  remove: "הסר",
  save: "שמור",
  cancel: "ביטול",
  delete: "מחק",
  rename: "שנה שם",
  connected: "מחובר",
  offline: "לא זמין",
  autodetected: "זוהה אוטומטית",
  presets: "הוספה מהירה",
  id: "מזהה",
  name: "שם",
  baseUrl: "כתובת בסיס",
  apiKey: "מפתח API",
  type: "סוג",
  plugins: "תוספים",
  yourHardware: "המחשב שלך",
  serverOffline: "שרת הליבה לא עונה. הוא רץ?",
  language: "English",
  working: "עובד…",
  waitingForYou: "מחכה לך",
  allow: "אשר",
  allowAlways: "אשר תמיד",
  deny: "דחה",
  noteForAgent: "הערה לסוכן (לא חובה)",
  reasonWrite: "הסוכן רוצה לשנות קובץ.",
  reasonExec: "הסוכן רוצה להריץ פקודה במחשב שלך.",
  reasonDanger: "הפקודה הזו מסוכנת ({what}), ולכן תמיד צריכה את האישור שלך.",
  answer: "ענה",
  allowed: "אושר",
  denied: "נדחה",
  expired: "פג תוקף",
  output: "פלט",
  mode: "הרשאות",
  modeAsk: "שאל לפני שינויים",
  modeAutoEdit: "אשר עריכות אוטומטית",
  modeAuto: "אוטומטי מלא",
  folder: "תיקיית הפרויקט",
  browse: "עיון…",
  folderHint: "נתיב מלא, למשל C:\\Users\\you\\Projects\\game",
  project: "פרויקט",
  noProject: "בלי פרויקט",
  instructions: "הוראות לכל שיחה בפרויקט (לא חובה)",
  create: "צור",
  undone: "השינוי ב-{path} בוטל",
  emptyChat: "שאל כל דבר. מודלי המדיה הפעילים זמינים ככלים.",
  emptyCode: "הסוכן יכול לקרוא, לחפש, לערוך ולהריץ פקודות ב-{folder}. הוא שואל לפני שינויים, אלא אם תבחר אחרת.",
  startHere: "להתחלה — רץ על המחשב הזה, בלי תוכנה נוספת",
  engine: "מנוע מובנה (llama.cpp)",
  engineNotInstalled: "לא מותקן. יורד אוטומטית בפעם הראשונה שמפעילים מודל.",
  engineInstalled: "מותקן · {version}",
  running: "רץ: {model}",
  installEngine: "התקן מנוע",
  stopEngine: "עצור",
  downloadAndRun: "הורד והפעל",
  run: "הפעל",
  ratingGood: "ירוץ טוב",
  ratingOk: "ירוץ בסדר",
  ratingSlow: "איטי כאן",
  "ratingToo-big": "גדול מדי",
  perSecond: "~{n} מילים בשנייה",
  "task-short-answer": "תשובה קצרה",
  "task-long-answer": "תשובה ארוכה",
  "task-read-file": "קריאת קובץ של 2,000 שורות",
  "task-load": "טעינת המודל",
  estimateNote: "הערכה לפי החומרה שלך, לרוב בטווח של פי 2.",
  goodForCode: "טוב לקוד",
  activeModels: "מודלים פעילים",
  activeModelsHint: "מודל הצ'אט יכול להשתמש במודל התמונות הפעיל ככלי. מודלי וידאו, דיבור ומוזיקה אפשר לבחור כבר עכשיו, והם יופעלו כשהמנועים שלהם יתווספו.",
  none: "ללא",
  sync: "גיבוי בענן",
  syncHint: "בחר תיקייה ש-Google Drive לדסקטופ, OneDrive או Dropbox מסנכרנים. הפרויקטים והשיחות יישמרו גם שם, וייטענו ממנה במחשבים האחרים שלך.",
  syncFolder: "תיקיית סנכרון",
  syncOff: "כבוי",
  synced: "סונכרנו {n} קבצים",
  version: "גרסה",
  checkUpdates: "בדוק עדכונים",
  upToDate: "יש לך את הגרסה האחרונה.",
  updateAvailable: "יש {n} שינויים חדשים",
  installUpdate: "הורד והתקן",
  updating: "מעדכן…",
  updateDone: "עודכן. KesherAI ייטען מחדש מעצמו; אם לא, הפעל אותו מחדש.",
  updateRestart: "עודכן. הפעל מחדש את KesherAI כדי לסיים.",
  localChanges: "יש לך שינויים מקומיים, והעדכון עלול להיכשל: {files}",
  phone: "טלפון",
  phoneHint: "עבוד עם KesherAI מהטלפון כשהמחשב הזה דלוק.",
  remoteOff: "הגישה מרחוק כבויה. הפעל אותה ב-config.json (remote.enabled), הפעל מחדש וסרוק כאן את הקוד.",
  scanToConnect: "סרוק עם המצלמה של הטלפון",
  copyLink: "העתק קישור",
  copied: "הועתק",
  phoneApp: "סרוק את הקוד כדי לפתוח את KesherAI בדפדפן של הטלפון, או הדבק את הקישור באפליקציית האנדרואיד של KesherAI. מחוץ לבית השתמש בכתובת של Tailscale.",
  saved: "נשמר",
};

const tables: Record<Locale, Record<StringKey, string>> = { en, he };

let current: Locale = (() => {
  try {
    return (localStorage.getItem("locale") as Locale | null) ?? "he";
  } catch {
    return "he";
  }
})();

/** @returns The active locale. */
export function getLocale(): Locale {
  return current;
}

/**
 * Switches language, saves the choice and sets `dir` on the document.
 *
 * @param locale - New locale.
 */
export function setLocale(locale: Locale): void {
  current = locale;
  try {
    localStorage.setItem("locale", locale);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === "he" ? "rtl" : "ltr";
}

/**
 * Translates a key.
 *
 * @param key - String key.
 * @param vars - Values for `{placeholders}`.
 * @returns The text in the active locale.
 */
export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let text = tables[current][key] ?? en[key];
  for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, String(v));
  return text;
}
