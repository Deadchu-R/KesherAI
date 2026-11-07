/**
 * UI strings. Every visible word goes through `t()`, so adding a language is
 * one new object here (and RTL languages get `dir="rtl"` automatically).
 */
export type Locale = "he" | "en";

const strings = {
  he: {
    chat: "צ'אט",
    images: "תמונות",
    models: "מודלים והורדות",
    connections: "חיבורים",
    newChat: "שיחה חדשה",
    send: "שלח",
    stop: "עצור",
    pickModel: "בחר מודל",
    noModels: "אין עדיין מודלים. חבר שרת או הורד מודל.",
    messagePlaceholder: "כתוב הודעה…",
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
    loadInLlama: "טען ב-llama.cpp",
    add: "הוסף",
    remove: "הסר",
    connected: "מחובר",
    offline: "לא זמין",
    autodetected: "זוהה אוטומטית",
    presets: "הוספה מהירה",
    customServer: "שרת משלך",
    id: "מזהה",
    name: "שם",
    baseUrl: "כתובת בסיס",
    apiKey: "מפתח API",
    type: "סוג",
    plugins: "תוספים",
    yourHardware: "המחשב שלך",
    serverOffline: "שרת הליבה לא עונה. הוא רץ?",
    language: "English",
  },
  en: {
    chat: "Chat",
    images: "Images",
    models: "Models & downloads",
    connections: "Connections",
    newChat: "New chat",
    send: "Send",
    stop: "Stop",
    pickModel: "Pick a model",
    noModels: "No models yet. Connect a server or download a model.",
    messagePlaceholder: "Write a message…",
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
    loadInLlama: "Load in llama.cpp",
    add: "Add",
    remove: "Remove",
    connected: "Connected",
    offline: "Offline",
    autodetected: "Auto-detected",
    presets: "Quick add",
    customServer: "Your own server",
    id: "Id",
    name: "Name",
    baseUrl: "Base URL",
    apiKey: "API key",
    type: "Type",
    plugins: "Plugins",
    yourHardware: "Your computer",
    serverOffline: "The core server is not answering. Is it running?",
    language: "עברית",
  },
} as const;

/** A key of the strings table. */
export type StringKey = keyof (typeof strings)["en"];

let current: Locale = (localStorage.getItem("locale") as Locale | null) ?? "he";

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
 * @returns The text in the active locale.
 */
export function t(key: StringKey): string {
  return strings[current][key];
}
