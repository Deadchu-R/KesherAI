import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Buttons above the code page's terminal for other coding agents' own CLIs:
 * Antigravity CLI (`agy`, Google's agent, which a Google AI Pro subscription
 * signs in to since Gemini CLI stopped taking it in June 2026): start it in
 * this project, update it, or install it with Google's own installer. It signs
 * in with the user's Google account itself, so KesherAI never holds that
 * sign-in. And Claude Code running on KesherAI's own model when it is installed.
 *
 * @param props.onRun - Opens a fresh terminal that starts the named command.
 */
export function AgentCliBar({ onRun }: { onRun: (run: string) => void }) {
  const [st, setSt] = useState<{ agy: { installed: boolean; canInstall: boolean }; claude?: { installed: boolean } } | null>(null);
  const load = () => void api<NonNullable<typeof st>>("/api/agent-clis").then(setSt, () => setSt(null));
  useEffect(load, []);
  if (!st?.agy) return null;
  return (
    <div className="row wrap agent-cli-bar">
      {st.agy.installed ? (
        <>
          <button type="button" className="primary" onClick={() => onRun("agy")} title={L("פותח טרמינל חדש בתיקיית הפרויקט ומפעיל בו את Antigravity CLI של Google. בפעם הראשונה הוא יבקש להתחבר עם חשבון Google (מנוי Pro עובד).", "Opens a new terminal in the project folder and starts Google's Antigravity CLI. The first time, it asks you to sign in with Google (a Pro plan works).")}>
            ✦ Antigravity CLI
          </button>
          <button type="button" onClick={() => onRun("agy-update")}>{L("עדכון", "Update")}</button>
        </>
      ) : st.agy.canInstall ? (
        <button type="button" onClick={() => { onRun("agy-install"); setTimeout(load, 60_000); }} title="irm https://antigravity.google/cli/install.ps1 | iex">
          {L("התקנת Antigravity CLI (של Google)", "Install Antigravity CLI (Google's)")}
        </button>
      ) : (
        <span className="muted small">{L("את Antigravity CLI מתקינים מ־antigravity.google.", "Install Antigravity CLI from antigravity.google.")}</span>
      )}
      {st.claude?.installed && (
        <button type="button" onClick={() => onRun("claude-local")} title={L("מפעיל את Claude Code על המודל של קשר (למשל Qwen במחשב): בלי חשבון Anthropic ובלי תשלום. כמו ollama launch claude.", "Starts Claude Code on KesherAI's model (e.g. Qwen on this computer): no Anthropic account, nothing to pay. Like ollama launch claude.")}>
          {L("Claude Code על המודל המקומי", "Claude Code on the local model")}
        </button>
      )}
      <span className="muted small grow">{L("ההתחברות שלו נשארת אצלו, לא בקשר.", "Its sign-in stays with it, not in KesherAI.")}</span>
      {st.agy.installed || <button type="button" onClick={load}>{L("בדיקה שוב", "Check again")}</button>}
    </div>
  );
}
