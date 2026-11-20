import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import "../control-card.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface ControlSettings {
  mode: "manual" | "auto" | "skip";
  helperMode: "manual" | "auto";
  skipAllowed: boolean;
  js: "ask" | "local" | "off";
  sensitive: string[];
  blocked: string[];
}

interface Decision { at: string; helper?: string; kind: string; tool: string; site?: string; app?: string; target?: string; decision: string; by: string }

/** One choice of a radio group: its value, title and one line on what it means. */
type Choice<T extends string> = [T, string, string];

/** A vertical radio group (fits a 390 px phone with long Hebrew lines, unlike a segmented row). */
function Radios<T extends string>({ name, value, choices, onPick, disabled }: { name: string; value: T; choices: Array<Choice<T>>; onPick: (v: T) => void; disabled?: (v: T) => boolean }) {
  return (
    <div className="cs-radios" role="radiogroup">
      {choices.map(([v, title, line]) => (
        <label key={v} className={`cs-radio${value === v ? " on" : ""}${disabled?.(v) ? " off" : ""}`}>
          <input type="radio" name={name} checked={value === v} disabled={disabled?.(v)} onChange={() => onPick(v)} />
          <span><b dir="auto">{title}</b><br /><span className="muted small" dir="auto">{line}</span></span>
        </label>
      ))}
    </div>
  );
}

/** Sites from a text box: one per line (or comma), without https:// and paths. */
const sitesOf = (text: string) => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

/**
 * Settings → Browser and computer safety (safety v2): the chat's mode (Manual / Auto with the local reviewer / Skip
 * behind an explicit yes with a warning), the helpers' mode (never Skip), the JavaScript policy, the user's sensitive
 * and blocked sites, and the newest decisions of the action log. Works on the phone too.
 */
