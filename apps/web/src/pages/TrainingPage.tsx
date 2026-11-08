import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Kind { id: "image-lora" | "chat-lora" | "voice"; ready: boolean; notes: string[]; bases?: Array<{ name: string; family: "sd15" | "sdxl" | "other" }>; estimate?: string }
interface Job { id: string; name: string; base: string; status: "running" | "done" | "error"; startedAt: string; finishedAt?: string; message?: string; file?: string; steps: number }

const KIND_TITLE: Record<Kind["id"], [string, string, string, string]> = {
  "image-lora": ["🎨", "סגנון או דמות לתמונות (LoRA)", "A style or a character for pictures (LoRA)", ""],
  "chat-lora": ["💬", "מודל צ'אט שמכיר את הטקסטים שלך", "A chat model that knows your texts", ""],
  voice: ["🎙", "קול משלך", "A voice of your own", ""],
};
const NOTES_HE: Array<[RegExp, string]> = [
  [/^Needs an NVIDIA/, "צריך כרטיס מסך של NVIDIA: \u20668 GB\u2069 ומעלה ל-\u2066SD 1.5\u2069, ו-\u206612 GB\u2069 ומעלה ל-SDXL."],
  [/^This card has/, "לכרטיס הזה אין מספיק זיכרון: צריך \u20668 GB\u2069 ומעלה."],
  [/^Needs ComfyUI/, "צריך את ComfyUI: מתקינים פעם אחת בדף הנודים."],
  [/^Start ComfyUI/, "קודם מפעילים את ComfyUI (דף הנודים)."],
  [/too old for training/, "ה-ComfyUI ישן מדי לאימון: עדכן אותו בדף הנודים."],
  [/^Needs a base model/, "צריך מודל בסיס (checkpoint של SD 1.5 או SDXL) בתיקיית models/checkpoints של ComfyUI."],
  [/^ComfyUI did not answer/, "ComfyUI לא ענה."],
  [/^Coming next/, "בקרוב: ללמד מודל צ'אט את הכתיבה או הפתקים שלך (LoRA על הטקסטים)."],
  [/^Later: a voice/, "בהמשך: קול משלך מכמה דקות של דיבור."],
];
const note = (n: string) => (getLocale() === "he" ? NOTES_HE.find(([re]) => re.test(n))?.[1] ?? n : n);

/** Reads a picture as base64, made smaller (at most 1024 px) like training expects. */
async function prepare(file: File): Promise<{ data: string; mimeType: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return { data: c.toDataURL("image/jpeg", 0.92).split(",")[1]!, mimeType: "image/jpeg" };
}

/**
 * Train: what this computer can train, and step one — a picture LoRA from
 * your own pictures (a style, a character, an object), used on the Images
 * page when it is done.
 */
