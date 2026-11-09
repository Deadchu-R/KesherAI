import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Info { enabled: boolean; allowApprovals?: boolean; url: string; tools: string[]; snippets: { claudeCode: string; cursor: string; vscode: string; claudeDesktop?: string } }

const APPS: Array<{ key: keyof Info["snippets"]; name: string; where: [string, string] }> = [
  { key: "claudeCode", name: "Claude Code", where: ["הריצו בטרמינל:", "Run in a terminal:"] },
  { key: "claudeDesktop", name: "Claude Desktop", where: ["Settings ← Developer ← Edit Config, והוסיפו ל-claude_desktop_config.json (הכפתור פותח את הקובץ הנכון גם בגרסת ה-Microsoft Store, ששומרת אותו בתיקייה אחרת). אחר כך סגרו את Claude לגמרי (גם מאזור ההתראות) ופתחו מחדש:", "Settings → Developer → Edit Config, and add to claude_desktop_config.json (the button opens the right file in the Microsoft Store version too, which keeps it in another folder). Then quit Claude fully (from the tray too) and open it again:"] },
  { key: "cursor", name: "Cursor", where: ["הוסיפו ל-‎.cursor/mcp.json (או Settings ← MCP):", "Add to .cursor/mcp.json (or Settings → MCP):"] },
  { key: "vscode", name: "VS Code", where: ["הוסיפו ל-‎.vscode/mcp.json:", "Add to .vscode/mcp.json:"] },
];

/**
 * Claude from anywhere: a custom connector added in the Claude app (phone, web or desktop) with a link
 * through KesherAI's internet link. Its key opens only the MCP server and can be removed alone.
 */
