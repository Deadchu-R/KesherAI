import { useState } from "react";
import { getLocale } from "../i18n";
import { setParts, useParts } from "../parts";
import { refreshPluginUi } from "../plugins";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Settings → Parts: every part of KesherAI besides the chat, on or off.
 * Off parts leave the menu and stop running in the background; turning one
 * on downloads what it needs.
 */
export function PartsPage() {
  const { parts } = useParts();
  const [busy, setBusy] = useState("");
  const he = getLocale() === "he";
  const change = async (body: Parameters<typeof setParts>[0], key: string) => {
    setBusy(key);
    try {
      await setParts(body);
      await refreshPluginUi();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const turn = (id: string, on: boolean, gb: number) => {
    if (on && gb >= 1 && !confirm(L(`להדליק? זה מוריד כ-${gb} GB (אפשר לעקוב בעיגול ההורדות).`, `Turn it on? It downloads about ${gb} GB (follow it in the downloads circle).`))) return;
    void change({ parts: { [id]: on } }, id);
  };
  return (
    <div className="page">
      <h1>{L("חלקי KesherAI", "Parts of KesherAI")}</h1>
      <p className="muted">{L("הצ'אט תמיד כאן. כל השאר הוא חלק שאפשר להדליק ולכבות: חלק כבוי יוצא מהתפריט, הכלים שלו לא מוצעים למודלים, ומה שהוא מריץ ברקע נעצר, כך שהוא לא תופס זיכרון. כשמדליקים חלק הוא מוריד את מה שהוא צריך ומתעדכן לבד.", "The chat is always here. Everything else is a part you can turn on and off: a part that is off leaves the menu, its tools are not offered to the models, and what it runs in the background stops, so it takes no memory. A part you turn on downloads what it needs and updates by itself.")}</p>
      <div className="row">
        <button type="button" disabled={!!busy} onClick={() => void change({ preset: "chat" }, "chat")}>{L("צ'אט בלבד (לכבות הכל)", "Only the chat (turn everything off)")}</button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => {
            const gb = parts.filter((p) => !p.on).reduce((n, p) => n + p.downloadGb, 0);
            if (gb >= 1 && !confirm(L(`להדליק הכל? זה מוריד כ-${gb.toFixed(0)} GB.`, `Turn everything on? It downloads about ${gb.toFixed(0)} GB.`))) return;
            void change({ preset: "all" }, "all");
          }}
        >{L("להדליק הכל", "Turn everything on")}</button>
      </div>
      <div className="parts-grid">
        {parts.map((p) => (
          <label key={p.id} className={`card part${p.on ? " on" : ""}`}>
            <div className="row">
              <span className="part-icon" aria-hidden>{p.icon}</span>
              <strong className="grow">{he ? p.title.he : p.title.en}</strong>
              <input type="checkbox" role="switch" checked={p.on} disabled={busy === p.id} onChange={(e) => turn(p.id, e.target.checked, p.downloadGb)} aria-label={he ? p.title.he : p.title.en} />
            </div>
            <span className="muted small">{he ? p.description.he : p.description.en}</span>
            {p.downloadGb > 0 && <span className="muted small">{L(`מוריד כשמדליקים: כ-${p.downloadGb} GB`, `Downloads when turned on: about ${p.downloadGb} GB`)}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
