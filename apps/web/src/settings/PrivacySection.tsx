import { useEffect, useState } from "react";
import { connectionTrainingRisk, type PrivacyMode } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { TrainTag } from "../privacy";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Privacy { mode: PrivacyMode; neverSend: string[] }

/**
 * Settings › Privacy: what happens when a message, a file or a task going to a service that may train on it holds
 * keys, passwords or personal info (always ask, hide it, or never send it there), the user's own "never send" list,
 * and which connected services may train. Changeable from the phone too: no choice turns the guard off.
 */
export function PrivacySection() {
  const [p, setP] = useState<Privacy | null>(null);
  const [list, setList] = useState("");
  const [training, setTraining] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void api<Privacy>("/api/privacy").then((x) => { setP(x); setList(x.neverSend.join("\n")); }, () => undefined);
    void api<Array<{ id: string; name?: string }>>("/api/providers").then((l) => setTraining(l.filter((c) => connectionTrainingRisk(c.id)).map((c) => ({ id: c.id, name: c.name ?? c.id }))), () => undefined);
  }, []);
  if (!p) return null;
  const save = (next: Partial<Privacy>) =>
    void api<Privacy>("/api/privacy", { method: "PUT", body: { ...p, ...next } }).then((x) => { setP(x); setList(x.neverSend.join("\n")); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  const modes: Array<[PrivacyMode, string, string]> = [
    ["ask", L("לשאול אותי (ברירת מחדל)", "Ask me (default)"), L("חלון לפני השליחה: להסתיר ולשלוח, לשלוח למודל מקומי או למודל שלא מאמן, או לבטל. משימות שרצות בלי אף אחד מסתירות לבד.", "A window before sending: hide and send, send to a local model or one that does not train, or cancel. Tasks that run with no one watching hide it themselves.")],
    ["auto-hide", L("להסתיר לבד", "Hide it myself"), L("מה שנמצא מוחלף ב-[key hidden] וכדומה, בלי לשאול.", "What is found becomes [key hidden] and the like, without asking.")],
    ["block-training-providers", L("לא לשלוח לשירותים שמאמנים", "Never send it to services that train"), L("הודעה או משימה עם מידע רגיש לא נשלחת אליהם בכלל; אפשר לבחור מודל אחר.", "A message or task with sensitive info is not sent to them at all; you can pick another model.")],
  ];
  return (
    <section className="card stack" id="privacy-guard">
      <h2>🛡 {L("הגנה מדליפת מידע", "Leak guard")}</h2>
      <p className="muted">
        {L("חלק מהשירותים (למשל מפתח Gemini חינמי, Mistral החינמי, NVIDIA, ומודלים חינמיים ב-OpenRouter) עשויים לאמן על מה שנשלח אליהם. לפני שהודעה, קובץ שסוכן קרא או משימה נשלחים אליהם, KesherAI מחפש מפתחות וטוקנים, סיסמאות, קבצי .env, מפתחות פרטיים, מיילים, טלפונים, מספרי זהות וכרטיסי אשראי, ונתיבים עם שם המשתמש שלך.", "Some services (for example a free Gemini key, Mistral's free plan, NVIDIA, and OpenRouter's free models) may train on what they are sent. Before a message, a file an agent read, or a task goes to them, KesherAI looks for keys and tokens, passwords, .env files, private keys, emails, phone numbers, ID and card numbers, and paths with your user name.")}
      </p>
      <fieldset className="stack small">
        <legend>{L("כשנמצא מידע רגיש", "When sensitive info is found")}</legend>
        {modes.map(([v, label, note]) => (
          <label key={v} className="check privacy-mode">
            <input type="radio" name="privacy-mode" checked={p.mode === v} onChange={() => save({ mode: v })} />
            <span className="stack">
              <span>{label}</span>
              <span className="muted small">{note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="stack small">
        {L("לעולם לא לשלוח (מילים, קבצים או תיקיות, שורה לכל אחד)", "Never send (words, files or folders, one per line)")}
        <textarea dir="auto" rows={4} value={list} onChange={(e) => setList(e.target.value)} placeholder={L("שם הפרויקט הסודי\nsalary.xlsx\nclients/", "Secret project name\nsalary.xlsx\nclients/")} />
      </label>
      <button type="button" style={{ alignSelf: "start" }} onClick={() => save({ neverSend: list.split("\n").map((x) => x.trim()).filter(Boolean) })}>{L("שמור את הרשימה", "Save the list")}</button>
      <div className="stack small">
        <strong>{L("שירותים מחוברים שעשויים לאמן", "Connected services that may train")}</strong>
        {training.length === 0 && <span className="muted">{L("אין כאלה כרגע.", "None right now.")}</span>}
        {training.map((c) => (
          <span key={c.id} className="row privacy-service"><bdi>{c.name}</bdi> <TrainTag connection={c.id} /></span>
        ))}
      </div>
    </section>
  );
}
