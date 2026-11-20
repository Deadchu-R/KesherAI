import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { LineIcon } from "./ui/Glyph";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One piece of work the last close cut off (packages/core/src/resume-board.ts). */
export interface ResumeItem {
  id: string;
  kind: "chat" | "media" | "render" | "helper" | "inbox" | "self-work" | "download" | "engine-sync";
  title: string;
  detail?: string;
  at: string;
  /** It continues by itself: only Drop (stop) is offered. */
  auto: boolean;
  link?: string;
}

/** Each kind's icon and words. */
const KIND: Record<ResumeItem["kind"], { icon: string; he: string; en: string }> = {
  chat: { icon: "chat", he: "צ׳אט באמצע עבודה", en: "Chat in the middle of work" },
  media: { icon: "image", he: "עבודת מדיה", en: "Media job" },
  render: { icon: "play", he: "רינדור", en: "Render" },
  helper: { icon: "bot", he: "סוכן עזר", en: "Helper" },
  inbox: { icon: "clipboard", he: "משימה מתיבת המשימות", en: "Task inbox run" },
  "self-work": { icon: "wrench", he: "עבודה עצמית", en: "Self-work" },
  download: { icon: "download", he: "הורדה", en: "Download" },
  "engine-sync": { icon: "gamepad", he: "סנכרון מנוע", en: "Engine sync" },
};

/**
 * Words for a card row: what kind it is and where it stood (the tool, the engine).
 *
 * @param i - The item.
 * @returns The line under its title.
 */
export function resumeLine(i: Pick<ResumeItem, "kind" | "detail" | "auto">): string {
  const k = KIND[i.kind];
  const kind = L(k.he, k.en);
  const state = i.auto ? L("ממשיך לבד", "continues by itself") : L("ממתין לך", "waits for you");
  return [kind, i.detail, state].filter(Boolean).join(" · ");
}

/**
 * After a restart or an update, once: "Continue what was running", every piece of work the close cut off with
 * Continue and Drop per item (the ones that continue by themselves offer Drop only). The same card on the computer
 * and on the phone in remote; it reads the server, so acting on one side clears it on the other. Hidden until the
 * next start with "Later".
 */
export function ResumeCard() {
  const [items, setItems] = useState<ResumeItem[]>([]);
  const [reason, setReason] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [later, setLater] = useState(() => {
    try { return sessionStorage.getItem("kesherai-resume-later") === "1"; } catch { return false; }
  });
  const load = () => void api<{ reason?: string; items: ResumeItem[] }>("/api/resume").then((r) => { setItems(r.items); setReason(r.reason); }, () => undefined);
  useEffect(() => {
    load();
    // The phone may act on it too: look again when this window comes back.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  if (later || !items.length) return null;
  const act = async (id: string, action: "continue" | "drop") => {
    setBusy(id);
    setError(undefined);
    try {
      await api(`/api/resume/${encodeURIComponent(id)}`, { method: "POST", body: { action } });
      setItems((list) => list.filter((i) => i.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const dropWaiting = async () => {
    setBusy("*");
    await api("/api/resume/drop-waiting", { method: "POST" }).catch(() => undefined);
    setBusy(undefined);
    load();
  };
  const hide = () => {
    try { sessionStorage.setItem("kesherai-resume-later", "1"); } catch { /* storage off: only for now */ }
    setLater(true);
  };
  const why = reason === "update" ? L("העדכון", "The update") : reason === "restart" ? L("ההפעלה מחדש", "The restart") : L("הסגירה", "The close");
  const waiting = items.filter((i) => !i.auto).length;
  return (
    <section className="card stack resume-all" role="region" aria-label={L("המשך את מה שרץ", "Continue what was running")}>
      <div className="row resume-all-head">
        <LineIcon name="refresh" size={18} />
        <b className="grow">{L("המשך את מה שרץ", "Continue what was running")}</b>
        <button type="button" className="ghost small" onClick={hide}>{L("אחר כך", "Later")}</button>
      </div>
      <p className="small muted">{L(`${why} עצר${reason === "update" ? "" : "ה"} את אלה באמצע. שום דבר שלא אתה התחלת לא ירוץ שוב לבד.`, `${why} stopped these in the middle. Nothing you did not start runs again by itself.`)}</p>
      <ul className="resume-list">
        {items.map((i) => (
          <li key={i.id} className="resume-row">
            <span className="resume-icon" aria-hidden><LineIcon name={KIND[i.kind].icon} size={16} /></span>
            <span className="resume-text">
              {i.link ? <a href={i.link} dir="auto">{i.title}</a> : <span dir="auto">{i.title}</span>}
              <span className="small muted" dir="auto">{resumeLine(i)}</span>
            </span>
            <span className="resume-actions">
              {!i.auto && <button type="button" className="primary small" disabled={!!busy} onClick={() => void act(i.id, "continue")}>{L("המשך", "Continue")}</button>}
              <button type="button" className="small" disabled={!!busy} onClick={() => void act(i.id, "drop")}>{i.auto ? L("עצור", "Stop") : L("לא צריך", "Drop")}</button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="error small" dir="auto">{error}</p>}
      {waiting > 1 && <div className="row"><button type="button" className="ghost small" disabled={!!busy} onClick={() => void dropWaiting()}>{L("לא צריך אף אחד מהממתינים", "Drop all waiting")}</button></div>}
    </section>
  );
}
