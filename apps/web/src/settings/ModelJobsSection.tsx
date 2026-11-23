/**
 * "Models per job" (Settings › General): every job KesherAI runs a model for (chat, the small model beside it,
 * pictures, video, speech both ways, search by meaning, music, 3D, the translator, computer vision) with the model it
 * uses now. A job without one (or whose chosen file is gone) shows the model that fits this computer best:
 * "Suggested: <name> · <size> GB · [Download and use]". Nothing downloads without that tap; "Set up everything
 * missing" asks once with the total size and the free disk. Each tap posts the job's existing setup route, so it
 * works the same from the phone (through the hub). Server side: routes/model-jobs.ts, picking in core model-jobs.ts.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { useDownloads } from "../Downloads";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type JobId = "chat" | "router" | "image" | "video" | "speech-to-text" | "text-to-speech" | "hebrew-voice" | "embedding" | "music" | "3d" | "translator" | "vision";
interface Suggestion { name: string; sizeGb: number; fit: "gpu" | "partial" | "too-big" | "unknown"; onComputer: boolean; setup: string; body?: Record<string, unknown>; canSetup: boolean }
/** A model for the job found on the computer that KesherAI does not use, and why. */
interface Unused { name: string; whyHe: string; whyEn: string }
interface Job { id: JobId; state: "ready" | "busy" | "missing" | "none" | "manual"; current: string | null; suggestion?: Suggestion; link: string; unused?: Unused[] }
interface Jobs { jobs: Job[]; plan: { ids: JobId[]; totalGb: number }; freeGb?: number }

/** Each job's name and what it is for. */
const TEXT: Record<JobId, [string, string, string, string]> = {
  chat: ["צ'אט וקוד", "Chat & code", "כל צ'אט, שיחה קולית ופעולות טקסט", "Every chat, voice mode and text actions"],
  router: ["מודל קטן לצד הראשי", "Small model beside", "בוחר מודל לכל הודעה ועונה על הודעות פשוטות", "Picks a model per message and answers simple ones"],
  image: ["תמונות", "Images", "יצירת תמונות בצ'אט ובעמוד התמונות", "Pictures in chats and on the Images page"],
  video: ["וידאו", "Video", "סרטונים קצרים מתיאור", "Short clips from a description"],
  "speech-to-text": ["דיבור לטקסט", "Speech to text", "מיקרופון, שיחה קולית, הרצאות ופגישות", "Microphone, voice mode, lectures and meetings"],
  "text-to-speech": ["טקסט לדיבור", "Text to speech", "הקראת תשובות באנגלית (Kokoro)", "Reading answers aloud in English (Kokoro)"],
  "hebrew-voice": ["קול לעברית", "Hebrew voice", "הקראה בעברית ושיחה קולית בעברית", "Reading Hebrew aloud and Hebrew voice mode"],
  embedding: ["חיפוש לפי משמעות", "Search by meaning", "מאגרי ידע וחיפוש בשיחות", "Knowledge bases and chat search"],
  music: ["מוזיקה ואפקטים", "Music & SFX", "נבחר ב-ComfyUI (עמוד הנודים)", "Chosen in ComfyUI (Nodes page)"],
  "3d": ["תלת-ממד", "3D", "נבחר ב-ComfyUI (עמוד הנודים)", "Chosen in ComfyUI (Nodes page)"],
  translator: ["מתרגם התשובות", "Answer translator", "מתרגם תשובה שיצאה בשפה אחרת", "Translates an answer that came out in another language"],
  vision: ["ראייה לשליטה במחשב", "Vision for computer control", "מוצא כפתורים בצילום מסך", "Finds buttons on a screenshot"],
};

/** The current model as words ("main", "off" and "auto" are settings, not models). */
function currentText(j: Job): string {
  if (j.current === "main") return L("המודל של הצ'אט", "The chat's model");
  if (j.current === "off") return L("כבוי", "Off");
  if (j.current === "auto") return L("אוטומטי", "Auto");
  return j.current ?? L("אין", "None");
}

const fitText = (s: Suggestion) =>
  s.onComputer ? L("כבר במחשב", "already on this computer") : s.fit === "gpu" ? L("נכנס לכרטיס", "fits the card") : s.fit === "partial" ? L("חלקו בזיכרון, איטי יותר", "partly in memory, slower") : "";

