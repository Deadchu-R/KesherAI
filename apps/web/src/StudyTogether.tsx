import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { StudyGroupLink } from "@kesher/shared";
import { api } from "./api";
import { shareBase } from "./chat/ShareDialog";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const mmss = (n: number) => { const s = Math.max(0, Math.round(n)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

interface RoomView { title: string; running: boolean; phase: "focus" | "break"; left: number; focus: number; rest: number; here: Array<{ name: string; task: string }> }

/**
 * Studying together (design StudyTogether, students part 28 #5): a shared focus room friends join from a link (one
 * timer for everyone, who is studying now and on what), and the course's study group links in one place.
 */
export function StudyTogether({ courseId, courseName, groups, onChange }: { courseId: string; courseName: string; groups: StudyGroupLink[]; onChange: () => void }) {
  return (
    <div className="study-together">
      <FocusRoomCard courseName={courseName} />
      <GroupLinks courseId={courseId} groups={groups} onChange={onChange} />
    </div>
  );
}

function FocusRoomCard({ courseName }: { courseName: string }) {
  const [focus, setFocus] = useState(25);
  const [rest, setRest] = useState(5);
  const [room, setRoom] = useState<{ token: string; link: string; anywhere: boolean; qr: string } | null>(null);
  const [v, setV] = useState<RoomView | null>(null);
  const [got, setGot] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!room) return;
    let on = true;
    const pull = () => void api<RoomView>(`/api/focus/${room.token}`).then((x) => { if (on) { setV(x); setGot(Date.now()); } }, () => on && setRoom(null));
    pull();
    const a = setInterval(pull, 5000);
    const b = setInterval(() => tick((n) => n + 1), 1000);
    return () => { on = false; clearInterval(a); clearInterval(b); };
  }, [room]);
  const open = async () => {
    try {
      const r = await api<{ token: string; path: string }>("/api/study/focus-room", { method: "POST", body: { title: courseName, focus, rest } });
      const where = await shareBase();
      const link = where.base + r.path;
      setRoom({ token: r.token, link, anywhere: where.anywhere, qr: await QRCode.toDataURL(link, { margin: 1, width: 168 }).catch(() => "") });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const timer = async (run: boolean, reset = false) => {
    const x = await api<RoomView>(`/api/focus/${room!.token}/timer`, { method: "POST", body: { run, reset } }).catch((e: Error) => { toast(e.message); return null; });
    if (x) { setV(x); setGot(Date.now()); }
  };
  const close = async () => {
    if (room) await api(`/api/focus/${room.token}`, { method: "DELETE" }).catch(() => undefined);
    setRoom(null);
    setV(null);
  };
  if (!room)
    return (
      <section className="card study-room">
        <h2>👥 {L("חדר ריכוז משותף", "Shared focus room")}</h2>
        <p className="muted small">{L("חברים נכנסים מקישור (בלי אפליקציה ובלי חשבון), כותבים על מה הם עובדים, וכולם רואים את אותו טיימר ומי לומד עכשיו. שום דבר לא מוקלט ולא נשמר.", "Friends join from a link (no app, no account), write what they are working on, and everyone sees the same timer and who is studying now. Nothing is recorded or kept.")}</p>
        <div className="row study-live-opts">
          <label>{L("ריכוז", "Focus")} <select value={focus} onChange={(e) => setFocus(Number(e.target.value))}>{[25, 45, 50, 90].map((n) => <option key={n} value={n}>{L(`${n} דק׳`, `${n} min`)}</option>)}</select></label>
          <label>{L("הפסקה", "Break")} <select value={rest} onChange={(e) => setRest(Number(e.target.value))}>{[5, 10, 15].map((n) => <option key={n} value={n}>{L(`${n} דק׳`, `${n} min`)}</option>)}</select></label>
        </div>
        <div className="study-actions"><button type="button" className="primary" onClick={() => void open()}>{L("לפתוח חדר", "Open a room")}</button></div>
      </section>
    );
  const left = v ? (v.running ? v.left - (Date.now() - got) / 1000 : v.left) : 0;
  return (
    <section className="card study-room">
      <div className="row study-live-head">
        <h2>👥 {L("חדר ריכוז משותף", "Shared focus room")}</h2>
        <button type="button" className="ghost small" onClick={() => void close()}>{L("לסגור את החדר", "Close the room")}</button>
      </div>
      <div className="study-room-clock">
        <span className={v?.phase === "break" ? "brk" : ""}>{v?.phase === "break" ? L("☕ הפסקה", "☕ Break") : L("⏳ זמן ריכוז", "⏳ Focus")}{v && !v.running ? L(" · מושהה", " · paused") : ""}</span>
        <b dir="ltr">{mmss(left)}</b>
        <div className="row">
          {v?.running ? <button type="button" onClick={() => void timer(false)}>{L("השהיה", "Pause")}</button> : <button type="button" className="primary" onClick={() => void timer(true)}>{L("להתחיל", "Start")}</button>}
          <button type="button" className="ghost" onClick={() => void timer(!!v?.running, true)}>{L("מההתחלה", "From the start")}</button>
        </div>
      </div>
      <div className="study-live-join">
        {room.qr && <img src={room.qr} alt={L("קוד QR לחדר", "QR code for the room")} width={168} height={168} />}
        <div>
          <p dir="ltr" className="study-live-link"><code>{room.link}</code></p>
          <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(room.link).then(() => toast(L("הקישור הועתק", "Link copied")))}>{L("העתקת הקישור", "Copy the link")}</button>
          {!room.anywhere && <p className="muted small">{L("הקישור עובד רק ברשת של הבית. כדי שחברים מכל מקום יוכלו להצטרף, הפעילי \"גישה מכל מקום\" בהגדרות.", "This link works on your home network only. Turn on \"Access from anywhere\" in Settings so friends anywhere can join.")}</p>}
        </div>
      </div>
      <b>{L(`לומדים עכשיו (${v?.here.length ?? 0})`, `Studying now (${v?.here.length ?? 0})`)}</b>
      {v?.here.length ? <ul className="study-room-here">{v.here.map((h, i) => <li key={i} dir="auto"><b>{h.name}</b>{h.task ? <span className="muted"> · {h.task}</span> : null}</li>)}</ul> : <p className="muted small">{L("עוד אף אחד לא נכנס.", "Nobody has joined yet.")}</p>}
    </section>
  );
}

