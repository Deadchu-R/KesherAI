import { useState } from "react";
import { PARTS } from "@kesher/shared";
import { getLocale, t } from "../i18n";
import { NAV_GROUPS, NAV_ICONS, usePins } from "../Sidebar";
import { setParts, useParts } from "../parts";
import { usePluginUi } from "../plugins";
import { toast } from "../library";
import { orderGroups, useAppearance } from "../appearance";
import { ToolIcon } from "../ToolIcon";
import { Glyph } from "../ui/Glyph";

const pick = <T,>(v: { en: T; he: T }) => (getLocale() === "he" ? v.he : v.en);

/** One line for a page that is not its part's main page (those take the part's own line), or has no part. */
const PAGE_LINES: Record<string, { he: string; en: string }> = {
  "#/canvas": { he: "לוח ציור משותף לך ולמודל: תרשימים, סקיצות ותרשימי זרימה.", en: "A board you and the model both draw on: diagrams, sketches, flowcharts." },
  "#/batch": { he: "אותה פעולה על הרבה תמונות בבת אחת.", en: "The same change on many pictures at once." },
  "#/training": { he: "לימוד סגנון או דמות משלך למודל התמונות (LoRA).", en: "Teach the image model your own style or character (a LoRA)." },
  "#/libraries": { he: "ספריות ידע מוכנות להורדה: תיעוד של מנועים, שפות וכלים.", en: "Ready-made knowledge to download: docs of engines, languages and tools." },
  "#/inbox": { he: "אישורים שמחכים לך, והודעות מהסוכנים.", en: "Approvals waiting for you, and notes from the agents." },
  "#/self-work": { he: "KesherAI עובד לבד על פרויקט קוד, משימה אחרי משימה.", en: "KesherAI works on a code project by itself, task after task." },
  "#/personas": { he: "דמויות עם הוראות, מודל וסגנון משלהן.", en: "Characters with their own instructions, model and style." },
  "#/memory": { he: "מה שהמודלים זוכרים עליך, לקריאה ולעריכה.", en: "What the models remember about you, to read and edit." },
  "#/prompts": { he: "בקשות שמורות לשימוש חוזר, עם פקודת /.", en: "Saved requests to use again, with a / command." },
  "#/usage": { he: "כמה השתמשת בכל מודל, ועצות לשימוש טוב יותר.", en: "How much each model was used, and tips for using them better." },
  "#/models": { he: "הורדה, טעינה והשוואה של מודלים לכל סוג עבודה.", en: "Download, load and compare models for every kind of work." },
  "#/connections": { he: "שירותי ענן, שרתים מקומיים, MCP והמכשירים שלך.", en: "Cloud services, local servers, MCP and your devices." },
  "#/plugins": { he: "תוספות שמרחיבות את KesherAI, ושינויי מראה.", en: "Add-ons that extend KesherAI, and changes to its look." },
  "#/parts": { he: "הפעלה וכיבוי של חלקים שלמים, כדי שיישאר רק מה שצריך.", en: "Turn whole parts on and off, to keep only what you need." },
  "#/health": { he: "מצב הזיכרון, הדיסק וכרטיס המסך, ומה אפשר לשחרר.", en: "Memory, disk and graphics card, and what can be freed." },
  "#/remote": { he: "לראות ולהפעיל את המחשב הזה מהטלפון.", en: "See and use this computer from the phone." },
  "#/updates": { he: "הגרסה המותקנת, מה חדש, והתקנת עדכון.", en: "The installed version, what is new, and installing an update." },
  "#/settings": { he: "כל ההגדרות, מסודרות לפי נושא.", en: "Every setting, by subject." },
};

/**
 * All tools, like a launcher (Raycast's, a phone's app library): every page
 * in its group with an icon and one line, a star to pin it to the sidebar,
 * and parts that are off shown greyed with "Turn on".
 */
