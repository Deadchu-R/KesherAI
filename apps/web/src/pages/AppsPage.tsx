import { useState } from "react";
import { PARTS } from "@kesher/shared";
import { getLocale, t } from "../i18n";
import { NAV_GROUPS, NAV_ICONS, usePins } from "../Sidebar";
import { setParts, useParts } from "../parts";
import { usePluginUi } from "../plugins";
import { toast } from "../library";

const pick = <T,>(v: { en: T; he: T }) => (getLocale() === "he" ? v.he : v.en);

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
  const partOf = (href: string) => parts.find((p) => p.pages.some((x) => href === x || href.startsWith(`${x}/`))) ?? parts.find((p) => p.plugin && href.startsWith(`#/p/${p.plugin}/`));
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: [
      ...g.items.map(([href, key]) => {
        const part = partOf(href);
        return { href, label: t(key), icon: NAV_ICONS[href] ?? "•", desc: part ? pick(part.description) : "", part };
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
          <h2>{g.icon} {t(g.label)}</h2>
          <div className="apps-grid">
            {g.items.map((i) => {
              const off = i.part && !i.part.on;
              const pinned = pins.includes(i.href);
              return (
                <div key={i.href} className={`app-tile${off ? " off" : ""}`}>
                  <a href={off ? undefined : i.href} className="app-tile-main" aria-disabled={off || undefined} onClick={(e) => off && e.preventDefault()}>
                    <span className="app-tile-icon" aria-hidden="true">{i.icon}</span>
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