export function TrainingPage() {
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [base, setBase] = useState("");
  const [steps, setSteps] = useState(600);
  const [busy, setBusy] = useState(false);
  const load = () => void api<{ kinds: Kind[]; jobs: Job[] }>("/api/training").then((r) => { setKinds(r.kinds); setJobs(r.jobs); setBase((b) => b || r.kinds[0]?.bases?.find((x) => x.family !== "other")?.name || r.kinds[0]?.bases?.[0]?.name || ""); }, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const pic = kinds.find((k) => k.id === "image-lora");
  const running = jobs.some((j) => j.status === "running");
  const start = async () => {
    setBusy(true);
    try {
      const images = await Promise.all(files.map(prepare));
      await api("/api/training/image-lora", { method: "POST", body: { name, trigger, base, steps, images } });
      setFiles([]);
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page training">
      <h1>{L("אימון מודלים", "Train models")}</h1>
      <p className="muted">{L("ללמד מודל משהו שלך, במחשב שלך. כאן רואים מה המחשב הזה יכול לאמן ומה צריך בשביל זה.", "Teach a model something of yours, on your computer. Here you see what this computer can train, and what it needs.")}</p>

      <div className="train-kinds">
        {kinds.map((k) => (
          <section key={k.id} className={`card train-kind${k.ready ? " ready" : ""}`}>
            <h2><span aria-hidden="true">{KIND_TITLE[k.id][0]}</span> {L(KIND_TITLE[k.id][1], KIND_TITLE[k.id][2])}</h2>
            <p className={k.ready ? "good small" : "muted small"}>{k.ready ? L("✓ המחשב הזה יכול לאמן את זה", "✓ This computer can train this") : L("עוד לא", "Not yet")}</p>
            {k.notes.map((n) => <p key={n} className="small">{note(n)}</p>)}
            {k.estimate && k.ready && <p className="muted small">{getLocale() === "he" ? (k.estimate.includes("15–30") ? "בערך 15–30 דקות (SDXL, ‏600 צעדים)." : "בערך 30–60 דקות (SD 1.5 מהיר יותר מ-SDXL).") : k.estimate}</p>}
          </section>
        ))}
      </div>

      {pic?.ready && (
        <section className="card stack">
          <h2>{L("אימון LoRA לתמונות", "Train a picture LoRA")}</h2>
          <p className="muted small">{L("10–30 תמונות של אותו סגנון, דמות או חפץ, מזוויות ובתאורות שונות. בסוף זה מופיע בדף התמונות, וכותבים את מילת ההפעלה בבקשה.", "10–30 pictures of one style, character or object, from different angles and light. When it is done it shows on the Images page; write the trigger word in your prompt.")}</p>
          <div className="look-grid">
            <label>{L("שם", "Name")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={L("למשל: החתול שלי", "e.g. my-cat")} /></label>
            <label>{L("מילת הפעלה", "Trigger word")}<input dir="ltr" value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="mycat" /></label>
            <label>{L("מודל בסיס", "Base model")}
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                {pic.bases?.map((b) => <option key={b.name} value={b.name}>{b.name}{b.family === "sdxl" ? " (SDXL)" : b.family === "sd15" ? " (SD 1.5)" : ""}</option>)}
              </select>
            </label>
            <label>{L("צעדים", "Steps")} <small className="muted">{steps}</small><input type="range" min={200} max={2000} step={100} value={steps} onChange={(e) => setSteps(Number(e.target.value))} /></label>
          </div>
          <label className="look-pick">{L(`בחר תמונות… (${files.length})`, `Choose pictures… (${files.length})`)}<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 60))} /></label>
          {files.length > 0 && (
            <div className="train-thumbs">{files.slice(0, 30).map((f) => <img key={f.name + f.size} src={URL.createObjectURL(f)} alt="" />)}</div>
          )}
          <div className="row">
            <button type="button" className="primary" disabled={busy || running || files.length < 5 || !name.trim() || !base} onClick={() => void start()}>{busy ? L("שולח…", "Sending…") : L("התחל אימון", "Start training")}</button>
            {files.length > 0 && files.length < 5 && <span className="muted small">{L("צריך לפחות 5 תמונות.", "At least 5 pictures.")}</span>}
          </div>
        </section>
      )}

      {jobs.length > 0 && (
        <section className="card stack">
          <h2>{L("אימונים", "Trainings")}</h2>
          <ul className="train-jobs">
            {jobs.map((j) => (
              <li key={j.id} className={j.status}>
                <b>{j.name}</b> <span className="muted small" dir="ltr">{j.base} · {j.steps} steps</span>
                <span className="grow" />
                {j.status === "running" ? (
                  <>
                    <span className="small">⏳ {L("מתאמן…", "Training…")}</span>
                    <button type="button" onClick={() => void api("/api/training/stop", { method: "POST" }).then(load)}>{L("עצור", "Stop")}</button>
                  </>
                ) : j.status === "done" ? (
                  <a href="#/images">{L("✓ להשתמש בתמונות", "✓ Use it in Images")}</a>
                ) : (
                  <span className="bad small">{j.message}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
