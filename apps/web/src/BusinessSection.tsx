import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface CopilotStatus { configured: boolean; connected: boolean; email: string | null; web: boolean; lastError: string | null; model: string }
interface Business { enabled: boolean; allowed: string[]; managed: boolean; providers: Array<{ id: string; name: string; location: string; on: boolean }> }

/** Settings → Microsoft 365 Copilot: a work account's Copilot as a chat model. */
export function CopilotSection() {
  const [c, setC] = useState<CopilotStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const load = () => void api<CopilotStatus>("/api/copilot").then((s) => {
    setC(s);
    if (s.connected) setWaiting(false);
  }, () => setC(null));
  useEffect(load, []);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [waiting]);
  if (!c) return null;
  const run = async (f: () => Promise<unknown>) => {
    setError("");
    try {
      await f();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card stack">
      <h2>Microsoft 365 Copilot</h2>
      <p className="muted small">{L(
        "Copilot של הארגון כמודל צ'אט: התשובות מגיעות מ-Copilot בתוך הגבולות של Microsoft 365 של הארגון, על סמך המיילים, הקבצים, הפגישות והצ'אטים — כל אחד רק עם ההרשאות שלו. צריך חשבון עבודה או לימודים עם רישיון Microsoft 365 Copilot. (ה-API של מיקרוסופט עדיין בתצוגה מקדימה.)",
        "Your organisation's Copilot as a chat model: answers come from Copilot inside your Microsoft 365 boundary, grounded on mail, files, meetings and chats — each person with their own permissions. Needs a work or school account with a Microsoft 365 Copilot licence. (Microsoft's API is still in preview.)",
      )}</p>
      {c.connected ? (
        <>
          <p>{L("מחובר בתור", "Connected as")} {c.email}</p>
          <label className="biz-toggle"><input type="checkbox" checked={c.web} onChange={(e) => void run(() => api("/api/copilot", { method: "PUT", body: { web: e.target.checked } }))} /> {L("לאפשר ל-Copilot לחפש גם באינטרנט", "Let Copilot search the web too")}</label>
          <div className="row"><button type="button" onClick={() => void run(() => api("/api/copilot/disconnect", { method: "POST" }))}>{L("התנתק", "Disconnect")}</button></div>
        </>
      ) : c.configured ? (
        <div className="row">
          <button type="button" className="primary" onClick={() => void run(async () => {
            const { url } = await api<{ url: string }>("/api/copilot/connect", { method: "POST" });
            window.open(url, "_blank", "noopener");
            setWaiting(true);
          })}>{L("התחבר עם חשבון עבודה", "Connect with a work account")}</button>
          {waiting && <span className="muted">{L("השלם את ההתחברות בדפדפן…", "Finish signing in in the browser…")}</span>}
        </div>
      ) : (
        <p className="muted small">{L("קודם צריך מזהה אפליקציה של Microsoft (אותו אחד של OneDrive): הגדרות ← OneDrive.", "First a Microsoft application id is needed (the same one as OneDrive): Settings → OneDrive.")} <a href="https://github.com/Deadchu-R/KesherAI/blob/main/docs/COPILOT.md" target="_blank" rel="noreferrer">docs/COPILOT.md</a></p>
      )}
      {c.lastError && <p className="error">{c.lastError}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Settings → Business mode: only the connections you allow stay on (e.g. only Copilot). */
export function BusinessSection() {
  const [b, setB] = useState<Business | null>(null);
  const [error, setError] = useState("");
  const load = () => void api<Business>("/api/business").then(setB, () => setB(null));
  useEffect(load, []);
  if (!b) return null;
  const save = async (body: Partial<Business>) => {
    setError("");
    try {
      await api("/api/business", { method: "PUT", body });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = (id: string, on: boolean) => void save({ allowed: on ? [...b.allowed, id] : b.allowed.filter((x) => x !== id) });
  return (
    <section className="card stack">
      <div className="row">
        <h2 className="grow">{L("מצב עסקי", "Business mode")}</h2>
        <label className="biz-toggle"><input type="checkbox" checked={b.enabled} disabled={b.managed} onChange={(e) => void save({ enabled: e.target.checked })} /> {L("פעיל", "On")}</label>
      </div>
      <p className="muted small">{L(
        "כשהמצב פעיל, רק החיבורים שמסומנים כאן זמינים — כל שאר המודלים, מקומיים וענניים, כבויים ולא מופיעים ברשימות. למשל: רק Microsoft 365 Copilot. מנהל מערכת יכול לנעול את זה עם קובץ policy.json בתיקיית הנתונים.",
        "While it is on, only the connections ticked here can be used — every other model, local or cloud, is off and not listed. For example: only Microsoft 365 Copilot. An administrator can lock it with a policy.json file in the data folder.",
      )}</p>
      {b.managed && <p className="pill">🔒 {L("נקבע על ידי הארגון שלך (policy.json)", "Set by your organisation (policy.json)")}</p>}
      <ul className="biz-list">
        {b.providers.map((p) => (
          <li key={p.id}>
            <label className="biz-toggle">
              <input type="checkbox" checked={b.allowed.includes(p.id)} disabled={b.managed} onChange={(e) => toggle(p.id, e.target.checked)} />
              <span className="grow">{p.name}</span>
              <span className="muted small">{p.location === "local" ? L("במחשב", "on this computer") : L("ענן", "cloud")}</span>
              {b.enabled && <span className={`pill small ${p.on ? "good" : ""}`}>{p.on ? L("זמין", "on") : L("כבוי", "off")}</span>}
            </label>
          </li>
        ))}
      </ul>
      <p className="muted small">{L("כדי לכבות גם חלקים אחרים (תמונות, קול, דפדפן…) — עמוד החלקים.", "To also turn off other parts (pictures, voice, browser…) — the Parts page.")} <a href="#/parts">{L("חלקים", "Parts")}</a></p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
