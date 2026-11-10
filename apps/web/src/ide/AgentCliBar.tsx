import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Buttons above the code page's terminal for Gemini CLI, Google's own coding
 * agent: start it in this project, or install it (with npm) when it is
 * missing. It signs in with the user's Google account inside the terminal, so
 * a Google AI Pro subscription works and KesherAI never holds that sign-in.
 *
 * @param props.onRun - Opens a fresh terminal that starts the named command.
 */
export function AgentCliBar({ onRun }: { onRun: (run: string) => void }) {
  const [st, setSt] = useState<{ gemini: { installed: boolean }; npm: boolean } | null>(null);
  const load = () => void api<NonNullable<typeof st>>("/api/agent-clis").then(setSt, () => setSt(null));
  useEffect(load, []);
  if (!st) return null;
  return (
    <div className="row wrap agent-cli-bar">
      {st.gemini.installed ? (
        <>
          <button type="button" className="primary" onClick={() => onRun("gemini")} title={L("פותח טרמינל חדש בתיקיית הפרויקט ומפעיל בו את Gemini CLI. בפעם הראשונה הוא יבקש להתחבר עם Google.", "Opens a new terminal in the project folder and starts Gemini CLI. The first time, it asks you to sign in with Google.")}>
            ✦ Gemini CLI
          </button>
          <button type="button" onClick={() => onRun("gemini-update")}>{L("עדכון", "Update")}</button>
        </>
      ) : st.npm ? (
        <button type="button" onClick={() => { onRun("gemini-install"); setTimeout(load, 60_000); }} title="npm install -g @google/gemini-cli">
          {L("התקנת Gemini CLI", "Install Gemini CLI")}
        </button>
      ) : (
        <span className="muted small">{L("כדי להתקין את Gemini CLI צריך Node.js (מ־nodejs.org).", "Gemini CLI needs Node.js (from nodejs.org).")}</span>
      )}
      <span className="muted small grow">{L("ההתחברות שלו נשארת אצלו, לא בקשר.", "Its sign-in stays with it, not in KesherAI.")}</span>
      {st.gemini.installed || <button type="button" onClick={load}>{L("בדיקה שוב", "Check again")}</button>}
    </div>
  );
}
