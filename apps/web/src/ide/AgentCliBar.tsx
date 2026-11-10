import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Buttons above the code page's terminal for other coding agents' own CLIs:
 * Gemini CLI (start it in this project, or install it with npm; it signs in
 * with the user's Google account itself, so a Google AI Pro subscription works
 * and KesherAI never holds that sign-in), and Claude Code running on
 * KesherAI's own model when it is installed.
 *
 * @param props.onRun - Opens a fresh terminal that starts the named command.
 */
export function AgentCliBar({ onRun }: { onRun: (run: string) => void }) {
  const [st, setSt] = useState<{ gemini: { installed: boolean }; claude?: { installed: boolean }; npm: boolean } | null>(null);
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
      {st.claude?.installed && (
        <button type="button" onClick={() => onRun("claude-local")} title={L("מפעיל את Claude Code על המודל של קשר (למשל Qwen במחשב): בלי חשבון Anthropic ובלי תשלום. כמו ollama launch claude.", "Starts Claude Code on KesherAI's model (e.g. Qwen on this computer): no Anthropic account, nothing to pay. Like ollama launch claude.")}>
          {L("Claude Code על המודל המקומי", "Claude Code on the local model")}
        </button>
      )}
      <span className="muted small grow">{L("ההתחברות שלו נשארת אצלו, לא בקשר.", "Its sign-in stays with it, not in KesherAI.")}</span>
      {st.gemini.installed || <button type="button" onClick={load}>{L("בדיקה שוב", "Check again")}</button>}
    </div>
  );
}
