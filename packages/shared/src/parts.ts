/**
 * The parts of KesherAI that can be turned on and off (Settings → Parts).
 * With all of them off KesherAI is only a chat: their pages leave the menu,
 * their tools leave the chats, and what they run in the background stops,
 * so they take no memory. Turning one on downloads what it needs (its
 * engine, its models), which then update by themselves.
 *
 * Chats, code sessions, models, connections, personas, prompts, memory,
 * plugins, updates and settings are always there.
 */
export interface PartDefinition {
  id: string;
  /** Pages it adds to the menu (hash routes). */
  pages: string[];
  icon: string;
  title: { en: string; he: string };
  description: { en: string; he: string };
  /** What turning it on downloads, roughly, in GB (0 = nothing). */
  downloadGb: number;
  /** An official plugin that is this part (enabled and disabled with it). */
  plugin?: string;
}

export const PARTS: PartDefinition[] = [
  { id: "images", pages: ["#/images", "#/batch"], icon: "🖼", downloadGb: 0.1, title: { en: "Pictures", he: "תמונות" }, description: { en: "Make and edit pictures in chats and on the Pictures page, with a local picture model.", he: "יצירה ועריכה של תמונות בצ'אטים ובעמוד התמונות, עם מודל תמונות מקומי." } },
  { id: "video", pages: [], icon: "🎬", downloadGb: 7.2, title: { en: "Video", he: "וידאו" }, description: { en: "Short clips from words in chats (Wan 2.1).", he: "סרטונים קצרים ממילים בצ'אטים (Wan 2.1)." } },
  { id: "image-editor", pages: ["#/p/image-editor/editor"], icon: "🖌", downloadGb: 0, plugin: "image-editor", title: { en: "Image editor", he: "עורך תמונות" }, description: { en: "A layered editor after Photoshop and Affinity, with the picture model.", he: "עורך שכבות בסגנון פוטושופ ו-Affinity, עם מודל התמונות." } },
  { id: "nodes", pages: ["#/nodes"], icon: "🧩", downloadGb: 4, title: { en: "Nodes (ComfyUI)", he: "נודים (ComfyUI)" }, description: { en: "ComfyUI's node editor inside KesherAI, editable in words.", he: "עורך הנודים של ComfyUI בתוך KesherAI, עם עריכה במילים." } },
  { id: "unreal", pages: ["#/unreal"], icon: "🎮", downloadGb: 0, title: { en: "Unreal Blueprints", he: "Unreal Blueprints" }, description: { en: "See your project's Blueprints and change them in words, through the KesherAI Bridge plugin for Unreal.", he: "רואים את ה-Blueprints של הפרויקט ומשנים אותם במילים, דרך הפלאגין KesherAI Bridge ל-Unreal." } },
  { id: "voice", pages: [], icon: "🎙", downloadGb: 0.6, title: { en: "Voice", he: "קול" }, description: { en: "Speak instead of typing, voice conversations, and answers read aloud (whisper.cpp, Kokoro).", he: "דיבור במקום הקלדה, שיחה קולית, והקראת תשובות (whisper.cpp, Kokoro)." } },
  { id: "day", pages: ["#/day"], icon: "📅", downloadGb: 0, title: { en: "My day and meetings", he: "היום שלי ופגישות" }, description: { en: "A diary of your day and meeting notes, on this computer only.", he: "יומן של היום ורישום פגישות, רק במחשב הזה." } },
  { id: "pages", pages: ["#/pages"], icon: "📝", downloadGb: 0, title: { en: "Pages", he: "מסמכים (Pages)" }, description: { en: "Documents you write together with the agent.", he: "מסמכים שכותבים יחד עם הסוכן." } },
  { id: "knowledge", pages: ["#/knowledge"], icon: "📚", downloadGb: 0.64, title: { en: "Knowledge", he: "ידע" }, description: { en: "Your folders and pages, searchable by the models, with sources.", he: "תיקיות ודפים שלך שהמודלים מחפשים בהם, עם מקורות." } },
  { id: "browser", pages: [], icon: "🌐", downloadGb: 0, title: { en: "Your browser", he: "הדפדפן שלך" }, description: { en: "The agent works in your own browser through the extension.", he: "הסוכן עובד בדפדפן שלך דרך התוסף." } },
  { id: "watch", pages: ["#/watch"], icon: "🖥", downloadGb: 0, title: { en: "Computer use", he: "שימוש במחשב" }, description: { en: "The agent sees the screen and uses apps, and you watch and approve.", he: "הסוכן רואה את המסך ומשתמש באפליקציות, ואתה צופה ומאשר." } },
  { id: "pipelines", pages: ["#/pipelines"], icon: "⛓", downloadGb: 0, title: { en: "Pipelines", he: "צינורות עבודה" }, description: { en: "Chained steps and routines that run by themselves.", he: "שלבים בשרשרת ומשימות שרצות לבד." } },
  { id: "compare", pages: ["#/compare"], icon: "⚖", downloadGb: 0, title: { en: "Compare models", he: "השוואת מודלים" }, description: { en: "One question to several models side by side.", he: "שאלה אחת לכמה מודלים זה לצד זה." } },
  { id: "community", pages: ["#/community", "#/usage"], icon: "👥", downloadGb: 0, title: { en: "Community and usage", he: "קהילה ושימוש" }, description: { en: "Shared prompts and personas, and your usage and coach.", he: "פרומפטים ופרסונות משותפים, והשימוש והמאמן שלך." } },
];

/** @returns Whether a part is on (parts not in the settings are on). */
export function partOn(parts: Record<string, boolean> | undefined, id: string): boolean {
  return parts?.[id] !== false;
}

/** @returns Whether a menu page belongs to a part that is off. */
export function pageHidden(parts: Record<string, boolean> | undefined, hash: string): boolean {
  return PARTS.some((p) => !partOn(parts, p.id) && p.pages.some((x) => hash === x || hash.startsWith(`${x}/`)));
}
