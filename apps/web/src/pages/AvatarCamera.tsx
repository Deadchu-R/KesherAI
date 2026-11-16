import { useEffect, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface AvatarInfo { accepted: boolean; clip: { size: number; at: number } | null }

/**
 * The avatar camera (students): a few minutes of the student's own "listening" video, looped as her camera in
 * Zoom or Teams through OBS (a browser source + OBS Virtual Camera). A warning comes first. The feed itself is
 * `#/avatar-feed` (AvatarFeed below).
 */
export function AvatarCamera() {
  const [info, setInfo] = useState<AvatarInfo | null>(null);
  const [rec, setRec] = useState<{ secs: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef<HTMLVideoElement>(null);
  const stop = useRef<() => void>(() => undefined);
  const load = () => void api<AvatarInfo>("/api/study/avatar").then(setInfo, (e: Error) => toast(e.message));
  useEffect(load, []);
  useEffect(() => () => stop.current(), []);

  const record = async () => {
    let cam: MediaStream;
    try {
      cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
    } catch {
      return toast(L("אין גישה למצלמה.", "No access to the camera."));
    }
    if (live.current) live.current.srcObject = cam;
    const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const mr = new MediaRecorder(cam, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const t0 = Date.now();
    const tick = setInterval(() => setRec({ secs: Math.round((Date.now() - t0) / 1000) }), 500);
    mr.onstop = async () => {
      clearInterval(tick);
      cam.getTracks().forEach((t) => t.stop());
      setRec(null);
      setBusy(true);
      try {
        const res = await fetch(withToken("/api/study/avatar/clip"), { method: "PUT", headers: { "content-type": "video/webm" }, body: new Blob(chunks, { type: "video/webm" }) });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? String(res.status));
        toast(L("הסרטון נשמר", "The video is saved"));
        load();
      } catch (e) {
        toast((e as Error).message);
      }
      setBusy(false);
    };
    stop.current = () => mr.state === "recording" && mr.stop();
    mr.start(1000);
    setRec({ secs: 0 });
  };

  if (!info) return <p className="muted">…</p>;
  if (!info.accepted)
    return (
      <section className="card study-avatar-warn" role="alertdialog" aria-labelledby="av-warn">
        <h2 id="av-warn">{L("לפני שמשתמשים במצלמת האווטאר", "Before using the avatar camera")}</h2>
        <p>{L("מצלמת האווטאר מציגה בשיעור סרטון שלך במקום המצלמה החיה. אם הקורס או המוסד יגלו שהשתמשת בה, זה עלול להיחשב הפרה של הכללים שלהם, עם כל מה שנובע מזה. ההחלטה והאחריות הן שלך.", "The avatar camera shows a video of you in class instead of your live camera. If the course or your school finds out, it may be treated as breaking their rules, with what follows from that. The choice and the responsibility are yours.")}</p>
        <div className="study-actions">
          <button type="button" className="primary" onClick={async () => { await api("/api/study/avatar/accept", { method: "POST" }); load(); }}>{L("הבנתי, להמשיך", "I understand, continue")}</button>
          <a className="button" href="#/study">{L("חזרה", "Back")}</a>
        </div>
      </section>
    );
  const feed = `${location.origin}/#/avatar-feed`;
  return (
    <div className="study-avatar">
      <section className="card">
        <h2>{L("1. הסרטון שלך", "1. Your video")}</h2>
        <p className="muted small">{L("הקליטי 3–5 דקות שבהן את יושבת מול המצלמה ומקשיבה: מבט למסך, תזוזות קטנות וטבעיות, אור כמו בשיעור. אל תדברי ואל תקומי. הסרטון נשמר רק במחשב הזה.", "Record 3–5 minutes of yourself sitting at the camera and listening: eyes on the screen, small natural movement, the light you have in class. Don't talk or get up. The video stays on this computer.")}</p>
        <video ref={live} className="study-avatar-video" autoPlay muted playsInline hidden={!rec} />
        {!rec && info.clip && <video className="study-avatar-video" src={withToken(`/api/study/avatar/clip?at=${info.clip.at}`)} autoPlay muted loop playsInline />}
        <div className="study-actions">
          {rec ? <button type="button" className="danger" onClick={() => stop.current()}>{L(`סיים הקלטה (${Math.floor(rec.secs / 60)}:${String(rec.secs % 60).padStart(2, "0")})`, `Finish (${Math.floor(rec.secs / 60)}:${String(rec.secs % 60).padStart(2, "0")})`)}</button>
            : <button type="button" className="primary" disabled={busy} onClick={() => void record()}>{busy ? L("שומר…", "Saving…") : info.clip ? L("הקלט מחדש", "Record again") : L("הקלט סרטון", "Record the video")}</button>}
          {info.clip && !rec && <button type="button" className="ghost" onClick={async () => { if (confirm(L("למחוק את הסרטון?", "Delete the video?"))) { await api("/api/study/avatar/clip", { method: "DELETE" }); load(); } }}>{L("מחק", "Delete")}</button>}
        </div>
      </section>
      {info.clip && <DirectCamera />}
      <section className="card">
        <h2>{L("או: מצלמה דרך OBS", "Or: a camera through OBS")}</h2>
        <ol className="study-avatar-steps">
          <li>{L("ב-OBS: מקורות ← + ← דפדפן, ובכתובת:", "In OBS: Sources → + → Browser, with the address:")} <code dir="ltr">{feed}</code> <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(feed).then(() => toast(L("הועתק", "Copied")))}>{L("העתק", "Copy")}</button></li>
          <li>{L("רוחב 1280, גובה 720.", "Width 1280, height 720.")}</li>
          <li>{L("ב-OBS: \"התחל מצלמה וירטואלית\".", "In OBS: \"Start Virtual Camera\".")}</li>
          <li>{L("ב-Zoom או ב-Teams: מצלמה ← OBS Virtual Camera.", "In Zoom or Teams: camera → OBS Virtual Camera.")}</li>
        </ol>
        <p className="muted small">{L("כשאת רוצה לדבר: עברי ב-Zoom למצלמה האמיתית. מעבר לבד כשאת מול המצלמה, וסנכרון שפתיים כשאת לא, ייכנסו בהמשך, וגם מצלמה ישירה בלי OBS.", "To talk: switch Zoom to your real camera. Switching by itself when you are at the camera, lip sync when you are not, and a direct camera without OBS come next.")}</p>
        <a className="button" href="#/avatar-feed" target="_blank" rel="noreferrer">{L("תצוגה מקדימה של המצלמה", "Preview the camera")}</a>
      </section>
    </div>
  );
}

/** The camera without OBS (the Windows app): add it to Windows once, then on and off. */
function DirectCamera() {
  const [st, setSt] = useState<{ available: boolean; installed: boolean; running: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api<{ available: boolean; installed: boolean; running: boolean }>("/api/study/avatar/camera").then(setSt, () => setSt(null));
  useEffect(load, []);
  if (!st?.available) return null;
  const act = async (action: "install" | "start" | "stop") => {
    setBusy(true);
    try {
      setSt(await api("/api/study/avatar/camera", { method: "POST", body: { action } }));
    } catch (e) {
      toast((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <section className="card">
      <h2>{L("2. להפוך אותו למצלמה (ישירות, בלי OBS)", "2. Make it a camera (directly, no OBS)")}</h2>
      <p className="muted small">{L("ב-Zoom או ב-Teams תופיע מצלמה בשם \"DirectShow Softcam\". בפעם הראשונה Windows ישאל אם לאשר להוסיף אותה.", "Zoom and Teams show a camera called \"DirectShow Softcam\". The first time, Windows asks whether to allow adding it.")}</p>
      <div className="study-actions">
        {!st.installed ? <button type="button" className="primary" disabled={busy} onClick={() => void act("install")}>{L("הוסף את המצלמה ל-Windows", "Add the camera to Windows")}</button>
          : st.running ? <button type="button" className="danger" disabled={busy} onClick={() => void act("stop")}>{L("כבה את מצלמת האווטאר", "Turn the avatar camera off")}</button>
          : <button type="button" className="primary" disabled={busy} onClick={() => void act("start")}>{L("הפעל את מצלמת האווטאר", "Turn the avatar camera on")}</button>}
        {st.running && <span className="good small">{L("פועלת", "On")}</span>}
      </div>
    </section>
  );
}

/**
 * The camera itself (`#/avatar-feed`, no menus): the student's video, looped without a visible jump — two players
 * that cross-fade over the last second.
 */
export function AvatarFeed() {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const [front, setFront] = useState<"a" | "b">("a");
  const src = withToken("/api/study/avatar/clip");
  useEffect(() => {
    const players = { a: a.current!, b: b.current! };
    let cur: "a" | "b" = "a";
    // A browser recording has no length in its header: seek far once so the player finds it, then back.
    for (const v of Object.values(players)) {
      v.addEventListener("loadedmetadata", () => {
        if (isFinite(v.duration)) return;
        const back = () => { v.removeEventListener("durationchange", back); v.currentTime = 0; };
        v.addEventListener("durationchange", back);
        v.currentTime = 1e9;
      });
      // If the length is still unknown, the other copy takes over when this one ends.
      v.addEventListener("ended", () => {
        const next = v === players.a ? "b" : "a";
        players[next].currentTime = 0;
        void players[next].play().catch(() => undefined);
        cur = next;
        setFront(next);
      });
    }
    void players.a.play().catch(() => undefined);
    const id = setInterval(() => {
      const p = players[cur];
      if (!p.duration || !isFinite(p.duration)) return;
      if (p.duration - p.currentTime < 1.1) {
        const next = cur === "a" ? "b" : "a";
        // Start the other copy from a slightly different point, so the loop never repeats exactly.
        players[next].currentTime = Math.random() * Math.min(4, p.duration / 10);
        void players[next].play().catch(() => undefined);
        cur = next;
        setFront(next);
      }
    }, 200);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="avatar-feed">
      <video ref={a} src={src} muted playsInline preload="auto" className={front === "a" ? "on" : ""} />
      <video ref={b} src={src} muted playsInline preload="auto" className={front === "b" ? "on" : ""} />
    </div>
  );
}
