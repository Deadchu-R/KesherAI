import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Guests {
  people: Array<{ id: string; name: string; role: "read" | "edit"; joinedAt: string; lastSeen: string | null; left: number }>;
  invites: Array<{ id: string; role: "read" | "edit"; createdAt: string; expiresAt: string; usedAt?: string; usedBy?: string }>;
  dailyLimit: number;
  nightAlert: boolean;
}

const ago = (iso: string | null) => {
  if (!iso) return L("עוד לא", "not yet");
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? L("עכשיו", "now") : m < 60 ? L(`לפני ${m} דק׳`, `${m} min ago`) : m < 1440 ? L(`לפני ${Math.round(m / 60)} שע׳`, `${Math.round(m / 60)} h ago`) : L(`לפני ${Math.round(m / 1440)} ימים`, `${Math.round(m / 1440)} days ago`);
};

/**
 * Sharing a project (docs/COLLABORATION.md, design ProjectShare): a one-time invite link (read or read and write,
 * 1 hour to 7 days), who has access with Remove, and the invites not used yet. Only that project: its chats, never
 * Settings, models, other projects or the computer. Guests' chats have no tools and no memory.
 *
 * @param props.projectId - The project.
 * @param props.name - Its name.
 * @param props.onClose - Closes the dialog.
 */
