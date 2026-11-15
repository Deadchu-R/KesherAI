import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { shareBase, untilText, type ShareInfo } from "../chat/ShareDialog";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** Settings → Phone: every chat shared as a page (shares.ts), how often it was opened, and stopping each one. */
export function SharesSection() {
  const [list, setList] = useState<Array<ShareInfo & { convId: string }> | null>(null);
  const [base, setBase] = useState("");
  const load = () => void api<{ shares: Array<ShareInfo & { convId: string }> }>("/api/shares").then((r) => setList(r.shares), () => setList([]));
  useEffect(() => {
    load();
    void shareBase().then((w) => setBase(w.base));
  }, []);
  if (!list?.length) return null;
  const stop = (id: string) => void api(`/api/shares/${id}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message));
  return (
    <section className="card stack">
      <h2>{L("שיחות ששיתפת", "Shared chats")}</h2>
      <p className="muted small">{L("כל קישור פותח דף לקריאה בלבד. הפסקת שיתוף סוגרת את הקישור מיד.", "Each link opens a read-only page. Stopping a share closes its link at once.")}</p>
      <ul className="stack shares-list">
        {list.map((s) => (
          <li key={s.id} className="row">
            <a className="grow" href={`#/c/${s.convId}`} dir="auto">{s.title}</a>
            <span className="muted small">{L(`נפתח ${s.views} פעמים · ${untilText(s.expiresAt)}`, `opened ${s.views} times · ${untilText(s.expiresAt)}`)}</span>
            <button type="button" className="ghost small" onClick={() => void navigator.clipboard?.writeText(`${base}${s.path}`).then(() => toast(L("הקישור הועתק", "Link copied")))}>{L("העתק", "Copy")}</button>
            <button type="button" className="danger-btn small" onClick={() => stop(s.id)}>{L("הפסק", "Stop")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
