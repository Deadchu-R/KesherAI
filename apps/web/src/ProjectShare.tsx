import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Guests {
  people: Array<{ id: string; name: string; role: "read" | "edit"; joinedAt: string; lastSeen: string | null; left: number; email?: string }>;
  invites: Array<{ id: string; role: "read" | "edit"; createdAt: string; expiresAt: string; usedAt?: string; usedBy?: string; email?: string }>;
  google: boolean;
  banned: string[];
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
  const [email, setEmail] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const load = useCallback(() => void api<Guests>(`/api/projects/${encodeURIComponent(projectId)}/guests`).then(setG, (e: Error) => toast(e.message)), [projectId]);
  useEffect(() => {
    load();
    void api<{ links: Array<{ url: string; kind: string }> }>("/api/remote/links").then((r) => setAnywhere(r.links.find((l) => l.kind === "anywhere")?.url ?? null), () => setAnywhere(null));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [load, onClose]);
  const make = async (byEmail = false) => {
    try {
      const r = await api<{ token: string }>(`/api/projects/${encodeURIComponent(projectId)}/invites`, { method: "POST", body: byEmail ? { role, email } : { role, hours } });
      const base = (anywhere ?? location.origin).replace(/\/$/, "");
      const url = `${base}/#/join/${r.token}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).then(() => toast(L("הקישור הועתק", "Link copied")), () => undefined);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const ban = async (id: string, who: string) => {
    if (!confirm(L(`לחסום את ${who}? הגישה נעצרת מיד, והאימייל שלו לא יוכל להצטרף לאף פרויקט עד שתבטל את החסימה.`, `Ban ${who}? Access stops at once, and their email cannot join any project until you lift the ban.`))) return;
    await api(`/api/projects/${encodeURIComponent(projectId)}/guests/${encodeURIComponent(id)}/ban`, { method: "POST" }).then(load, (e: Error) => toast(e.message));
  };
  const saveClient = () => void api("/api/guests/google", { method: "PUT", body: client }).then(() => { setClient({ clientId: "", clientSecret: "" }); load(); }, (e: Error) => toast(e.message));
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
        <button type="button" className="primary" onClick={() => void make(false)}>{L("צור קישור והעתק", "Make a link and copy it")}</button>
        {link && <input readOnly value={link} dir="ltr" onFocus={(e) => e.target.select()} aria-label={L("קישור ההזמנה", "The invite link")} />}
        <p className="muted small">{L("הראשון שפותח את הקישור כותב את שמו ומקבל גישה; אחר כך הקישור מפסיק לעבוד, ומקבלים התראה.", "The first person to open the link writes their name and gets access; then the link stops working, and you are told.")}</p>

        <b className="small">{L("הזמנה לפי אימייל (כניסה עם Google)", "Invite by email (sign in with Google)")}</b>
        {g?.google ? (
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (email.trim()) void make(true); }}>
            <input type="email" className="grow" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" dir="ltr" aria-label={L("אימייל", "Email")} />
            <button type="submit" disabled={!email.trim()}>{L("צור הזמנה", "Make the invite")}</button>
            <span className="muted small">{L("רק חשבון ה-Google הזה יוכל להיכנס (בתוקף 30 יום). ההרשאה לפי הבחירה למעלה.", "Only that Google account can come in (works 30 days). Access as chosen above.")}</span>
          </form>
        ) : (
          <details className="small">
            <summary>{L("להגדיר כניסה עם Google (פעם אחת)", "Set up sign-in with Google (once)")}</summary>
            <p className="muted small">{L("ב-Google Cloud, בפרויקט KesherAI: APIs & Services ← Credentials ← Create credentials ← OAuth client ID ← סוג: TVs and Limited Input devices. העתק לכאן את ה-Client ID וה-Secret.", "In Google Cloud, in the KesherAI project: APIs & Services → Credentials → Create credentials → OAuth client ID → type: TVs and Limited Input devices. Copy its Client ID and secret here.")}</p>
            <div className="stack">
              <input value={client.clientId} onChange={(e) => setClient({ ...client, clientId: e.target.value })} placeholder="…apps.googleusercontent.com" dir="ltr" aria-label="Client ID" />
              <input type="password" value={client.clientSecret} onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} placeholder="Client secret" dir="ltr" aria-label="Client secret" autoComplete="off" />
              <button type="button" onClick={saveClient} disabled={!client.clientId || !client.clientSecret}>{L("שמור", "Save")}</button>
            </div>
          </details>
        )}

        <b className="small">{L("מי יש לו גישה", "Who has access")}</b>
        {g && g.people.length === 0 && <p className="muted small">{L("עוד אף אחד.", "No one yet.")}</p>}
        {g?.people.map((p) => (
          <div key={p.id} className="card row wrap project-share-person">
            <b className="grow" dir="auto">{p.name.replace(/ \(guest\)$/, "")} · {p.role === "edit" ? L("צפייה וכתיבה", "read and write") : L("צפייה", "read")}</b>
            <span className="muted small">{L("הצטרף", "joined")} {ago(p.joinedAt)} · {L("נראה", "seen")} {ago(p.lastSeen)} · {L(`נשארו היום ${p.left}`, `${p.left} left today`)}</span>
            {p.email && <span className="muted small" dir="ltr">{p.email}</span>}
            <button type="button" className="ghost small" onClick={() => void remove(p.id, p.name)}>{L("הסר", "Remove")}</button>
            {p.email && <button type="button" className="ghost small danger" onClick={() => void ban(p.id, p.name)}>{L("חסום", "Ban")}</button>}
          </div>
        ))}
        {pending.length > 0 && (
          <>
            <b className="small">{L("הזמנות שעוד לא נפתחו", "Invites not opened yet")}</b>
            {pending.map((i) => (
              <div key={i.id} className="row wrap small">
                <span className="grow">{i.email ? <span dir="ltr">{i.email} · </span> : null}{i.role === "edit" ? L("צפייה וכתיבה", "Read and write") : L("צפייה", "Read")} · {L("עד", "until")} {new Date(i.expiresAt).toLocaleString()}</span>
                <button type="button" className="ghost small" onClick={() => cancel(i.id)}>{L("בטל", "Cancel")}</button>
              </div>
            ))}
          </>
        )}
        {g && g.banned.length > 0 && (
          <details className="small">
            <summary>{L(`חסומים (${g.banned.length})`, `Banned (${g.banned.length})`)}</summary>
            {g.banned.map((b) => (
              <div key={b} className="row small"><span className="grow" dir="ltr">{b}</span><button type="button" className="ghost small" onClick={() => void api(`/api/guests/banned/${encodeURIComponent(b)}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message))}>{L("בטל חסימה", "Lift the ban")}</button></div>
            ))}
          </details>
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
