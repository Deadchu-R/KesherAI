/**
 * The roles the first-run welcome offers ("What fits you best?"). A role
 * picks which parts start on (everything else can be turned on later on the
 * Parts page) and the ideas on the start screen. Nothing else depends on it.
 */
export interface RoleDefinition {
  id: string;
  icon: string;
  title: { en: string; he: string };
  description: { en: string; he: string };
  /** Parts that start on for this role (ids from PARTS); the rest start off. */
  parts: string[];
  /** Ideas on the start screen. */
  ideas: { en: string[]; he: string[] };
}

const ALL = ["images", "video", "image-editor", "nodes", "unreal", "unity", "voice", "day", "pages", "knowledge", "browser", "watch", "pipelines", "compare", "community"];

export const ROLES: RoleDefinition[] = [
  {
    id: "developer",
    icon: "💻",
    title: { en: "Developer", he: "מפתח/ת" },
    description: { en: "Code sessions, your projects, the browser and the computer", he: "סשנים של קוד, הפרויקטים שלך, הדפדפן והמחשב" },
    parts: ["pages", "knowledge", "browser", "watch", "pipelines", "compare", "images", "community"],
    ideas: {
      en: ["Build me a calculator with buttons as an .exe", "Look at my project and suggest improvements", "Write tests for this function", "Explain this error to me"],
      he: ["בנה לי מחשבון עם כפתורים כקובץ exe.", "תסתכל על הפרויקט שלי ותציע שיפורים", "תכתוב בדיקות לפונקציה הזאת", "תסביר לי את השגיאה הזאת"],
    },
  },
  {
    id: "gamedev",
    icon: "🎮",
    title: { en: "Game developer", he: "מפתח/ת משחקים" },
    description: { en: "Unreal and Unity graphs, pictures, music and 3D for your game", he: "גרפים של Unreal ו-Unity, תמונות, מוזיקה ותלת-ממד למשחק" },
    parts: ["images", "image-editor", "nodes", "unreal", "unity", "pages", "knowledge", "voice", "compare", "community"],
    ideas: {
      en: ["Make a pixel-art sprite of a knight", "Make a 30-second battle theme", "On BeginPlay, open the door when the player is near", "Turn this picture into a 3D model"],
      he: ["צייר ספרייט פיקסל-ארט של אביר", "תכין מוזיקת קרב של 30 שניות", "ב-BeginPlay תפתח את הדלת כשהשחקן קרוב", "תהפוך את התמונה הזאת למודל תלת-ממד"],
    },
  },
  {
    id: "artist",
    icon: "🎨",
    title: { en: "Artist or designer", he: "אמן/ית או מעצב/ת" },
    description: { en: "Pictures, the image editor, ComfyUI nodes and video", he: "תמונות, עורך התמונות, הנודים של ComfyUI ווידאו" },
    parts: ["images", "video", "image-editor", "nodes", "pages", "voice", "community"],
    ideas: {
      en: ["Paint a lighthouse at sunset, oil painting", "Make five logo ideas for a coffee shop", "Remove the background from my picture", "A short clip of waves on rocks"],
      he: ["צייר מגדלור בשקיעה, ציור שמן", "תן חמישה רעיונות ללוגו של בית קפה", "תוריד את הרקע מהתמונה שלי", "סרטון קצר של גלים על סלעים"],
    },
  },
  {
    id: "modeler",
    icon: "🧊",
    title: { en: "3D artist or modeler", he: "תלת-ממדיסט/ית או מודליסט/ית" },
    description: { en: "3D models from a picture or text, textures and reference pictures", he: "מודלים בתלת-ממד מתמונה או מטקסט, טקסטורות ותמונות רפרנס" },
    parts: ["images", "image-editor", "nodes", "unreal", "unity", "pages", "community"],
    ideas: {
      en: ["Turn this picture into a 3D model", "Make a seamless stone texture", "Draw a front and side view of a robot for modeling", "Make a low-poly tree model"],
      he: ["תהפוך את התמונה הזאת למודל תלת-ממד", "תכין טקסטורת אבן שחוזרת על עצמה", "צייר מבט חזית וצד של רובוט למידול", "תכין מודל של עץ בלואו-פולי"],
    },
  },
  {
    id: "sound",
    icon: "🎧",
    title: { en: "Sound or music creator", he: "יוצר/ת סאונד או מוזיקה" },
    description: { en: "Music, sound effects, voice and speech to text", he: "מוזיקה, אפקטים קוליים, קול ותמלול" },
    parts: ["nodes", "voice", "pages", "knowledge", "community"],
    ideas: {
      en: ["Make a 30-second calm piano loop", "Make lyrics for a summer song", "Write down what is said in this recording", "Read this script aloud in a deep voice"],
      he: ["תכין לופ פסנתר רגוע של 30 שניות", "תכתוב מילים לשיר קיץ", "תמלל לי את ההקלטה הזאת", "תקריא את התסריט הזה בקול עמוק"],
    },
  },
  {
    id: "youtuber",
    icon: "📹",
    title: { en: "YouTuber or video creator", he: "יוטיובר/ית או יוצר/ת וידאו" },
    description: { en: "Scripts, thumbnails, short clips, music and voice-over", he: "תסריטים, תמונות ממוזערות, קליפים קצרים, מוזיקה וקריינות" },
    parts: ["video", "images", "image-editor", "nodes", "voice", "pages", "knowledge", "browser", "community"],
    ideas: {
      en: ["Write a script for a 5-minute video about local AI", "Make a thumbnail for my video", "Give me ten titles for a video", "Make background music for an intro"],
      he: ["תכתוב תסריט לסרטון של 5 דקות על AI מקומי", "תכין תמונה ממוזערת לסרטון", "תן לי עשר כותרות לסרטון", "תכין מוזיקת רקע לפתיח"],
    },
  },
  {
    id: "writer",
    icon: "✍️",
    title: { en: "Writer or content creator", he: "כותב/ת או יוצר/ת תוכן" },
    description: { en: "Documents, your notes and sources, voice", he: "מסמכים, הפתקים והמקורות שלך, קול" },
    parts: ["pages", "knowledge", "voice", "day", "browser", "compare", "images", "community"],
    ideas: {
      en: ["Write a blog post about local AI", "Turn my notes into an article", "Read this aloud to me", "Give me ten titles for a video"],
      he: ["כתוב פוסט לבלוג על בינה מלאכותית מקומית", "תהפוך את הפתקים שלי למאמר", "תקריא לי את זה", "תן לי עשר כותרות לסרטון"],
    },
  },
  {
    id: "business",
    icon: "💼",
    title: { en: "Manager or business", he: "מנהל/ת או עסק" },
    description: { en: "Meetings, your day, documents and routines that run by themselves", he: "פגישות, היום שלך, מסמכים ומשימות שרצות לבד" },
    parts: ["day", "pages", "knowledge", "pipelines", "browser", "voice", "compare"],
    ideas: {
      en: ["Summarize today's meeting", "Draft an email to the team about the deadline", "Every morning, sum up my calendar", "Make a one-page plan for the launch"],
      he: ["סכם לי את הפגישה של היום", "נסח מייל לצוות על הדדליין", "כל בוקר תסכם לי את היומן", "תכין תוכנית של עמוד אחד להשקה"],
    },
  },
  {
    id: "student",
    icon: "🎓",
    title: { en: "Student", he: "סטודנט/ית" },
    description: { en: "Learning, summaries, your materials, voice", he: "למידה, סיכומים, החומרים שלך, קול" },
    parts: ["pages", "knowledge", "voice", "compare", "images", "community"],
    ideas: {
      en: ["Explain photosynthesis simply", "Quiz me on chapter 3", "Summarize this PDF in ten lines", "Help me plan my exam week"],
      he: ["תסביר לי פוטוסינתזה בפשטות", "תבחן אותי על פרק 3", "סכם לי את ה-PDF הזה בעשר שורות", "תעזור לי לתכנן את שבוע המבחנים"],
    },
  },
  {
    id: "other",
    icon: "✨",
    title: { en: "Something else", he: "משהו אחר" },
    description: { en: "Start with everything on, turn off what you do not need", he: "הכל פעיל, ומכבים את מה שלא צריך" },
    parts: ALL,
    ideas: {
      en: ["Build me a calculator with buttons as an .exe", "Paint a lighthouse at sunset", "Look at my project and suggest improvements", "Explain how a local AI model works"],
      he: ["בנה לי מחשבון עם כפתורים כקובץ exe.", "צייר מגדלור בשקיעה", "תסתכל על הפרויקט שלי ותציע שיפורים", "הסבר איך עובד מודל AI מקומי"],
    },
  },
];

/**
 * @param roleIds - One role id, several joined with commas, or a list.
 * @returns For every part, whether it starts on for any of those roles (no known role: all on).
 */
export function partsForRole(roleIds: string | string[] | undefined): Record<string, boolean> {
  const ids = Array.isArray(roleIds) ? roleIds : (roleIds ?? "").split(",").filter(Boolean);
  const roles = ROLES.filter((r) => ids.includes(r.id));
  return Object.fromEntries(ALL.map((id) => [id, !roles.length || roles.some((r) => r.parts.includes(id))]));
}
