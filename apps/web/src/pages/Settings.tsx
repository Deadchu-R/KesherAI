/**
 * The Settings page: categories on the side (chips on a phone), one search over all of them, and the sections
 * they hold. `SETTINGS_CATS` is the map of what lives where; every section is its own component next to it (GuardSection,
 * NotificationsSection…). Research behind the order: docs/RESEARCH_LOG.md.
 */
import { ActiveModels } from "../settings/ActiveModels";
import { GoogleDriveSection } from "../settings/GoogleDriveSection";
import { ImportChats } from "../ImportChats";
import { ImportPeopleChats } from "../ImportPeopleChats";
import { OneDriveSection } from "../settings/OneDriveSection";
import { Sync } from "../settings/Sync";
import { ComputersSection } from "../ComputersSection";
import { AppearanceSection } from "../AppearanceSection";
import { ResetSection } from "../ResetSection";
import { TelegramSection } from "../TelegramSection";
import { AccessLogSection, DeviceKeysSection } from "../AccessLogSection";
import { SpeechSection } from "../SpeechSection";
import { AccessibilitySection } from "../Speak";
import { ComputerSection } from "../ComputerSection";
import { GpuSection } from "../GpuSection";
import { GuardSection } from "../GuardSection";
import { BusinessSection, CopilotSection } from "../BusinessSection";
import { openWelcome } from "../Welcome";
import { NotificationsSection } from "../NotificationsSection";
import { McpServerSection } from "../McpServerSection";
import { PhoneTargetsSection } from "../PhoneTargetsSection";
import { BrowserSection, BrowserSitesSection } from "../BrowserSection";
import { ApiKeysSection } from "../ApiKeysSection";
import { PermissionsSection } from "../settings/PermissionsSection";
import { WebFilterSection } from "../settings/WebFilterSection";
import { ChatBarSection } from "../ChatBar";
import { NoctaliaSection } from "../settings/NoctaliaSection";
import { PhoneSection } from "../settings/PhoneSection";
import { useEffect, useState } from "react";
import { isRemote } from "../api";
import { getLocale, t } from "../i18n";
import { ChatsAtOnce } from "../ChatsAtOnce";


/**
 * The settings in categories; only the open one is drawn (and asks the computer anything). Ordered from research
 * (Open WebUI 0.11, LM Studio, Msty, Jan; see docs/RESEARCH_LOG.md): everyday choices first, one category per
 * subject (notifications and privacy got their own instead of "General" holding everything), data and reset
 * last, and one search over every setting by its words.
 */
