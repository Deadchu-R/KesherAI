import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api";
import { shareBase } from "./chat/ShareDialog";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface HostView {
  title: string;
  stage: "lobby" | "question" | "reveal" | "end";
  qi: number;
  count: number;
  q?: string;
  options?: string[];
  left?: number;
  answer?: number;
  players: number;
  answered: number;
  names: string[];
  board: Array<{ name: string; score: number }>;
}

/**
 * Hosting a live quiz with classmates (design LiveQuiz, students part 28 #4, like Kahoot): a link and a QR the friends
 * open on their phones (no app, no account), who joined, and one button that moves the quiz on; a scoreboard after
 * each question.
 */
export function StudyLive({ courseId, lectureIds, onClose }: { courseId: string; lectureIds?: string[]; onClose: () => void }) {
  const [count, setCount] = useState(10);
  const [seconds, setSeconds] = useState(20);
  const [busy, setBusy] = useState(false);
  const [room, setRoom] = useState<{ token: string; link: string; anywhere: boolean; qr: string } | null>(null);
  const [v, setV] = useState<HostView | null>(null);

  useEffect(() => {
    if (!room) return;
    let on = true;
    const pull = () => void api<HostView>(`/api/live/${room.token}`).then((x) => on && setV(x), () => on && setV(null));
    pull();
    const t = setInterval(pull, 1000);
    return () => { on = false; clearInterval(t); };
  }, [room]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string; path: string }>(`/api/study/courses/${courseId}/live`, { method: "POST", body: { count, seconds, ...(lectureIds ? { lectureIds } : {}) } });
      const where = await shareBase();
      const link = where.base + r.path;
      setRoom({ token: r.token, link, anywhere: where.anywhere, qr: await QRCode.toDataURL(link, { margin: 1, width: 200 }).catch(() => "") });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const next = async () => setV(await api<HostView>(`/api/live/${room!.token}/next`, { method: "POST" }).catch(() => v));
  const end = async () => {
    if (room) await api(`/api/live/${room.token}`, { method: "DELETE" }).catch(() => undefined);
    onClose();
  };

  if (!room)
    return (
      <section className="card study-live">
        <h2>🎮 {L("בוחן חי עם חברים", "Live quiz with friends")}</h2>
        <p className="muted small">{L("החברים פותחים קישור בטלפון (בלי אפליקציה ובלי חשבון), כותבים שם, ועונים על כל שאלה נגד השעון. תשובה נכונה ומהירה שווה יותר נקודות.", "Friends open a link on their phones (no app, no account), type a name, and answer each question against the clock. A fast right answer scores more.")}</p>
        <div className="row study-live-opts">
          <label>{L("שאלות", "Questions")} <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{[5, 10, 15, 20].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label>{L("שניות לשאלה", "Seconds each")} <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>{[10, 20, 30, 60].map((n) => <option key={n}>{n}</option>)}</select></label>
        </div>
        <div className="study-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>{busy ? L("כותב שאלות…", "Writing questions…") : L("לפתוח חדר", "Open a room")}</button>
          <button type="button" className="ghost" onClick={onClose}>{L("ביטול", "Cancel")}</button>
        </div>
      </section>
    );

  const stage = v?.stage ?? "lobby";
  return (
    <section className="card study-live">
      <div className="row study-live-head">
        <h2>🎮 {v?.title ?? ""}</h2>
        <button type="button" className="ghost small" onClick={() => void end()}>{L("לסיים את החדר", "Close the room")}</button>
      </div>
      {stage === "lobby" && (
        <div className="study-live-join">
          {room.qr && <img src={room.qr} alt={L("קוד QR לקישור", "QR code for the link")} width={200} height={200} />}
          <div>
            <p dir="ltr" className="study-live-link"><code>{room.link}</code></p>
            <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(room.link).then(() => toast(L("הקישור הועתק", "Link copied")))}>{L("העתקת הקישור", "Copy the link")}</button>
            {!room.anywhere && <p className="muted small">{L("הקישור עובד רק ברשת של הבית. כדי שחברים מכל מקום יוכלו להצטרף, הפעילי \"גישה מכל מקום\" בהגדרות.", "This link works on your home network only. Turn on \"Access from anywhere\" in Settings so friends anywhere can join.")}</p>}
          </div>
        </div>
      )}
      {(stage === "question" || stage === "reveal") && v && (
        <div className="study-live-q">
          <p className="muted small">{L(`שאלה ${v.qi + 1} מתוך ${v.count}`, `Question ${v.qi + 1} of ${v.count}`)}{stage === "question" ? ` · ${v.left ?? 0} ${L("שניות", "s")} · ${L(`ענו ${v.answered} מתוך ${v.players}`, `${v.answered} of ${v.players} answered`)}` : ""}</p>
          <b dir="auto">{v.q}</b>
          <ol className="study-live-opts-list">{v.options?.map((o, i) => <li key={i} dir="auto" className={stage === "reveal" && i === v.answer ? "right" : ""}>{o}</li>)}</ol>
        </div>
      )}
      {stage === "lobby" ? (
        <p>{v?.names.length ? <>{L(`הצטרפו ${v.names.length}: `, `${v.names.length} joined: `)}<span dir="auto">{v.names.join(", ")}</span></> : <span className="muted">{L("מחכים לחברים…", "Waiting for friends…")}</span>}</p>
      ) : (stage === "reveal" || stage === "end") && v?.board.length ? (
        <div>
          <b>{stage === "end" ? L("התוצאה הסופית", "Final result") : L("הטבלה", "Scoreboard")}</b>
          <ol className="study-live-board">{v.board.map((b, i) => <li key={i} dir="auto">{b.name} · {b.score}</li>)}</ol>
        </div>
      ) : null}
      <div className="study-actions">
        {stage === "lobby" && <button type="button" className="primary" disabled={!v?.players} onClick={() => void next()}>{L("להתחיל", "Start")}</button>}
        {stage === "question" && <button type="button" className="primary" onClick={() => void next()}>{L("לחשוף את התשובה", "Reveal the answer")}</button>}
        {stage === "reveal" && <button type="button" className="primary" onClick={() => void next()}>{v && v.qi + 1 >= v.count ? L("לתוצאה הסופית", "Final result") : L("לשאלה הבאה", "Next question")}</button>}
        {stage === "end" && <button type="button" className="primary" onClick={() => void end()}>{L("סיום", "Done")}</button>}
      </div>
    </section>
  );
}