export function ControlSafetySection() {
  const [s, setS] = useState<ControlSettings | null>(null);
  const [warn, setWarn] = useState(false);
  const [sens, setSens] = useState("");
  const [blk, setBlk] = useState("");
  const [log, setLog] = useState<Decision[]>([]);
  useEffect(() => {
    void api<ControlSettings>("/api/control/settings").then((r) => {
      setS(r);
      setSens(r.sensitive.join("\n"));
      setBlk(r.blocked.join("\n"));
    }, () => undefined);
    void api<{ decisions: Decision[] }>("/api/control/decisions?n=8").then((r) => setLog(r.decisions.slice().reverse()), () => undefined);
  }, []);
  if (!s) return null;
  const save = (patch: Partial<ControlSettings>) => void api<ControlSettings>("/api/control/settings", { method: "PUT", body: patch }).then(setS, () => undefined);
  const decided = (d: Decision) =>
    d.decision === "deny" ? L("נדחה", "denied") : d.decision === "expired" ? L("לא נענה: נדחה", "no answer: denied") : d.by === "reviewer" ? L("אושר ע\"י הבודק", "allowed by the reviewer") : d.by === "user" ? L("אישרת", "you allowed") : L("אושר", "allowed");
  return (
    <section className="card stack cs-section">
      <h2>{L("בטיחות בדפדפן ובמחשב", "Browser and computer safety")}</h2>
      <p className="muted small" dir="auto">{L(
        "איך מאשרים פעולות של המודל בדפדפן ובמחשב. בכל מצב: אתרים רגישים (בנקים, תשלומים, דואר, הגדרות חשבון, אתרים ממשלתיים) שואלים על כל פעולה, סיסמאות לא מוקלדות אף פעם, וכרטיס שלא נענה 5 דקות נחשב כדחייה.",
        "How the model's actions in the browser and on the computer are approved. In every mode: sensitive sites (banks, payments, email, account settings, government) ask before every action, passwords are never typed, and a card unanswered for 5 minutes counts as denied.",
      )}</p>

      <h3>{L("בצ'אט", "In the chat")}</h3>
      <Radios
        name="cs-mode"
        value={s.mode}
        choices={[
          ["manual", L("ידני", "Manual"), L("שואל לפני כל פעולה, חוץ מאתרים שבחרת בהם \"תמיד\".", "Asks before each action, except on sites where you chose \"Always\".")],
          ["auto", L("אוטומטי עם בודק", "Auto with a reviewer"), L("מודל מקומי בודק כל פעולה (רואה רק מה ביקשת, הפעולה והאתר, אף פעם לא את הדף). מה שהוא לא בטוח בו — נשאל אותך.", "A local model checks each action (it sees only what you asked, the action and the site, never the page). Anything it is unsure of is asked.")],
          ["skip", L("בלי לשאול", "Skip"), s.skipAllowed ? L("רץ בלי לשאול, חוץ מאתרים רגישים. אף פעם לא לסוכני עזר ולא לשליטה במחשב.", "Runs without asking, except sensitive sites. Never for helpers or computer control.") : L("נעול: הדלק למטה \"אפשר מצב בלי לשאול\".", "Locked: turn on \"Allow Skip\" below.")],
        ]}
        disabled={(v) => v === "skip" && !s.skipAllowed}
        onPick={(mode) => save({ mode })}
      />
      <label className="row">
        <input type="checkbox" checked={s.skipAllowed} onChange={(e) => (e.target.checked ? setWarn(true) : save({ skipAllowed: false }))} />
        <span dir="auto">{L("אפשר מצב \"בלי לשאול\"", "Allow Skip mode")}</span>
      </label>
      {warn && !s.skipAllowed && (
        <div className="cs-warning" role="alert">
          <p dir="auto">⚠ {L(
            "במצב הזה המודל לוחץ, מקליד ופותח דפים בלי לשאול. דף זדוני יכול לנסות לשכנע אותו לעשות דברים שלא ביקשת. השתמש בו רק באתרים שאתה סומך עליהם, וכשאתה צופה.",
            "In this mode the model clicks, types and opens pages without asking. A malicious page can try to talk it into things you did not ask for. Use it only on sites you trust, while you watch.",
          )}</p>
          <div className="row">
            <button type="button" className="danger-btn" onClick={() => { setWarn(false); save({ skipAllowed: true }); }}>{L("הבנתי, אפשר", "I understand, allow it")}</button>
            <button type="button" onClick={() => setWarn(false)}>{L("ביטול", "Cancel")}</button>
          </div>
        </div>
      )}

      <h3>{L("סוכני עזר", "Helper agents")}</h3>
      <Radios
        name="cs-helper"
        value={s.helperMode}
        choices={[
          ["manual", L("ידני (מומלץ)", "Manual (recommended)"), L("סוכן עזר שואל לפני כל פעולה, והכרטיס נושא את השם שלו.", "A helper asks before every action; the card names it.")],
          ["auto", L("אוטומטי עם בודק", "Auto with a reviewer"), L("הבודק המקומי מאשר צעדים ברורים; השאר נשאל אותך. אין \"בלי לשאול\" לסוכני עזר.", "The local reviewer allows clear steps; the rest is asked. Helpers never get Skip.")],
        ]}
        onPick={(helperMode) => save({ helperMode })}
      />

      <h3>JavaScript</h3>
      <Radios
        name="cs-js"
        value={s.js}
        choices={[
          ["ask", L("לשאול כל פעם", "Ask every time"), L("כל הרצת קוד בדף נשאלת.", "Every script on a page is asked.")],
          ["local", L("שרתי פיתוח מקומיים לפי המצב", "Local dev servers follow the mode"), L("ב-localhost לפי המצב שלמעלה; בשאר האתרים שואל.", "On localhost it follows the mode above; elsewhere it asks.")],
          ["off", L("כבוי", "Off"), L("המודל לא מריץ JavaScript בדפים.", "The model never runs JavaScript on pages.")],
        ]}
        onPick={(js) => save({ js })}
      />

      <label className="stack">
        <span dir="auto">{L("אתרים רגישים שלך (אחד בשורה): שואלים על כל פעולה, בלי \"תמיד\"", "Your sensitive sites (one per line): every action asked, no \"Always\"")}</span>
        <textarea dir="ltr" rows={3} value={sens} placeholder="mybank.example" onChange={(e) => setSens(e.target.value)} onBlur={() => save({ sensitive: sitesOf(sens) })} />
      </label>
      <label className="stack">
        <span dir="auto">{L("אתרים חסומים (אחד בשורה): המודל לא קורא ולא פועל בהם", "Blocked sites (one per line): the model never reads or acts there")}</span>
        <textarea dir="ltr" rows={3} value={blk} placeholder="example.com" onChange={(e) => setBlk(e.target.value)} onBlur={() => save({ blocked: sitesOf(blk) })} />
      </label>

      <h3>{L("החלטות אחרונות", "Recent decisions")}</h3>
      {log.length ? (
        <ul className="plain-list cs-log">
          {log.map((d, i) => (
            <li key={i} dir="auto">
              <span className="muted small">{new Date(d.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</span>{" "}
              <b>{d.helper ?? "KesherAI"}</b> · {d.tool.replace(/^(browser|computer)_/, "")} {d.target ? <bdi>{d.target}</bdi> : null} · <bdi dir="ltr">{d.site ?? d.app ?? ""}</bdi> · <span className={d.decision === "deny" || d.decision === "expired" ? "cs-no" : ""}>{decided(d)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{L("עוד אין.", "None yet.")}</p>
      )}
    </section>
  );
}