export function ProjectShare({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const [role, setRole] = useState<"read" | "edit">("read");
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState("");
  const [g, setG] = useState<Guests | null>(null);
  const [anywhere, setAnywhere] = useState<string | null | undefined>(undefined);
  const load = useCallback(() => void api<Guests>(`/api/projects/${encodeURIComponent(projectId)}/guests`).then(setG, (e: Error) => toast(e.message)), [projectId]);
  useEffect(() => {
    load();
    void api<{ links: Array<{ url: string; kind: string }> }>("/api/remote/links").then((r) => setAnywhere(r.links.find((l) => l.kind === "anywhere")?.url ?? null), () => setAnywhere(null));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [load, onClose]);
  const make = async () => {
    try {
      const r = await api<{ token: string }>(`/api/projects/${encodeURIComponent(projectId)}/invites`, { method: "POST", body: { role, hours } });
      const base = (anywhere ?? location.origin).replace(/\/$/, "");
      const url = `${base}/#/join/${r.token}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).then(() => toast(L("הקישור הועתק", "Link copied")), () => undefined);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (id: string, who: string) => {
    if (!confirm(L(`להסיר את ${who}? הגישה שלו נעצרת מיד.`, `Remove ${who}? Their access stops at once.`))) return;
    await api(`/api/projects/${encodeURIComponent(projectId)}/guests/${encodeURIComponent(id)}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message));
  };
  const cancel = (id: string) => void api(`/api/projects/${encodeURIComponent(projectId)}/invites/${encodeURIComponent(id)}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message));
  const pending = (g?.invites ?? []).filter((i) => !i.usedAt && Date.parse(i.expiresAt) > Date.now());
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card stack project-share" role="dialog" aria-modal="true" aria-label={L(`שיתוף "${name}"`, `Share "${name}"`)} onClick={(e) => e.stopPropagation()}>
        <strong dir="auto">{L(`שיתוף הפרויקט "${name}"`, `Share the project "${name}"`)}</strong>
        <p className="muted small">{L("רק הפרויקט הזה: הצ'אטים שלו. לא ההגדרות, לא המודלים, לא שאר הפרויקטים ולא המחשב. בצ'אטים של אורחים אין כלים ואין זיכרון.", "Only this project: its chats. Not Settings, models, other projects or the computer. Guests' chats have no tools and no memory.")}</p>

        <b className="small">{L("קישור הזמנה חד-פעמי", "A one-time invite link")}</b>
        <div className="seg-pills" role="radiogroup" aria-label={L("הרשאה", "Access")}>
          {(["read", "edit"] as const).map((r) => <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>{r === "read" ? L("צפייה", "Read") : L("צפייה וכתיבה", "Read and write")}</button>)}
        </div>
        <div className="seg-pills" role="radiogroup" aria-label={L("תוקף", "Works for")}>
          {[[1, L("שעה", "1 hour")], [24, L("יום", "1 day")], [168, L("7 ימים", "7 days")]].map(([h, t]) => <button key={h} type="button" role="radio" aria-checked={hours === h} className={hours === h ? "on" : ""} onClick={() => setHours(h as number)}>{t}</button>)}
        </div>
        {anywhere === null && <p className="muted small">{L("כדי שמישהו מחוץ לבית יוכל להיכנס, צריך להפעיל \"גישה מכל מקום\" (הגדרות ← טלפון). בלי זה הקישור עובד רק ברשת הביתית.", "For someone outside your home to come in, turn on \"Access from anywhere\" (Settings → Phone). Without it the link works on your home network only.")}</p>}
        <button type="button" className="primary" onClick={() => void make()}>{L("צור קישור והעתק", "Make a link and copy it")}</button>
        {link && <input readOnly value={link} dir="ltr" onFocus={(e) => e.target.select()} aria-label={L("קישור ההזמנה", "The invite link")} />}
        <p className="muted small">{L("הראשון שפותח את הקישור כותב את שמו ומקבל גישה; אחר כך הקישור מפסיק לעבוד, ומקבלים התראה.", "The first person to open the link writes their name and gets access; then the link stops working, and you are told.")}</p>

        <b className="small">{L("מי יש לו גישה", "Who has access")}</b>
        {g && g.people.length === 0 && <p className="muted small">{L("עוד אף אחד.", "No one yet.")}</p>}
        {g?.people.map((p) => (
          <div key={p.id} className="card row wrap project-share-person">
            <b className="grow" dir="auto">{p.name.replace(/ \(guest\)$/, "")} · {p.role === "edit" ? L("צפייה וכתיבה", "read and write") : L("צפייה", "read")}</b>
            <span className="muted small">{L("הצטרף", "joined")} {ago(p.joinedAt)} · {L("נראה", "seen")} {ago(p.lastSeen)} · {L(`נשארו היום ${p.left}`, `${p.left} left today`)}</span>
            <button type="button" className="ghost small danger" onClick={() => void remove(p.id, p.name)}>{L("הסר", "Remove")}</button>
          </div>
        ))}
        {pending.length > 0 && (
          <>
            <b className="small">{L("הזמנות שעוד לא נפתחו", "Invites not opened yet")}</b>
            {pending.map((i) => (
              <div key={i.id} className="row wrap small">
                <span className="grow">{i.role === "edit" ? L("צפייה וכתיבה", "Read and write") : L("צפייה", "Read")} · {L("עד", "until")} {new Date(i.expiresAt).toLocaleString()}</span>
                <button type="button" className="ghost small" onClick={() => cancel(i.id)}>{L("בטל", "Cancel")}</button>
              </div>
            ))}
          </>
        )}
        {g && <p className="muted small">{L(`עד ${g.dailyLimit} תשובות ביום לכל אורח (המחשב שלך עונה להם).`, `Up to ${g.dailyLimit} answers a day for each guest (your computer answers them).`)}</p>}
        {g && (
          <label className="row small">
            <input type="checkbox" checked={g.nightAlert} onChange={(e) => void api("/api/guests/settings", { method: "PUT", body: { nightAlert: e.target.checked } }).then(load, (er: Error) => toast(er.message))} />
            <span>{L("התראה כשאורח משתמש בשעות שקטות (23:00–07:00)", "Tell me when a guest uses it in quiet hours (23:00–07:00)")}</span>
          </label>
        )}
        <p className="muted small">{L("תמיד מקבלים התראה כשמישהו מצטרף, מנסה לצאת מהפרויקט, נכנס מכתובת רשת חדשה או שולח הרבה בקשות.", "You are always told when someone joins, tries to go outside the project, comes from a new network address, or sends very many requests.")}</p>
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>{L("סגירה", "Close")}</button></div>
      </div>
    </div>
  );
}
