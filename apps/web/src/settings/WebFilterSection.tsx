import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Filter { safeSearch: "strict" | "moderate" | "off"; onion: boolean; blocked: string[] }

/**
 * Settings → Web: the user's own filter for the model's web search in every chat: the search engine's safe search
 * (strict, moderate, off), dark web (.onion) sites through Tor (off by default), and sites never used. Changed on
 * the computer; the phone shows it.
 */
export function WebFilterSection() {
  const [f, setF] = useState<Filter | null>(null);
  const [blocked, setBlocked] = useState("");
  const [tor, setTor] = useState(false);
  useEffect(() => {
    void api<Filter>("/api/web-filter").then((x) => { setF(x); setBlocked(x.blocked.join("\n")); }, () => undefined);
    void api<{ installed: boolean }>("/api/tor").then((t) => setTor(t.installed), () => undefined);
  }, []);
  if (!f) return null;
  const remote = isRemote();
  const save = (next: Partial<Filter>) =>
    void api<Filter>("/api/web-filter", { method: "PUT", body: { ...f, ...next } }).then((x) => { setF(x); setBlocked(x.blocked.join("\n")); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  return (
    <section className="card stack">
      <h2>{L("חיפוש באינטרנט: סינון", "Web search: filtering")}</h2>
      <p className="muted">{L("חל על החיפוש והקריאה של המודל בכל הצ'אטים. לכל צ'אט יש גם הגדרות משלו (⚙ ליד הגלובוס).", "Applies to the model's web search and reading in every chat. Each chat has its own settings too (⚙ beside the globe).")}</p>
      <fieldset className="stack small" disabled={remote}>
        <legend>{L("חיפוש בטוח (של מנוע החיפוש)", "Safe search (the search engine's)")}</legend>
        {([["strict", L("מחמיר", "Strict")], ["moderate", L("רגיל (ברירת מחדל)", "Moderate (default)")], ["off", L("כבוי — בלי סינון של מנוע החיפוש", "Off: no filtering by the search engine")]] as const).map(([v, label]) => (
          <label key={v} className="check"><input type="radio" name="safe" checked={f.safeSearch === v} onChange={() => save({ safeSearch: v })} />{label}</label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={f.onion} disabled={remote} onChange={(e) => save({ onion: e.target.checked })} />
        {L("לאפשר אתרי .onion (Dark Web) דרך Tor", "Allow .onion (dark web) sites through Tor")}
      </label>
      {f.onion && !tor && <p className="muted small">{L("צריך להתקין Tor: בהגדרות החיפוש של צ'אט (⚙ ליד הגלובוס).", "Tor is needed: install it from a chat's web settings (⚙ beside the globe).")}</p>}
      {f.onion && <p className="muted small">{L("שימו לב: באתרים כאלה יש גם תוכן בלתי חוקי ומסוכן. המודל עדיין מסרב לדברים לא חוקיים, והאחריות על השימוש שלכם.", "Note: such sites also hold illegal and dangerous content. The model still refuses illegal things, and how it is used is up to you.")}</p>}
      <label className="stack small">
        {L("אתרים חסומים — אף צ'אט לא מחפש בהם ולא פותח אותם (שורה לכל אתר)", "Blocked sites: no chat searches or opens them (one per line)")}
        <textarea dir="ltr" rows={4} value={blocked} disabled={remote} onChange={(e) => setBlocked(e.target.value)} placeholder={"example.com\nreddit.com"} />
      </label>
      {!remote && <button type="button" style={{ alignSelf: "start" }} onClick={() => save({ blocked: blocked.split(/[\s,]+/).filter(Boolean) })}>{L("שמור את רשימת החסומים", "Save the blocked list")}</button>}
      {remote && <p className="muted small">{L("משנים את זה במחשב.", "Changed on the computer.")}</p>}
    </section>
  );
}