function GroupLinks({ courseId, groups, onChange }: { courseId: string; groups: StudyGroupLink[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const save = async (list: StudyGroupLink[]) => {
    try {
      const c = await api<{ groups?: StudyGroupLink[] }>(`/api/study/courses/${courseId}`, { method: "PATCH", body: { groups: list } });
      onChange();
      return (c.groups ?? []).length;
    } catch (e) {
      toast((e as Error).message);
      return -1;
    }
  };
  const add = async () => {
    const u = url.trim().replace(/^(?!https?:\/\/)/i, "https://");
    const n = await save([...groups, { name: name.trim(), url: u }]);
    if (n === groups.length) toast(L("הקישור צריך להתחיל ב-https://", "The link must start with https://"));
    else if (n > groups.length) { setName(""); setUrl(""); }
  };
  return (
    <section className="card study-groups">
      <h2>💬 {L("קבוצות לימוד", "Study groups")}</h2>
      {groups.length ? (
        <ul className="study-groups-list">
          {groups.map((g, i) => (
            <li key={i}>
              <a className="button" href={g.url} target="_blank" rel="noopener noreferrer" dir="auto">{g.name} ↗</a>
              <button type="button" className="ghost small" aria-label={L(`להסיר את ${g.name}`, `Remove ${g.name}`)} onClick={() => void save(groups.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{L("הקישורים של הקורס במקום אחד: קבוצת וואטסאפ, דיסקורד, טלגרם או תיקייה משותפת.", "The course's links in one place: a WhatsApp group, Discord, Telegram or a shared folder.")}</p>}
      <div className="study-groups-add">
        <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={L("שם (למשל: וואטסאפ של המחזור)", "Name (e.g. the class WhatsApp)")} aria-label={L("שם הקבוצה", "Group name")} />
        <input dir="ltr" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://chat.whatsapp.com/…" aria-label={L("הקישור", "The link")} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <button type="button" disabled={!url.trim()} onClick={() => void add()}>{L("להוסיף", "Add")}</button>
      </div>
    </section>
  );
}