export function AppsPage() {
  const [q, setQ] = useState("");
  const [pins, togglePin] = usePins();
  const { parts } = useParts();
  const { pages } = usePluginUi();
  const look = useAppearance();
  const partOf = (href: string) => parts.find((p) => p.pages.some((x) => href === x || href.startsWith(`${x}/`))) ?? parts.find((p) => p.plugin && href.startsWith(`#/p/${p.plugin}/`));
  const groups = orderGroups(NAV_GROUPS, look).map((g) => ({
    ...g,
    items: [
      ...g.items.map(([href, key]) => {
        const part = partOf(href);
        // The part's line only on its main page; its other pages (and pages with no part) have their own.
        const line = PAGE_LINES[href];
        return { href, label: t(key), icon: NAV_ICONS[href] ?? "•", desc: line ? pick(line) : part && part.pages[0] === href ? pick(part.description) : "", part };
      }),
      ...(g.id === "create"
        ? pages.map((p) => {
            const href = `#/p/${p.pluginId}/${p.id}`;
            const part = partOf(href);
            return { href, label: p.title, icon: p.icon ?? "🧷", desc: part ? pick(part.description) : "", part };
          })
        : []),
    ].filter((i) => !q.trim() || `${i.label} ${i.desc}`.toLowerCase().includes(q.trim().toLowerCase())),
  })).filter((g) => g.items.length);
  // Parts with no page of their own (video, voice, browser) are listed too, so they can be turned on here.
  const background = PARTS.filter((p) => !p.pages.length && !p.plugin).map((p) => parts.find((x) => x.id === p.id)).filter((p): p is NonNullable<typeof p> => !!p);

  const turnOn = async (id: string) => {
    try {
      await setParts({ parts: { [id]: true } });
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="page apps-page">
      <h1>{t("allTools")}</h1>
      <p className="muted">{t("toolsIntro")}</p>
      <input className="apps-search" type="search" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("toolsSearch")} aria-label={t("toolsSearch")} />
      {groups.map((g) => (
        <section key={g.id} className="apps-group">
          <h2><Glyph of={g.icon} /> {t(g.label)}</h2>
          <div className="apps-grid">
            {g.items.map((i) => {
              const off = i.part && !i.part.on;
              const pinned = pins.includes(i.href);
              return (
                <div key={i.href} className={`app-tile${off ? " off" : ""}`}>
                  <a href={off ? undefined : i.href} className="app-tile-main" aria-disabled={off || undefined} onClick={(e) => off && e.preventDefault()}>
                    <span className="app-tile-icon" aria-hidden="true"><ToolIcon href={i.href} fallback={i.icon} /></span>
                    <span className="app-tile-text">
                      <b>{i.label}</b>
                      {i.desc && <small>{i.desc}</small>}
                    </span>
                  </a>
                  {off ? (
                    <button type="button" className="app-tile-on" onClick={() => void turnOn(i.part!.id)}>{t("toolTurnOn")}</button>
                  ) : (
                    <button type="button" className={`app-tile-pin${pinned ? " on" : ""}`} aria-pressed={pinned} title={pinned ? t("unpinTool") : t("pinTool")} aria-label={pinned ? t("unpinTool") : t("pinTool")} onClick={() => togglePin(i.href)}>{pinned ? "★" : "☆"}</button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {!q.trim() && background.length > 0 && (
        <section className="apps-group">
          <h2>⚡ {getLocale() === "he" ? "יכולות בצ'אט" : "In your chats"}</h2>
          <div className="apps-grid">
            {background.map((p) => (
              <div key={p.id} className={`app-tile${p.on ? "" : " off"}`}>
                <span className="app-tile-main">
                  <span className="app-tile-icon" aria-hidden="true">{p.icon}</span>
                  <span className="app-tile-text">
                    <b>{pick(p.title)}</b>
                    <small>{pick(p.description)}</small>
                  </span>
                </span>
                {!p.on && <button type="button" className="app-tile-on" onClick={() => void turnOn(p.id)}>{t("toolTurnOn")}</button>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