/** The "Models per job" card. */
export function ModelJobsSection() {
  const [d, setD] = useState<Jobs | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const done = useDownloads().filter((j) => j.status === "done").length;
  const load = () => void api<Jobs>(`/api/models/jobs?lang=${getLocale()}`).then(setD, () => undefined);
  useEffect(load, [done]);
  const anyBusy = !!d?.jobs.some((j) => j.state === "busy");
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [anyBusy]);
  if (!d) return null;

  /** Posts one job's setup route; returns an error message or undefined. */
  const start = async (j: Job): Promise<string | undefined> => {
    const s = j.suggestion!;
    try {
      const r = await api<{ message?: string; error?: string }>(s.setup, { method: "POST", ...(s.body ? { body: s.body } : {}) });
      if (r?.message) toast(r.message.replace(/ Tell the user.*$/, ""));
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const one = async (j: Job) => {
    setBusy(j.id);
    const err = await start(j);
    toast(err ?? (j.suggestion!.onComputer ? L(`${j.suggestion!.name} מופעל.`, `Turning on ${j.suggestion!.name}.`) : L("ההורדה התחילה. אפשר לעקוב בעיגול ההורדות.", "The download started; follow it in the downloads circle.")));
    setBusy(null);
    setTimeout(load, 800);
  };
  const all = async () => {
    setAsking(false);
    setBusy("all");
    const failed: string[] = [];
    for (const id of d.plan.ids) {
      const j = d.jobs.find((x) => x.id === id);
      if (!j?.suggestion) continue;
      const err = await start(j);
      if (err) failed.push(`${TEXT[j.id][getLocale() === "he" ? 0 : 1]}: ${err}`);
    }
    toast(failed.length ? L(`חלק לא התחיל: ${failed.join(" · ")}`, `Some did not start: ${failed.join(" · ")}`) : L("הכול התחיל. אפשר לעקוב בעיגול ההורדות.", "Everything started; follow it in the downloads circle."));
    setBusy(null);
    setTimeout(load, 800);
  };
  const he = getLocale() === "he";
  const lowDisk = d.freeGb !== undefined && d.freeGb < d.plan.totalGb + 5;

  return (
    <section className="card stack model-jobs">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 className="grow">{L("מודל לכל תפקיד", "Models per job")}</h2>
        {d.plan.ids.length > 0 && !asking && (
          <button type="button" className="primary small" disabled={!!busy} onClick={() => setAsking(true)}>{L("הגדר את כל מה שחסר", "Set up everything missing")}</button>
        )}
      </div>
      <p className="muted small">{L("לכל תפקיד המודל שהוא משתמש בו. כשאין מודל, KesherAI מציע את המתאים ביותר למחשב הזה. שום דבר לא יורד בלי לחיצה שלך.", "The model each job uses. When a job has none, KesherAI suggests the best fit for this computer. Nothing downloads until you tap.")}</p>
      {asking && (
        <div className="card stack" role="alertdialog" aria-label={L("אישור הורדה", "Confirm download")}>
          <strong>{L(`להוריד ${d.plan.ids.length} מודלים, כ-${d.plan.totalGb} GB בסך הכול?`, `Download ${d.plan.ids.length} models, about ${d.plan.totalGb} GB in all?`)}</strong>
          <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
            {d.plan.ids.map((id) => {
              const s = d.jobs.find((j) => j.id === id)!.suggestion!;
              return <li key={id}>{TEXT[id][he ? 0 : 1]}: <span dir="ltr">{s.name}</span> · {s.onComputer ? L("כבר במחשב", "on the computer") : `${s.sizeGb} GB`}</li>;
            })}
          </ul>
          {d.freeGb !== undefined && <span className={lowDisk ? "error small" : "muted small"}>{L(`פנוי בכונן המודלים: ${d.freeGb} GB`, `Free on the models drive: ${d.freeGb} GB`)}{lowDisk ? L(" (לא מספיק)", " (not enough)") : ""}</span>}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="primary" disabled={lowDisk} onClick={() => void all()}>{L("הורד והשתמש", "Download and use")}</button>
            <button type="button" onClick={() => setAsking(false)}>{L("ביטול", "Cancel")}</button>
          </div>
        </div>
      )}
      <ul className="model-jobs-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {d.jobs.map((j) => {
          const s = j.suggestion;
          return (
            <li key={j.id} className="stack model-job" style={{ borderTop: "1px solid var(--border)", padding: "8px 0", gap: 4 }}>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                <strong className="grow">{TEXT[j.id][he ? 0 : 1]}</strong>
                {j.state === "ready" && <span className="pill good small">{L("מוכן", "Ready")}</span>}
                {j.state === "busy" && <span className="pill small">{L("מתקין…", "Setting up…")}</span>}
                {j.state === "missing" && <span className="pill warn small">{L("הקובץ חסר", "File missing")}</span>}
                {j.state === "none" && <span className="pill small">{L("אין מודל", "No model")}</span>}
              </div>
              <span className="muted small">{TEXT[j.id][he ? 2 : 3]} · <span dir="ltr" style={{ overflowWrap: "anywhere" }}>{currentText(j)}</span> · <a href={j.link}>{L("שנה", "Change")}</a></span>
              {j.unused?.map((u) => (
                <span key={u.name} className="muted small" style={{ overflowWrap: "anywhere" }}>
                  {L("נמצא במחשב ולא בשימוש:", "On this computer, not used:")} <span dir="ltr">{u.name}</span> · {he ? he$(u.whyHe) : u.whyEn}
                </span>
              ))}
              {s && (
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="grow small">
                    {L("מוצע:", "Suggested:")} <b dir="ltr">{s.name}</b> · {s.onComputer ? fitText(s) : <>{s.sizeGb} GB{fitText(s) ? ` · ${fitText(s)}` : ""}</>}
                  </span>
                  {s.canSetup ? (
                    <button type="button" className="small" disabled={!!busy} onClick={() => void one(j)}>{busy === j.id ? "…" : s.onComputer ? L("השתמש", "Use it") : L("הורד והשתמש", "Download and use")}</button>
                  ) : (
                    <span className="muted small">{j.id === "embedding" ? L("אפשר להגדיר רק במחשב עצמו", "Can be set up only on the computer") : j.id === "router" ? L("אחרי שמנוע הצ'אט מותקן", "After the chat engine is installed") : L("המנוע עסוק, נסה שוב עוד רגע", "The engine is busy; try again soon")}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