function ConnectorLink() {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const make = () => {
    setError("");
    void api<{ url: string }>("/api/remote/devices/connector", { method: "POST", body: { name: "Claude" } }).then((r) => setLink(r.url), (e: Error) => setError(e.message));
  };
  return (
    <div className="stack">
      <h3>{L("חיבור Claude מכל מקום (גם מהטלפון)", "Connect Claude from anywhere (the phone too)")}</h3>
      <p className="muted small">{L("קישור למחבר מותאם באפליקציית Claude, דרך קישור \"גישה מכל מקום\". המפתח שבקישור פותח רק את שרת ה-MCP (לא את שאר KesherAI), מופיע ב\"מכשירים מחוברים\" ואפשר להסיר אותו לבד. הקישור משתנה אם קישור הגישה מכל מקום מתחיל מחדש (למשל אחרי הפעלה מחדש של המחשב).", "A link for a custom connector in the Claude app, through the access-from-anywhere link. Its key opens only the MCP server (not the rest of KesherAI), shows under paired devices and can be removed alone. The link changes if the access-from-anywhere link starts again (after the computer restarts, say).")}</p>
      {!link ? <button type="button" onClick={make}>{L("צור קישור ל-Claude", "Make a link for Claude")}</button> : (
        <>
          <div className="snippet">
            <pre dir="ltr" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{link}</pre>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? L("הועתק", "Copied") : L("העתק", "Copy")}</button>
          </div>
          <ol className="small">
            <li>{L("באפליקציית Claude: הגדרות ← Connectors (מחברים) ← Add custom connector.", "In the Claude app: Settings → Connectors → Add custom connector.")}</li>
            <li>{L("שם: KesherAI. כתובת: הקישור שהעתקת. אימות: No sign-in. הוסף.", "Name: KesherAI. URL: the link you copied. Authentication: No sign-in. Add.")}</li>
            <li>{L("בצ'אט עם Claude: + ← Connectors ← הדלק את KesherAI.", "In a chat with Claude: + → Connectors → turn KesherAI on.")}</li>
          </ol>
          <p className="muted small">{L("שמור את הקישור בסוד: מי שמחזיק בו יכול לתת ל-KesherAI משימות (כרטיסי אישור עדיין מגיעים אליך).", "Keep the link secret: whoever has it can give KesherAI tasks (approval cards still come to you).")}</p>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** KesherAI as an MCP server: how other AI apps on this computer use its models and knowledge. */
export function McpServerSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [app, setApp] = useState<keyof Info["snippets"]>("claudeCode");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<Info>("/api/mcp-server").then(setInfo, () => undefined);
  }, []);
  if (!info) return null;
  const shown = APPS.filter((a) => info.snippets[a.key]);
  const current = shown.find((a) => a.key === app) ?? shown[0]!;
  const snippet = info.snippets[current.key] ?? "";
  // From the phone app: what is on and what it offers; connecting apps and changing it happen on the computer.
  if (isRemote())
    return (
      <section className="card stack">
        <h2>{L("שימוש ב-KesherAI מאפליקציות אחרות (MCP)", "Use KesherAI from other apps (MCP)")}</h2>
        <p>{info.enabled ? L("✅ פעיל במחשב.", "✅ On, on the computer.") : L("כבוי במחשב.", "Off, on the computer.")} {info.allowApprovals ? L("אפליקציה מחוברת יכולה לאשר כרטיסים (לא פקודות מסוכנות ולא שליטה במסך).", "A connected app may answer approval cards (never dangerous commands or screen control).") : L("כרטיסי אישור נשארים שלך בלבד.", "Approval cards stay yours only.")}</p>
        <p className="muted small">{L("החיבור של Claude Desktop, Claude Code, Cursor או VS Code והשינויים כאן נעשים במחשב עצמו (הגדרות ← למפתחים), כי ההגדרה נכתבת לאפליקציה שבמחשב. אפשר גם לבקש מ-Claude לעשות את זה במחשב בשבילך.", "Connecting Claude Desktop, Claude Code, Cursor or VS Code, and changing this, happen on the computer itself (Settings → For developers), since the setting goes into the app on the computer. You can also ask Claude to do it there for you.")}</p>
        <p className="muted small">{L("כלים: ", "Tools: ")}<span dir="ltr">{info.tools.join(", ")}</span></p>
        {info.enabled && <ConnectorLink />}
      </section>
    );
  return (
    <section className="card stack">
      <h2>{L("שימוש ב-KesherAI מאפליקציות אחרות (MCP)", "Use KesherAI from other apps (MCP)")}</h2>
      <p className="muted">{L("Claude Code, Claude Desktop, Cursor ו-VS Code יכולים לתת ל-KesherAI משימות בצ'אט (והוא עובד עם הכלים שלו במחשב), ולהשתמש במודלים המקומיים, במאגרי הידע, ביצירת תמונות ובתמלול — דרך שרת ה-MCP של KesherAI. KesherAI צריך לרוץ.", "Claude Code, Claude Desktop, Cursor and VS Code can give KesherAI tasks in a chat (it works with its own tools on this computer), and use your local models, knowledge bases, image generation and transcription through KesherAI's MCP server. KesherAI needs to be running.")}</p>
      <label className="check">
        <input type="checkbox" checked={info.enabled} onChange={(e) => void api<{ enabled: boolean }>("/api/mcp-server", { method: "PUT", body: { enabled: e.target.checked } }).then((r) => setInfo({ ...info, enabled: r.enabled }))} />
        {L("שרת MCP פעיל", "MCP server on")} <code dir="ltr">{info.url}</code>
      </label>
      {info.enabled && (
        <>
          <div className="row seg" role="tablist">
            {shown.map((a) => (
              <button key={a.key} type="button" role="tab" aria-selected={a.key === current.key} className={a.key === current.key ? "on" : ""} onClick={() => { setApp(a.key); setCopied(false); }}>{a.name}</button>
            ))}
          </div>
          <p className="muted small">{L(...current.where)}</p>
          <div className="snippet">
            <pre dir="ltr">{snippet}</pre>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(snippet).then(() => setCopied(true))}>{copied ? L("הועתק", "Copied") : L("העתק", "Copy")}</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!info.allowApprovals} onChange={(e) => void api<{ allowApprovals: boolean }>("/api/mcp-server", { method: "PUT", body: { allowApprovals: e.target.checked } }).then((r) => setInfo({ ...info, allowApprovals: r.allowApprovals }))} />
            {L("לאפשר לאפליקציה המחוברת לאשר כרטיסי אישור של KesherAI (פקודות מסוכנות תמיד נשארות שלכם)", "Let the connected app answer KesherAI's approval cards (dangerous commands always stay yours)")}
          </label>
          <p className="muted small">{L("כלים: ", "Tools: ")}<span dir="ltr">{info.tools.join(", ")}</span>. {L("ממכשירים אחרים צריך את טוקן הגישה מרחוק.", "From other devices it needs the remote access token.")}</p>
          <ConnectorLink />
        </>
      )}
    </section>
  );
}
