import { useEffect, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface AvatarInfo { accepted: boolean; clip: { size: number; at: number } | null }

/** Tips shown while recording, one every 30 seconds, so the video has the small movements of someone listening. */
const RECORD_HINTS: Array<[string, string]> = [
  ["הסתכלי למסך כאילו את מקשיבה למרצה.", "Look at the screen as if listening to the lecturer."],
  ["הנהני קצת, כאילו את מסכימה.", "Nod a little, as if you agree."],
  ["הורידי מבט לשנייה, כאילו את כותבת משהו, וחזרי למסך.", "Look down for a second as if writing, then back to the screen."],
  ["שבי קצת אחרת: זוזי מעט בכיסא.", "Shift a little in your chair."],
  ["חייכי קלות, כאילו המרצה אמר משהו מצחיק.", "Smile a little, as if the lecturer said something funny."],
  ["הזיזי שיער או גרדי בלחי, פעם אחת, בעדינות.", "Touch your hair or cheek once, gently."],
  ["חזרי להקשבה רגילה, בלי לזוז הרבה.", "Back to plain listening, little movement."],
  ["הטי את הראש מעט, כאילו את חושבת.", "Tilt your head a little, as if thinking."],
  ["מצמוץ רגיל ונשימה רגילה. כמעט סיימנו.", "Blink and breathe normally. Almost done."],
];

/** The steps of the first setup. */
const STEPS: Array<[string, string]> = [["הכנה", "Get ready"], ["הקלטה", "Record"], ["בדיקה", "Check"], ["מצלמה ב-Zoom", "Camera in Zoom"]];

/**
 * The avatar camera (students), as a guided first setup: get ready (light, framing, clothes), record 3–5 minutes of
 * listening with a framing guide and prompts for natural movement, check the loop, then make it a camera in Zoom or
 * Teams (softcam or OBS), with the remote control. A warning comes first. The feed itself is `#/avatar-feed`.
 */
export function AvatarCamera() {
  const [info, setInfo] = useState<AvatarInfo | null>(null);
  const [step, setStep] = useState(0);
  const [rec, setRec] = useState<{ secs: number } | null>(null);
  const [count, setCount] = useState(0);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef<HTMLVideoElement>(null);
  const cam = useRef<MediaStream | null>(null);
  const stop = useRef<() => void>(() => undefined);
  const load = () => void api<AvatarInfo>("/api/study/avatar").then((r) => { setInfo(r); if (r.clip) setStep((s) => (s === 0 ? 2 : s)); }, (e: Error) => toast(e.message));
  useEffect(load, []);
  useEffect(() => () => { stop.current(); cam.current?.getTracks().forEach((t) => t.stop()); }, []);

  /** The camera picture with the framing guide, before and while recording. */
  const openCamera = async () => {
    if (cam.current) return cam.current;
    try {
      cam.current = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
    } catch {
      toast(L("אין גישה למצלמה. בדקי שהיא מחוברת ושאישרת גישה.", "No access to the camera. Check it is connected and allowed."));
      return null;
    }
    if (live.current) live.current.srcObject = cam.current;
    setPreview(true);
    return cam.current;
  };

  const record = async () => {
    const stream = await openCamera();
    if (!stream) return;
    for (let i = 3; i > 0; i--) {
      setCount(i);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCount(0);
    const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const t0 = Date.now();
    const tick = setInterval(() => {
      const secs = Math.round((Date.now() - t0) / 1000);
      setRec({ secs });
      if (secs >= 300 && mr.state === "recording") mr.stop();
    }, 500);
    mr.onstop = async () => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      cam.current = null;
      setPreview(false);
      setRec(null);
      setBusy(true);
      try {
        const res = await fetch(withToken("/api/study/avatar/clip"), { method: "PUT", headers: { "content-type": "video/webm" }, body: new Blob(chunks, { type: "video/webm" }) });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? String(res.status));
        toast(L("הסרטון נשמר", "The video is saved"));
        setStep(2);
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
  const secs = rec?.secs ?? 0;
  return (
    <div className="study-avatar">
      <ol className="avatar-steps" aria-label={L("שלבי ההגדרה", "Setup steps")}>
        {STEPS.map(([h, e], i) => (
          <li key={e}><button type="button" className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined} disabled={!!rec || (i > 1 && !info.clip)} onClick={() => setStep(i)}>{i < step ? "✓ " : `${i + 1}. `}{L(h, e)}</button></li>
        ))}
      </ol>

      {step === 0 && (
        <section className="card">
          <h2>{L("לפני שמקליטים: 2 דקות של הכנה", "Before recording: 2 minutes to get ready")}</h2>
          <p className="muted small">{L("הסרטון יוצג בשיעורים במקומך, אז כדאי שייראה בדיוק כמו שאת נראית בשיעור רגיל.", "The video stands in for you in class, so it should look exactly like you do in a normal lesson.")}</p>
          <ul className="avatar-checklist">
            <li><b>{L("אותו מקום", "The same place")}</b> — {L("שבי איפה שאת יושבת בשיעורים, עם אותו רקע.", "sit where you sit for lessons, with the same background.")}</li>
            <li><b>{L("אור מלפנים", "Light in front")}</b> — {L("חלון או מנורה מולך, לא מאחורייך. בלי שמש שזזה על הפנים.", "a window or lamp facing you, not behind. No moving sunlight on your face.")}</li>
            <li><b>{L("מצלמה בגובה העיניים", "Camera at eye level")}</b> — {L("הניחי את הלפטופ על כמה ספרים אם צריך.", "put the laptop on a few books if needed.")}</li>
            <li><b>{L("בגדים רגילים לשיעור", "Normal lesson clothes")}</b> — {L("אם ההקלטה בחולצה מסוימת, עדיף ללבוש אותה גם בשיעורים עם האווטאר. אפשר להקליט כמה סרטונים.", "if you record in one top, wear it for avatar lessons too. You can record more than one video.")}</li>
            <li><b>{L("שקט ולבד", "Quiet and alone")}</b> — {L("שאף אחד לא ייכנס לפריים. הקול לא מוקלט.", "nobody walks into the picture. No sound is recorded.")}</li>
          </ul>
          <div className="study-actions">
            <button type="button" className="primary" onClick={() => { setStep(1); void openCamera(); }}>{L("פתחי מצלמה וממשיכים", "Open the camera and continue")}</button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="card">
          <h2>{L("הקלטה: 3–5 דקות של הקשבה", "Record: 3–5 minutes of listening")}</h2>
          <p className="muted small">{L("שימי את הראש והכתפיים בתוך המסגרת, והעיניים על הקו. בזמן ההקלטה יופיעו רמזים קטנים לתזוזות טבעיות. לא מדברים ולא קמים.", "Keep head and shoulders inside the frame, eyes on the line. Small hints for natural movement show while recording. Don't talk or get up.")}</p>
          <div className="avatar-frame">
            <video ref={live} className="study-avatar-video" autoPlay muted playsInline />
            {preview && <div className="avatar-guide" aria-hidden="true"><span className="avatar-guide-head" /><span className="avatar-guide-eyes" /></div>}
            {count > 0 && <div className="avatar-count" aria-live="assertive">{count}</div>}
            {rec && <div className="avatar-hint" aria-live="polite">{L(...RECORD_HINTS[Math.min(RECORD_HINTS.length - 1, Math.floor(secs / 30))]!)}</div>}
          </div>
          {rec && <progress max={300} value={secs} aria-label={L("זמן הקלטה", "Recording time")} />}
          <div className="study-actions">
            {rec ? (
              <button type="button" className={secs >= 180 ? "primary" : "danger"} onClick={() => stop.current()}>
                {secs >= 180 ? L(`סיימתי (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")})`, `Done (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")})`) : L(`עצור (עוד ${Math.ceil((180 - secs) / 60)} דק׳ למינימום)`, `Stop (${Math.ceil((180 - secs) / 60)} min to the minimum)`)}
              </button>
            ) : (
              <>
                {!preview && <button type="button" onClick={() => void openCamera()}>{L("פתחי מצלמה", "Open the camera")}</button>}
                <button type="button" className="primary" disabled={busy || count > 0} onClick={() => void record()}>{busy ? L("שומר…", "Saving…") : L("התחילי הקלטה (ספירה לאחור 3 שניות)", "Start recording (3-second countdown)")}</button>
              </>
            )}
          </div>
          <p className="muted small">{L("ההקלטה נעצרת לבד אחרי 5 דקות. הסרטון נשמר רק במחשב הזה.", "It stops by itself after 5 minutes. The video stays on this computer.")}</p>
        </section>
      )}

      {step === 2 && info.clip && (
        <section className="card">
          <h2>{L("בדיקה: ככה זה ייראה", "Check: this is how it will look")}</h2>
          <video className="study-avatar-video" src={withToken(`/api/study/avatar/clip?at=${info.clip.at}`)} autoPlay muted loop playsInline />
          <ul className="avatar-checklist">
            <li>{L("רואים את כל הפנים, באור טוב?", "Is your whole face visible, in good light?")}</li>
            <li>{L("אין רגע שבו את מדברת, קמה או מסתכלת הצידה הרבה זמן?", "No moment of talking, getting up or looking away for long?")}</li>
            <li>{L("הרקע נראה כמו בשיעורים שלך?", "Does the background look like your lessons?")}</li>
          </ul>
          <div className="study-actions">
            <button type="button" className="primary" onClick={() => setStep(3)}>{L("נראה טוב, ממשיכים", "Looks good, continue")}</button>
            <button type="button" onClick={() => { setStep(1); void openCamera(); }}>{L("הקלטה מחדש", "Record again")}</button>
            <button type="button" className="ghost" onClick={async () => { if (confirm(L("למחוק את הסרטון?", "Delete the video?"))) { await api("/api/study/avatar/clip", { method: "DELETE" }); setStep(0); load(); } }}>{L("מחק", "Delete")}</button>
          </div>
        </section>
      )}

      {step === 3 && info.clip && (
        <>
          <DirectCamera />
          <LipSyncCard />
          <section className="card">
            <h2>{L("ב-Teams, ב-Meet או בדפדפן: דרך OBS", "In Teams, Meet or a browser: through OBS")}</h2>
            <p className="muted small">{L("דפדפנים ו-Teams החדש לא רואים את המצלמה הישירה; OBS כן.", "Browsers and the new Teams do not see the direct camera; OBS works there.")}</p>
            <ol className="study-avatar-steps">
              <li>{L("פתחי את OBS. בתיבה \"מקורות\" למטה: + ← דפדפן ← אישור.", "Open OBS. In \"Sources\" at the bottom: + → Browser → OK.")}</li>
              <li>{L("בכתובת הדביקי:", "For the address, paste:")} <code dir="ltr">{feed}</code> <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(feed).then(() => toast(L("הועתק", "Copied")))}>{L("העתק", "Copy")}</button></li>
              <li>{L("רוחב 1280, גובה 720 ← אישור.", "Width 1280, height 720 → OK.")}</li>
              <li>{L("מימין למטה: \"התחל מצלמה וירטואלית\".", "Bottom right: \"Start Virtual Camera\".")}</li>
              <li>{L("ב-Teams או ב-Meet: הגדרות ← וידאו ← מצלמה ← OBS Virtual Camera.", "In Teams or Meet: settings → video → camera → OBS Virtual Camera.")}</li>
            </ol>
          </section>
          <CameraMode />
          <section className="card">
            <h2>{L("ניסיון לפני השיעור הראשון", "A try before the first lesson")}</h2>
            <p className="muted small">{L("פתחי פגישת ניסיון ב-Zoom לבד (\"פגישה חדשה\"), בחרי את המצלמה, והחליפי כמה פעמים בין \"אווטאר\" ל\"מצלמה אמיתית\" כאן או מהטלפון.", "Start a test meeting in Zoom on your own (\"New meeting\"), choose the camera, and switch a few times between \"Avatar\" and \"Real camera\" here or from the phone.")}</p>
            <a className="button" href="#/avatar-feed" target="_blank" rel="noreferrer">{L("תצוגה מקדימה של המצלמה", "Preview the camera")}</a>
          </section>
        </>
      )}
    </div>
  );
}

/** The remote control (from the phone or the computer): what the camera shows now. */
function CameraMode() {
  const [mode, setMode] = useState<"avatar" | "live">("avatar");
  useEffect(() => void api<{ mode: "avatar" | "live" }>("/api/study/avatar/mode").then((r) => setMode(r.mode), () => undefined), []);
  const set = async (m: "avatar" | "live") => {
    try {
      setMode((await api<{ mode: "avatar" | "live" }>("/api/study/avatar/mode", { method: "POST", body: { mode: m } })).mode);
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section className="card study-remote">
      <h2>{L("שלט רחוק: מה רואים בשיעור", "Remote control: what the class sees")}</h2>
      <p className="muted small">{L("אפשר לשלוט מכאן גם מהטלפון, כשהוא מחובר למחשב: השיעור רץ בלפטופ, ואת חופשייה לזוז.", "You can control this from the phone too, connected to the computer: the lesson runs on the laptop and you are free to move.")}</p>
      <div className="study-remote-btns" role="radiogroup" aria-label={L("מה רואים", "What they see")}>
        <button type="button" role="radio" aria-checked={mode === "avatar"} className={mode === "avatar" ? "primary" : ""} onClick={() => void set("avatar")}>{L("אווטאר", "Avatar")}</button>
        <button type="button" role="radio" aria-checked={mode === "live"} className={mode === "live" ? "primary" : ""} onClick={() => void set("live")}>{L("המצלמה האמיתית", "Real camera")}</button>
      </div>
    </section>
  );
}

interface LipSyncStatus { possible: boolean; installed: boolean; installing?: string; running: boolean; enabled: boolean; cable?: string; mic?: string; error?: string }

const INSTALL_STEP: Record<string, [string, string]> = {
  starting: ["מתחיל", "Starting"],
  tools: ["כלים", "Tools"],
  python: ["Python", "Python"],
  pytorch: ["PyTorch (הגדול ביותר)", "PyTorch (the largest)"],
  packages: ["חבילות", "Packages"],
  models: ["מודלים", "Models"],
  check: ["בדיקה", "Checking"],
};

/**
 * Lip sync (strong NVIDIA cards only): the avatar's lips move with her voice when she talks while away from the
 * camera. Optional: about 7 GB, installed at the computer; then on or off, and, for lips exactly on time, a virtual
 * audio cable that Zoom uses as its microphone.
 */
function LipSyncCard() {
  const [st, setSt] = useState<LipSyncStatus | null>(null);
  const [cable, setCable] = useState("");
  const [mics, setMics] = useState<Array<{ name: string; default: boolean }>>([]);
  useEffect(() => { if (st?.installed && !mics.length) void api<{ mics: Array<{ name: string; default: boolean }> }>("/api/study/avatar/lipsync/mics").then((r) => setMics(r.mics), () => undefined); }, [st?.installed, mics.length]);
  const load = () => void api<LipSyncStatus>("/api/study/avatar/lipsync").then((x) => { setSt(x); setCable((c) => c || x.cable || ""); }, () => setSt(null));
  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);
  if (!st?.possible) return null;
  const act = async (body: Record<string, unknown>) => {
    try {
      setSt(await api<LipSyncStatus>("/api/study/avatar/lipsync", { method: "POST", body }));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>{L("שפתיים שזזות כשאת מדברת", "Lips that move when you talk")}</h2>
      <p className="muted small">{L("למחשבים עם כרטיס NVIDIA חזק: כשאת עונה בקול בלי לשבת מול המצלמה, השפתיים של האווטאר זזות עם הקול שלך (MuseTalk, במחשב, בלי ענן).", "For computers with a strong NVIDIA card: when you answer by voice away from the camera, the avatar's lips move with your voice (MuseTalk, on this computer, no cloud).")}</p>
      {!st.installed ? (
        st.installing ? (
          <p className="small" aria-live="polite">{L("מתקין: ", "Installing: ")}{L(...(INSTALL_STEP[st.installing] ?? [st.installing, st.installing]))}… {L("(כ-7GB, כמה דקות)", "(about 7 GB, a few minutes)")}</p>
        ) : (
          <button type="button" className="primary" onClick={() => void act({ action: "install" })}>{L("התקנה (כ-7GB)", "Install (about 7 GB)")}</button>
        )
      ) : (
        <>
          <label className="study-check"><input type="checkbox" checked={st.enabled} onChange={(e) => void act({ action: "set", enabled: e.target.checked })} /> {L("להפעיל עם מצלמת האווטאר", "Turn on with the avatar camera")}</label>
          {mics.length > 0 && (
            <label className="study-field">
              <span>{L("מיקרופון", "Microphone")}</span>
              <select value={st.mic ?? ""} onChange={(e) => void act({ action: "set", mic: e.target.value })}>
                <option value="">{L("ברירת המחדל של Windows", "Windows' default")}{(() => { const d = mics.find((m) => m.default); return d ? ` (${d.name})` : ""; })()}</option>
                {mics.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </label>
          )}
          {st.running && <p className="good small">{L("● פועל: השפתיים יזוזו כשתדברי.", "● On: the lips move when you talk.")}</p>}
          <details>
            <summary>{L("שפתיים בדיוק בזמן (כבל שמע וירטואלי)", "Lips exactly on time (a virtual audio cable)")}</summary>
            <p className="muted small">{L("השפתיים מגיעות כ-0.3 שנייה אחרי הקול. כדי שיגיעו יחד: מתקינים VB-Cable מהאתר הרשמי שלו (vb-audio.com), כותבים כאן את שם ההתקן שלו (CABLE Input), ובזום בוחרים כמיקרופון את CABLE Output. הקול שלך יעוכב באותו זמן כמו השפתיים.", "The lips arrive about 0.3 s after the voice. To make them arrive together: install VB-Cable from its official site (vb-audio.com), write its device name here (CABLE Input), and in Zoom choose CABLE Output as the microphone. Your voice is held back by the lips' delay.")}</p>
            <div className="study-actions">
              <input value={cable} onChange={(e) => setCable(e.target.value)} placeholder="CABLE Input" aria-label={L("שם התקן הכבל", "Cable device name")} dir="ltr" />
              <button type="button" onClick={() => void act({ action: "set", cable })}>{L("שמור", "Save")}</button>
            </div>
          </details>
        </>
      )}
      {st.error && <p className="error small">{st.error}</p>}
    </section>
  );
}

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
      <h2>{L("ב-Zoom: מצלמה ישירה (בלי OBS)", "In Zoom: a direct camera (no OBS)")}</h2>
      <ol className="study-avatar-steps">
        <li>{L("פעם ראשונה: \"הוסף את המצלמה ל-Windows\" ואשרי בחלון של Windows.", "First time: \"Add the camera to Windows\" and allow it in Windows' window.")}</li>
        <li>{L("\"הפעל את מצלמת האווטאר\".", "\"Turn the avatar camera on\".")}</li>
        <li>{L("ב-Zoom: הגדרות ← וידאו ← מצלמה ← DirectShow Softcam.", "In Zoom: Settings → Video → Camera → DirectShow Softcam.")}</li>
      </ol>
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
  const live = useRef<HTMLVideoElement>(null);
  const [front, setFront] = useState<"a" | "b">("a");
  const [mode, setMode] = useState<"avatar" | "live">("avatar");
  // The mode (avatar or real camera) is switched from the computer or the phone; asked every second.
  useEffect(() => {
    const id = setInterval(() => void fetch(withToken("/api/study/avatar/mode")).then((r) => r.json()).then((j: { mode?: string }) => setMode(j.mode === "live" ? "live" : "avatar"), () => undefined), 1000);
    return () => clearInterval(id);
  }, []);
  // The real camera only while it is shown (so its light is off otherwise).
  useEffect(() => {
    if (mode !== "live") return;
    let stream: MediaStream | undefined;
    let off = false;
    void navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false }).then((s) => {
      if (off) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      if (live.current) live.current.srcObject = s;
    }, () => setMode("avatar"));
    return () => {
      off = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [mode]);
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
    // Cross-fades to another point of the clip at uneven times (8–20 s), and always before its end: a loop that
    // never repeats the same way (what makes a recorded clip look live, as ScrumSurvivor and Pickle do).
    let switchAt = performance.now() + 8000 + Math.random() * 12000;
    const id = setInterval(() => {
      const p = players[cur];
      if (!p.duration || !isFinite(p.duration)) return;
      if (p.duration - p.currentTime < 1.1 || (p.duration > 12 && performance.now() > switchAt)) {
        const next = cur === "a" ? "b" : "a";
        players[next].currentTime = Math.random() * Math.max(0, p.duration - 10);
        void players[next].play().catch(() => undefined);
        cur = next;
        setFront(next);
        switchAt = performance.now() + 8000 + Math.random() * 12000;
      }
    }, 200);
    return () => clearInterval(id);
  }, []);
  // Lip sync (when it runs): her lip-synced frames, drawn over the loop while she talks.
  const lips = useRef<HTMLCanvasElement>(null);
  const [talking, setTalking] = useState(false);
  useEffect(() => {
    let ws: WebSocket | undefined;
    let stopped = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      if (stopped || ws) return;
      const st = await fetch(withToken("/api/study/avatar/lipsync")).then((r) => r.json() as Promise<{ running?: boolean }>, () => ({ running: false }));
      if (!st.running || stopped) return;
      const url = new URL(withToken("/api/study/avatar/lipsync/stream"), location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const w = new WebSocket(url);
      ws = w;
      w.binaryType = "blob";
      w.onmessage = async (e) => {
        if (typeof e.data === "string") return;
        const c = lips.current;
        const g = c?.getContext("2d");
        if (!c || !g) return;
        const img = await createImageBitmap(e.data as Blob);
        if (c.width !== img.width) [c.width, c.height] = [img.width, img.height];
        g.drawImage(img, 0, 0);
        img.close();
        setTalking(true);
        clearTimeout(quiet);
        quiet = setTimeout(() => setTalking(false), 350);
      };
      w.onclose = () => { ws = undefined; setTalking(false); };
    };
    const id = setInterval(() => void connect(), 2000);
    void connect();
    return () => {
      stopped = true;
      clearInterval(id);
      clearTimeout(quiet);
      ws?.close();
    };
  }, []);
  // A camera's faint sensor grain over the clip (a recording is too clean next to live cameras).
  const grain = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = grain.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    c.width = 320;
    c.height = 180;
    const img = g.createImageData(c.width, c.height);
    const id = setInterval(() => {
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }, 80);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="avatar-feed">
      <div className="avatar-sway">
        <video ref={a} src={src} muted playsInline preload="auto" className={front === "a" ? "on" : ""} />
        <video ref={b} src={src} muted playsInline preload="auto" className={front === "b" ? "on" : ""} />
      </div>
      <canvas ref={lips} className={`avatar-lips${talking && mode !== "live" ? " on" : ""}`} aria-hidden="true" />
      <canvas ref={grain} className="avatar-grain" hidden={mode === "live"} aria-hidden="true" />
      <video ref={live} muted playsInline autoPlay className={`live${mode === "live" ? " on" : ""}`} />
    </div>
  );
}
