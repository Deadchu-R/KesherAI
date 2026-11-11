/**
 * Cards on the Models page for the kinds beyond chat and images (video, speech-to-text, text-to-speech,
 * embeddings; music and 3D through ComfyUI): what each kind does, which engine runs it, what is installed and
 * active, a picker for the active one, and what to download when there is none.
 */
import { useEffect, useState } from "react";
import type { ModelInfo } from "@kesher/shared";
import { api, withToken } from "./api";
import { getLocale } from "./i18n";
import { DownloadsMatching, useDownloads } from "./Downloads";
import { toast } from "./library";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Kind {
  ready: boolean;
  busy: boolean;
  error?: string;
  model?: string;
  name: string;
  sizeGb: number;
  setup: string | null;
  voices?: Array<{ id: number; name: string; lang: string }>;
  active?: string | null;
  comfy?: { ready: boolean; missingGb: number };
}
type Kinds = Record<"video" | "speech-to-text" | "text-to-speech" | "embedding", Kind>;

const TEXT: Record<string, { title: [string, string]; what: [string, string]; where: [string, string]; dl: RegExp }> = {
  video: {
    title: ["וידאו", "Video"],
    what: ["סרטונים קצרים מתיאור במילים (Wan 2.1 1.3B, כשתי שניות ב-480p). מבקשים בצ'אט: \"תעשה סרטון של…\".", "Short clips from a description (Wan 2.1 1.3B, about two seconds at 480p). Ask in a chat: \"make a video of…\"."],
    where: ["המנוע המובנה: stable-diffusion.cpp, צריך כ-8 GB זיכרון גרפי.", "Built-in engine: stable-diffusion.cpp, needs about 8 GB of graphics memory."],
    dl: /wan|umt5|video/i,
  },
  "speech-to-text": {
    title: ["דיבור לטקסט", "Speech to text"],
    what: ["תמלול: כפתור המיקרופון בצ'אט, שיחה קולית, והקלטת פגישות ביום שלי.", "Transcription: the chat's microphone button, voice mode, and meeting recordings in My day."],
    where: ["המנוע: whisper.cpp, על המחשב, בלי אינטרנט.", "Engine: whisper.cpp, on this computer, offline."],
    dl: /whisper/i,
  },
  "text-to-speech": {
    title: ["טקסט לדיבור", "Text to speech"],
    what: ["קול טבעי שמקריא תשובות (🔊 ליד תשובה, ושיחה קולית).", "A natural voice that reads answers aloud (🔊 next to an answer, and voice mode)."],
    where: ["המנוע: Kokoro, על המחשב, בלי אינטרנט. אנגלית ושפות אירופיות; עברית מוקראת בקול של המערכת.", "Engine: Kokoro, on this computer, offline. English and European languages; Hebrew is read by the system voice."],
    dl: /kokoro|sherpa/i,
  },
  embedding: {
    title: ["חיפוש לפי משמעות (embedding)", "Search by meaning (embedding)"],
    what: ["מאגרי הידע ובחיפוש בשיחות: מוצא קטעים לפי משמעות, בכל שפה, ולא רק לפי מילים זהות.", "Knowledge bases and chat search: finds passages by meaning, in any language, not only by the same words."],
    where: ["המנוע: llama.cpp עם Qwen3 Embedding, על המחשב.", "Engine: llama.cpp with Qwen3 Embedding, on this computer."],
    dl: /embedding/i,
  },
};

/**
 * A model kind on the Models page (video, speech, voice, search by
 * meaning): what it does, whether it is ready, one button to set it up, and
 * its downloads with their percent.
 */