const SETTINGS_CATS: Array<{ id: string; icon: string; en: string; he: string; words: string; render: () => React.ReactNode }> = [
  { id: "general", icon: "⚙", en: "General", he: "כללי", words: "model models default chat image voice speech microphone read aloud מודל מודלים ברירת מחדל צאט קול דיבור הקראה מיקרופון", render: () => <><ActiveModels /><SpeechSection /></> },
  { id: "chats", icon: "💬", en: "Chats", he: "צ'אטים", words: "chat buttons bar toolbar show hide steps browser files coach context team group כפתורים צאט סרגל להציג להסתיר שלבים דפדפן קבצים מאמן הקשר צוות", render: () => <ChatBarSection /> },
  { id: "notifications", icon: "🔔", en: "Notifications", he: "התראות", words: "notifications phone push ntfy approve deny waiting done התראות פוש אישור דחייה מחכה הסתיים טלפון", render: () => <NotificationsSection /> },
  { id: "appearance", icon: "🎨", en: "Appearance and accessibility", he: "מראה ונגישות", words: "theme dark light colors font size language rtl accessibility contrast motion ערכת נושא כהה בהיר צבעים גופן גודל שפה נגישות ניגודיות תנועה", render: () => <><AppearanceSection /><AccessibilitySection /></> },
  { id: "computer", icon: "🖥", en: "Computer and graphics card", he: "המחשב וכרטיס המסך", words: "noctalia waybar bar linux desktop נוקטליה בר לינוקס parallel chats at once slots context במקביל צאטים שיחות הקשר gpu graphics card vram temperature unload idle minutes ram cpu limit guard performance כרטיס מסך טמפרטורה פריקה לפרוק דקות זיכרון מעבד הגבלה ביצועים עומס", render: () => <><GpuSection /><ChatsAtOnce card /><GuardSection /><NoctaliaSection /></> },
  { id: "privacy", icon: "🛡", en: "Privacy and permissions", he: "פרטיות והרשאות", words: "permissions always allow approve rules computer control screen mouse access log privacy web search safe search censorship blocked sites onion dark web tor חיפוש סינון צנזורה אתרים חסומים דארק ווב הרשאות תמיד לאשר כללים שליטה במחשב מסך עכבר יומן גישה פרטיות", render: () => <><PermissionsSection /><WebFilterSection /><ComputerSection /></> },
  { id: "phone", icon: "📱", en: "Phone and remote access", he: "טלפון וגישה מרחוק", words: "phone remote anywhere tunnel qr pair device keys tailscale telegram computers start with computer access log טלפון מרחוק מכל מקום מנהרה קוד סריקה מכשירים מפתחות טלגרם מחשבים הפעלה עם המחשב יומן גישה", render: () => <><PhoneSection /><DeviceKeysSection /><ComputersSection /><TelegramSection /><AccessLogSection /></> },
  { id: "accounts", icon: "☁", en: "Accounts, backup and data", he: "חשבונות, גיבוי ונתונים", words: "google drive onedrive sync backup import chats chatgpt claude whatsapp instagram ווטסאפ וואטסאפ אינסטגרם reset delete data גוגל דרייב סנכרון גיבוי ייבוא שיחות איפוס מחיקה נתונים", render: () => <><GoogleDriveSection /><OneDriveSection /><Sync /><ImportChats /><ImportPeopleChats /><ResetSection /></> },
  { id: "business", icon: "🏢", en: "Organisation", he: "ארגון", words: "business organisation copilot team policy ארגון עסקי צוות מדיניות", render: () => <><CopilotSection /><BusinessSection /></> },
  { id: "developers", icon: "🔧", en: "For developers", he: "למפתחים", words: "developer mcp server api keys browser sites אתרים extension phone targets מפתחים שרת מפתחות api תוסף דפדפן", render: () => <><McpServerSection /><PhoneTargetsSection /><BrowserSitesSection /><BrowserSection /><ApiKeysSection />{isRemote() && <section className="card"><p className="muted small">{getLocale() === "he" ? "מפתחות גישה לאפליקציות ומפתח התוסף לדפדפן מוצגים רק במחשב עצמו: הם סודות שפותחים את KesherAI." : "App access keys and the browser extension's key are shown only on the computer itself: they are secrets that open KesherAI."}</p></section>}</> },
];
/** Old links keep working after the reorganisation. */
const MOVED: Record<string, string> = { accessibility: "appearance" };

/** Settings: categories on the side (chips on a phone), `#/settings/<category>`, and a search over all of them. */
export function SettingsPage() {
  const he = getLocale() === "he";
  const fromHash = () => {
    const id = location.hash.replace(/^#\/settings\/?/, "").split(/[/?#]/)[0] || "general";
    return MOVED[id] ?? id;
  };
  const [cat, setCat] = useState(fromHash);
  const [q, setQ] = useState("");
  useEffect(() => {
    const on = () => setCat(fromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const current = SETTINGS_CATS.find((c) => c.id === cat) ?? SETTINGS_CATS[0]!;
  // Every word typed must appear in a category's name or words (Hebrew or English).
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = terms.length ? SETTINGS_CATS.filter((c) => terms.every((w) => `${c.he} ${c.en} ${c.words}`.toLowerCase().includes(w))) : [];
  return (
    <div className="page settings-page">
      <div className="row"><h1 className="grow">{t("settings")}</h1><button type="button" onClick={openWelcome}>{he ? "הצג את מסך הפתיחה שוב" : "Show the welcome again"}</button></div>
      <div className="settings-search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={he ? "חיפוש בהגדרות (למשל: פריקה, התראות, טלפון)" : "Search settings (e.g. unload, notifications, phone)"} aria-label={he ? "חיפוש בהגדרות" : "Search settings"} />
        {terms.length > 0 && (
          <div className="settings-found" role="list">
            {found.length === 0 && <p className="muted small">{he ? "לא נמצאה הגדרה כזו. נסו מילה אחרת." : "No setting matches. Try another word."}</p>}
            {found.map((c) => (
              <a key={c.id} role="listitem" href={`#/settings/${c.id}`} onClick={() => setQ("")}>
                <span aria-hidden="true">{c.icon}</span> {he ? c.he : c.en}
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="settings-layout">
        <nav className="settings-cats" aria-label={t("settings")}>
          {SETTINGS_CATS.map((c) => (
            <a key={c.id} href={`#/settings/${c.id}`} aria-current={c.id === current.id ? "page" : undefined}>
              <span aria-hidden="true">{c.icon}</span> {he ? c.he : c.en}
            </a>
          ))}
        </nav>
        <div className="settings-body" key={current.id}>{current.render()}</div>
      </div>
    </div>
  );
}



