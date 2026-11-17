import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { StudyGroupLink, StudyProject } from "@kesher/shared";
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
      <ProjectBoard courseId={courseId} courseName={courseName} />
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

/**
 * A group project's board (design GroupProject, students part 33 #3, like Taskphase): tasks with who and by when; a
 * link teammates open (no account) to take a task, mark it done or add one. She can stop sharing at any time.
 */
function ProjectBoard({ courseId, courseName }: { courseId: string; courseName: string }) {
  const [p, setP] = useState<StudyProject | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [who, setWho] = useState("");
  const [due, setDue] = useState("");
  const [link, setLink] = useState<{ url: string; qr: string; anywhere: boolean } | null>(null);
  useEffect(() => void api<{ project: StudyProject | null }>(`/api/study/courses/${courseId}/project`).then((r) => setP(r.project), () => setP(null)), [courseId]);
  useEffect(() => {
    if (!p?.token) { setLink(null); return; }
    void shareBase().then(async (w) => { const url = `${w.base}/g/${p.token}`; setLink({ url, anywhere: w.anywhere, qr: await QRCode.toDataURL(url, { margin: 1, width: 150 }).catch(() => "") }); });
  }, [p?.token]);
  if (p === undefined) return null;
  const save = async (next: StudyProject) => {
    setP(next);
    try { setP((await api<{ project: StudyProject | null }>(`/api/study/courses/${courseId}/project`, { method: "PUT", body: next })).project); } catch (e) { toast((e as Error).message); }
  };
  const board: StudyProject = p ?? { title: courseName, tasks: [], t: 0 };
  const add = () => {
    if (!text.trim()) return;
    void save({ ...board, tasks: [...board.tasks, { id: `t${Date.now().toString(36)}`, text: text.trim(), ...(who.trim() ? { who: who.trim() } : {}), ...(due ? { due } : {}) }] });
    setText(""); setWho(""); setDue("");
  };
  const share = async (on: boolean) => setP((await api<{ project: StudyProject }>(`/api/study/courses/${courseId}/project/share`, { method: "POST", body: { on } }).catch((e: Error) => { toast(e.message); return { project: board }; })).project);
  const doneN = board.tasks.filter((t) => t.done).length;
  return (
    <section className="card study-project">
      <h2>🧩 {L("עבודה קבוצתית", "Group project")}</h2>
      <input dir="auto" value={board.title} onChange={(e) => setP({ ...board, title: e.target.value })} onBlur={() => void save(board)} aria-label={L("שם העבודה", "The project's name")} placeholder={L("שם העבודה", "The project's name")} />
      {board.tasks.length > 0 && <p className="muted small">{L(`${doneN} מתוך ${board.tasks.length} בוצעו`, `${doneN} of ${board.tasks.length} done`)}</p>}
      <ul className="study-project-tasks">
        {board.tasks.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <label className="study-check"><input type="checkbox" checked={!!t.done} onChange={() => void save({ ...board, tasks: board.tasks.map((x) => (x.id === t.id ? (x.done ? (({ done: _d, ...rest }) => rest)(x) : { ...x, done: true }) : x)) })} /> <span dir="auto">{t.text}</span></label>
            <span className="muted small" dir="auto">{t.who ? `👤 ${t.who}` : L("אף אחד עוד לא לקח", "Nobody has it yet")}{t.due ? ` · ${L("עד", "by")} ${t.due.split("-").reverse().join(".")}` : ""}</span>
            <button type="button" className="ghost small" aria-label={L("להסיר", "Remove")} onClick={() => void save({ ...board, tasks: board.tasks.filter((x) => x.id !== t.id) })}>✕</button>
          </li>
        ))}
      </ul>
      <div className="row study-project-add">
        <input dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("משימה (למשל: סקירת ספרות)", "A task (e.g. the literature review)")} onKeyDown={(e) => { if (e.key === "Enter") add(); }} aria-label={L("משימה", "Task")} />
        <input dir="auto" value={who} onChange={(e) => setWho(e.target.value)} placeholder={L("מי", "Who")} aria-label={L("מי", "Who")} className="study-project-who" />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label={L("עד מתי", "By when")} />
        <button type="button" disabled={!text.trim()} onClick={add}>{L("להוסיף", "Add")}</button>
      </div>
      {link ? (
        <div className="study-live-join">
          {link.qr && <img src={link.qr} alt={L("קוד QR ללוח", "QR code for the board")} width={150} height={150} />}
          <div>
            <p dir="ltr" className="study-live-link"><code>{link.url}</code></p>
            <div className="row">
              <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => toast(L("הקישור הועתק", "Link copied")))}>{L("העתקת הקישור", "Copy the link")}</button>
              <button type="button" className="ghost small" onClick={() => void share(false)}>{L("להפסיק לשתף", "Stop sharing")}</button>
            </div>
            {!link.anywhere && <p className="muted small">{L("הקישור עובד רק ברשת של הבית. כדי שהשותפים יוכלו להיכנס מכל מקום, הפעילי \"גישה מכל מקום\".", "This link works on your home network only. Turn on \"Access from anywhere\".")}</p>}
          </div>
        </div>
      ) : <button type="button" className="small" onClick={() => void share(true)}>🔗 {L("לשתף עם השותפים (קישור בלי חשבון)", "Share with teammates (a link, no account)")}</button>}
    </section>
  );
}