export function ModelKindCard({ kind }: { kind: keyof Kinds }) {
  const [k, setK] = useState<Kinds | null>(null);
  const [busy, setBusy] = useState(false);
  const done = useDownloads().filter((j) => j.status === "done").length;
  const load = () => void api<Kinds>("/api/models/kinds").then(setK, () => undefined);
  useEffect(load, [done]);
  useEffect(() => {
    if (!k?.[kind]?.busy) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [k?.[kind]?.busy]);
  const x = k?.[kind];
  const text = TEXT[kind]!;
  if (!x) return null;
  const he = getLocale() === "he";
  const setup = async (path: string) => {
    setBusy(true);
    try {
      const r = await api<{ message?: string }>(path, { method: "POST" });
      if (r?.message) toast(r.message.replace(/ Tell the user.*$/, ""));
      setTimeout(load, 800);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const play = async (voice: number) => {
    try {
      const res = await fetch(withToken("/api/speech/tts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello! This is how I sound in KesherAI.", provider: "local", voice }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      void new Audio(URL.createObjectURL(await res.blob())).play();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section className="card stack">
      <div className="row">
        <h2 className="grow">{text.title[he ? 0 : 1]}</h2>
        {x.ready ? <span className="pill good">{L("מוכן", "Ready")}</span> : x.busy ? <span className="pill">{L("מוריד…", "Downloading…")}</span> : <span className="pill">{L("לא מותקן", "Not set up")}</span>}
      </div>
      <p>{text.what[he ? 0 : 1]}</p>
      <p className="muted small">{text.where[he ? 0 : 1]} {x.model && <span dir="ltr" className="mono">· {x.model}</span>}</p>
      {x.error && <p className="error">{x.error}</p>}
      {!x.ready && !x.busy && x.setup && (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void setup(x.setup!)}>
            {L(`התקן בלחיצה (${x.name}, כ-${x.sizeGb.toFixed(1)} GB)`, `Set it up (${x.name}, about ${x.sizeGb.toFixed(1)} GB)`)}
          </button>
        </div>
      )}
      {!x.setup && !x.ready && <p className="muted small">{L("אין למנוע הזה גרסה למערכת הזאת; אפשר לחבר שירות ענן בחיבורים.", "This engine has no version for this system; you can connect a cloud service under Connections.")}</p>}
      <DownloadsMatching match={text.dl} />
      {kind === "text-to-speech" && x.ready && x.voices && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="muted small">{L("שמע קולות:", "Hear the voices:")}</span>
          {x.voices.map((v) => <button key={v.id} type="button" onClick={() => void play(v.id)}>▶ {v.name}</button>)}
        </div>
      )}
      {kind === "video" && <VideoChoice k={x} onChange={load} setup={setup} />}
    </section>
  );
}


/** Which engine makes the videos: the built-in one, or ComfyUI's Wan workflow. */
function VideoChoice({ k, onChange, setup }: { k: Kind; onChange: () => void; setup: (path: string) => Promise<void> }) {
  const [comfyModels, setComfyModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    void api<{ models: ModelInfo[] }>("/api/models").then((l) => setComfyModels(l.models.filter((m) => m.category === "video")), () => undefined);
  }, [k.comfy?.ready]);
  const use = async (id: string) => {
    const s = await api<{ activeModels: Record<string, string> }>("/api/settings");
    const next = { ...s.activeModels };
    if (id) next.video = id;
    else delete next.video;
    await api("/api/settings", { method: "PUT", body: { activeModels: next } });
    onChange();
  };
  const viaComfy = !!k.active && comfyModels.some((m) => m.id === k.active);
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <strong>{L("עם ComfyUI", "With ComfyUI")}</strong>
      <p className="muted small">{L("אותו מודל Wan רץ גם ב-ComfyUI (מהיר יותר בכרטיסי NVIDIA, ואפשר לערוך את הזרימה בעמוד הנודים). ComfyUI צריך גם מקודד טקסט משלו (כ-6.7 GB).", "The same Wan model also runs in ComfyUI (faster on NVIDIA cards, and you can edit the flow on the Nodes page). ComfyUI needs its own text encoder too (about 6.7 GB).")}</p>
      {k.comfy && !k.comfy.ready && (
        <div className="row"><button type="button" onClick={() => void setup("/api/models/setup/comfy-video")}>{L(`הכן את Wan ל-ComfyUI (כ-${k.comfy.missingGb.toFixed(1)} GB)`, `Set up Wan in ComfyUI (about ${k.comfy.missingGb.toFixed(1)} GB)`)}</button></div>
      )}
      {k.comfy?.ready && !comfyModels.length && <p className="muted small">{L("הקבצים מוכנים. הפעל את ComfyUI למטה, והוא יופיע כאן לבחירה.", "The files are ready. Start ComfyUI below and it shows up here to choose.")}</p>}
      {comfyModels.length > 0 && (
        <label className="row" style={{ gap: 8 }}>
          {L("מי מייצר את הסרטונים:", "Who makes the videos:")}
          <Select value={viaComfy ? k.active! : ""} onChange={(e) => void use(e.target.value)}>
            <option value="">{L("המנוע המובנה (stable-diffusion.cpp)", "The built-in engine (stable-diffusion.cpp)")}</option>
            {comfyModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </label>
      )}
    </div>
  );
}

/** Music and 3D: no built-in engine yet; ComfyUI (with the right custom nodes) can run them. */
export function ComfyOnlyKind({ kind }: { kind: "music" | "3d" }) {
  const he = getLocale() === "he";
  const t = kind === "music"
    ? [["מוזיקה", "Music"], ["מנוע מוזיקה מובנה (ACE-Step) עוד לא נכנס: אין לו גרסה יציבה, והוא כ-7.7 GB. בינתיים: ACE-Step רץ ב-ComfyUI. התקן את ComfyUI למטה, טען את זרימת ACE-Step בעמוד הנודים, וזה עובד.", "A built-in music engine (ACE-Step) is not in yet: it has no stable release and is about 7.7 GB. Meanwhile ACE-Step runs in ComfyUI: install ComfyUI below, load the ACE-Step flow on the Nodes page, and it works."]]
    : [["תלת-ממד", "3D"], ["אין עדיין מנוע תלת-ממד מובנה. ComfyUI מריץ מודלי תלת-ממד (כמו Hunyuan3D) בעזרת נודים נוספים: התקן את ComfyUI למטה ועבוד איתם בעמוד הנודים.", "There is no built-in 3D engine yet. ComfyUI runs 3D models (such as Hunyuan3D) with extra nodes: install ComfyUI below and work with them on the Nodes page."]];
  return (
    <section className="card stack">
      <h2>{t[0]![he ? 0 : 1]}</h2>
      <p>{t[1]![he ? 0 : 1]}</p>
      <div className="row"><a className="button" href="#/nodes">{L("פתח את עמוד הנודים", "Open the Nodes page")}</a></div>
    </section>
  );
}
