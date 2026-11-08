import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast, useLibrary } from "../library";

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
  [/^Make a dataset from your chats and documents, then train/, "מכינים מאגר מהצ'אטים והמסמכים שלך, ואז מאמנים אותו (ניסיוני, למטה)."],
  [/^Make a dataset from your chats and documents \(below\)\. Training/, "אפשר להכין מאגר מהצ'אטים והמסמכים (למטה). כדי לאמן אותו צריך כרטיס NVIDIA עם \u20668 GB\u2069 ומעלה."],
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
  const { conversations } = useLibrary();
  const [dsName, setDsName] = useState("my-texts");
  const [dsChats, setDsChats] = useState<string[]>([]);
  const [dsDocs, setDsDocs] = useState(true);
  const [datasets, setDatasets] = useState<Array<{ name: string; examples: number; bytes: number }>>([]);
  const loadDatasets = () => void api<typeof datasets>("/api/training/datasets").then(setDatasets, () => undefined);
  useEffect(loadDatasets, []);
  const [chat, setChat] = useState<{ installed: boolean; phase?: string; message?: string; log: string[]; result?: string; bases: Array<{ id: string; title: string; gb: number }>; vramGb: number } | null>(null);
  const [chatBase, setChatBase] = useState("");
  const [chatDs, setChatDs] = useState("");
  const [chatSteps, setChatSteps] = useState(200);
  const loadChat = () => void api<NonNullable<typeof chat>>("/api/training/chat").then((c) => { setChat(c); setChatBase((b) => b || c.bases[0]?.id || ""); }, () => undefined);
  useEffect(() => {
    loadChat();
    const t = setInterval(loadChat, 4000);
    return () => clearInterval(t);
  }, []);
  const buildDataset = async () => {
    try {
      const d = await api<{ examples: number; tokens: number }>("/api/training/datasets", { method: "POST", body: { name: dsName, chats: dsChats, documents: dsDocs } });
      toast(L(`נוצר מאגר עם ${d.examples} דוגמאות (בערך ${d.tokens.toLocaleString()} טוקנים).`, `Made a dataset with ${d.examples} examples (about ${d.tokens.toLocaleString()} tokens).`));
      loadDatasets();
    } catch (e) {
      toast((e as Error).message);
    }
  };
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

      <section className="card stack">
        <h2>{L("💬 מאגר אימון למודל צ'אט", "💬 A dataset for a chat model")}</h2>
        <p className="muted small">{L("הצ'אטים שתבחר נהיים זוגות של שאלה ותשובה, והמסמכים שלך נהיים דוגמאות של \"לכתוב בסגנון שלי\". הכל נשמר במחשב בפורמט JSONL שמתאים ל-unsloth ול-axolotl. צריך לפחות 20 דוגמאות, ומאות עדיף.", "The chats you pick become question → answer pairs, and your documents become \"write in my style\" examples, saved on this computer as JSONL (the format unsloth and axolotl read). At least 20 examples; hundreds is better.")}</p>
        <label>{L("שם", "Name")}<input value={dsName} onChange={(e) => setDsName(e.target.value)} /></label>
        <label className="row small"><input type="checkbox" checked={dsDocs} onChange={(e) => setDsDocs(e.target.checked)} /> {L("להוסיף את המסמכים שלי (דף המסמכים)", "Add my documents (the Pages page)")}</label>
        <details>
          <summary>{L(`צ'אטים (${dsChats.length} נבחרו)`, `Chats (${dsChats.length} picked)`)}</summary>
          <div className="row wrap"><button type="button" className="link-btn" onClick={() => setDsChats(conversations.map((c) => c.id))}>{L("בחר הכל", "Pick all")}</button><button type="button" className="link-btn" onClick={() => setDsChats([])}>{L("נקה", "Clear")}</button></div>
          <ul className="train-chats">
            {conversations.slice(0, 200).map((c) => (
              <li key={c.id}><label className="row small"><input type="checkbox" checked={dsChats.includes(c.id)} onChange={(e) => setDsChats(e.target.checked ? [...dsChats, c.id] : dsChats.filter((x) => x !== c.id))} /> <span dir="auto">{c.title}</span></label></li>
            ))}
          </ul>
        </details>
        <div><button type="button" className="primary" disabled={!dsName.trim() || (!dsChats.length && !dsDocs)} onClick={() => void buildDataset()}>{L("הכן מאגר", "Make the dataset")}</button></div>
        {datasets.length > 0 && <ul className="train-jobs">{datasets.map((d) => <li key={d.name}><b>{d.name}</b> <span className="muted small">{L(`${d.examples} דוגמאות`, `${d.examples} examples`)} · {`\u2066${(d.bytes / 1024).toFixed(0)} KB\u2069`}</span></li>)}</ul>}
      </section>

      {chat && chat.vramGb >= 8 && (
        <section className="card stack">
          <h2>{L("💬 אימון מודל צ'אט (ניסיוני)", "💬 Train a chat model (experimental)")}</h2>
          <p className="muted small">{L("LoRA על מודל צ'אט קטן, עם unsloth (קוד פתוח), בסביבת Python משלו. בסוף המודל נשמר כ-GGUF ומופיע עם מודלי הצ'אט. הגדרה חד-פעמית: הורדה של בערך \u20664 GB\u2069 (PyTorch ו-unsloth), ועוד המודל הבסיסי.", "A LoRA on a small chat model with unsloth (open source), in its own Python. The result is saved as a GGUF with your chat models. One-time setup: about 4 GB (PyTorch, unsloth), plus the base model.")}</p>
          {!chat.installed ? (
            <div><button type="button" className="primary" disabled={chat.phase === "installing"} onClick={() => confirm(L("להוריד ולהתקין את סביבת האימון (בערך 4GB)?", "Download and set up the trainer (about 4 GB)?")) && void api("/api/training/chat/install", { method: "POST" }).then(loadChat)}>{chat.phase === "installing" ? L("מתקין…", "Setting up…") : L("הכן את סביבת האימון", "Set up the trainer")}</button></div>
          ) : (
            <div className="look-grid">
              <label>{L("מאגר", "Dataset")}<select value={chatDs} onChange={(e) => setChatDs(e.target.value)}><option value="">{L("בחר…", "Choose…")}</option>{datasets.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.examples})</option>)}</select></label>
              <label>{L("מודל בסיס", "Base model")}<select value={chatBase} onChange={(e) => setChatBase(e.target.value)}>{chat.bases.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
              <label>{L("צעדים", "Steps")} <small className="muted">{chatSteps}</small><input type="range" min={50} max={1500} step={50} value={chatSteps} onChange={(e) => setChatSteps(Number(e.target.value))} /></label>
              <div className="look-field"><span>&nbsp;</span><button type="button" className="primary" disabled={!chatDs || chat.phase === "training"} onClick={() => void api("/api/training/chat", { method: "POST", body: { name: chatDs, dataset: chatDs, base: chatBase, steps: chatSteps } }).then(loadChat, (e: Error) => toast(e.message))}>{chat.phase === "training" ? L("מתאמן…", "Training…") : L("התחל אימון", "Start training")}</button></div>
            </div>
          )}
          {chat.message && <p className={chat.phase === "error" ? "bad small" : "small"}>{chat.message}</p>}
          {chat.log.length > 0 && <details><summary className="small">{L("יומן", "Log")}</summary><pre className="code small" dir="ltr">{chat.log.slice(-30).join("\n")}</pre></details>}
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
