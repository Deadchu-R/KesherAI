import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Model { id: string; name: string; category?: string }

/**
 * Settings → Models → the model team (design ModelTeam, RESEARCH_LOG "Hebrew answers while coding"): the coding model
 * works with the user's own words; when its final answer comes out in another language or with mixed alphabets, the
 * translator puts the prose into the user's language and leaves code, files and commands as they are.
 */
export function ModelTeamSection() {
  const [translator, setTranslator] = useState<string | null>(null);
  const [toolCap, setToolCap] = useState(24);
  const [smallTurns, setSmallTurns] = useState(true);
  const [shortAnswers, setShortAnswers] = useState(true);
  const [stopOnLow, setStopOnLow] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  // Downloaded translation models (TranslateGemma…): chosen by file, loaded beside the main model when needed.
  const [files, setFiles] = useState<Array<{ path: string; name: string }>>([]);
  useEffect(() => {
    void api<{ translator: string; toolCap?: number; smallTurns?: boolean; shortAnswers?: boolean; stopOnLowMemory?: boolean }>("/api/model-team").then((r) => {
      setTranslator(r.translator);
      if (r.toolCap) setToolCap(r.toolCap);
      setSmallTurns(r.smallTurns !== false);
      setShortAnswers(r.shortAnswers !== false);
      setStopOnLow(r.stopOnLowMemory !== false);
    }, () => undefined);
    void api<{ models: Model[] }>("/api/models").then((r) => setModels(r.models.filter((m) => (m.category ?? "chat") === "chat")), () => undefined);
    void api<Array<{ path: string; name: string; gguf?: boolean; source?: string }>>("/api/models/local").then((r) => setFiles(r.filter((m) => m.gguf && m.source === "KesherAI" && /translat/i.test(m.name)).map((m) => ({ path: m.path, name: m.name.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "") }))), () => undefined);
  }, []);
  if (translator === null) return null;
  const save = (v: string) => {
    setTranslator(v);
    void api("/api/model-team", { method: "PUT", body: { translator: v } }).catch((e: Error) => toast(e.message));
  };
  const saveSmall = (on: boolean) => {
    setSmallTurns(on);
    void api("/api/model-team", { method: "PUT", body: { smallTurns: on } }).catch((e: Error) => toast(e.message));
  };
  const saveShort = (on: boolean) => {
    setShortAnswers(on);
    void api("/api/model-team", { method: "PUT", body: { shortAnswers: on } }).catch((e: Error) => toast(e.message));
  };
  const saveStopOnLow = (on: boolean) => {
    setStopOnLow(on);
    void api("/api/model-team", { method: "PUT", body: { stopOnLowMemory: on } }).catch((e: Error) => toast(e.message));
  };
  const saveCap = (n: number) => {
    setToolCap(n);
    void api("/api/model-team", { method: "PUT", body: { toolCap: n } }).catch((e: Error) => toast(e.message));
  };
  return (
    <section className="card stack">
      <h2>{L("צוות המודלים", "The model team")}</h2>
      <p className="muted small">{L("המודל של הצ'אט מקבל את מה שכתבת כמו שהוא. אם התשובה שלו יוצאת באנגלית או עם אותיות משפות אחרות, המתרגם מעביר את הטקסט לשפה שבה כתבת. קוד, קבצים ופקודות נשארים כמו שהם.", "The chat's model gets your words as they are. When its answer comes out in English or with letters of other languages, the translator puts the text into the language you wrote in. Code, files and commands stay as they are.")}</p>
      <label className="row">
        <span className="grow">🗣️ {L("המתרגם", "The translator")}</span>
        <select value={translator} onChange={(e) => save(e.target.value)} aria-label={L("המתרגם", "The translator")}>
          <option value="main">{L("המודל של הצ'אט", "The chat's own model")}</option>
          {files.map((f) => <option key={f.path} value={f.path}>🌐 {f.name} {L("(מודל תרגום, נטען ליד הראשי)", "(translation model, loaded beside the main one)")}</option>)}
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          <option value="off">{L("כבוי", "Off")}</option>
        </select>
      </label>
      <p className="muted small">{L("מודל תרגום קטן (TranslateGemma) מהיר יותר מהמודל הגדול. הורד אותו מעמוד המודלים ובחר אותו כאן.", "A small translation model (TranslateGemma) is faster than the big one. Download it on the Models page and choose it here.")}</p>
      <label className="row">
        <span className="grow">🧰 {L("כלים מלאים בכל סבב", "Tools in full per turn")}</span>
        <select value={toolCap} onChange={(e) => saveCap(Number(e.target.value))} aria-label={L("כלים מלאים בכל סבב", "Tools in full per turn")}>
          {[...new Set([12, 16, 24, 32, 48, toolCap])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <p className="muted small">{L("במודל מקומי נשלחים במלואם רק הכלים שהסבב צריך, עד המספר הזה; השאר זמינים לפי שם (more_tools). פחות כלים = פחות טוקנים ותשובה מהירה יותר.", "On a local model only the tools a turn needs are sent in full, up to this number; the rest stay available by name (more_tools). Fewer tools = fewer tokens and a faster answer.")}</p>
      <label className="row">
        <input type="checkbox" checked={smallTurns} onChange={(e) => saveSmall(e.target.checked)} />
        <span className="grow">⚡ {L("הודעות פשוטות למודל הקטן", "Simple messages to the small model")}</span>
      </label>
      <p className="muted small">{L("כשמודל קטן טעון ליד הראשי (מודלים > צ'אט), הודעה קצרה ופשוטה (שלום, תודה, שאלה קצרה) נענית בו, מהר יותר. קוד, קבצים וכלים נשארים אצל המודל הראשי.", "When a small model is loaded beside the main one (Models > Chat), a short, simple message (hello, thanks, a short question) is answered by it, faster. Code, files and tools stay with the main model.")}</p>
      <label className="row">
        <input type="checkbox" checked={shortAnswers} onChange={(e) => saveShort(e.target.checked)} />
        <span className="grow">✂️ {L("לענות כמו Claude (לסיים את העבודה, תשובות קצרות)", "Answer like Claude (finish the job, short answers)")}</span>
      </label>
      <p className="muted small">{L("במודל מקומי: אם התשובה הסופית ארוכה ומונה את כל השלבים שנעשו, או שנכתבה באנגלית למי שכתב בעברית, המודל מתבקש פעם אחת לכתוב אותה מחדש: מה יצא, הקובץ, והצעד הבא.", "On a local model: when the final answer is long and lists every step taken, or is in English for someone who wrote Hebrew, the model is asked once to rewrite it: what came out, the file, and the next step.")}</p>
      <label className="row">
        <input type="checkbox" checked={stopOnLow} onChange={(e) => saveStopOnLow(e.target.checked)} />
        <span className="grow">🧠 {L("לעצור פקודות ברקע כשהזיכרון נגמר", "Stop background commands when memory runs low")}</span>
      </label>
      <p className="muted small">{L("כשהמחשב כמעט בלי זיכרון פנוי, הפקודה החדשה ביותר שרצה ברקע נעצרת ראשונה, והצ'אט והטלפון מקבלים הודעה.", "When the computer is almost out of free memory, the newest background command is stopped first, and the chat and the phone are told.")}</p>
    </section>
  );
}
