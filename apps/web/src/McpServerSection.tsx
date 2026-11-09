import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Info { enabled: boolean; allowApprovals?: boolean; url: string; tools: string[]; snippets: { claudeCode: string; cursor: string; vscode: string; claudeDesktop?: string } }

const APPS: Array<{ key: keyof Info["snippets"]; name: string; where: [string, string] }> = [
  { key: "claudeCode", name: "Claude Code", where: ["הריצו בטרמינל:", "Run in a terminal:"] },
  { key: "claudeDesktop", name: "Claude Desktop", where: ["Settings ← Developer ← Edit Config, והוסיפו ל-claude_desktop_config.json:", "Settings → Developer → Edit Config, and add to claude_desktop_config.json:"] },
  { key: "cursor", name: "Cursor", where: ["הוסיפו ל-‎.cursor/mcp.json (או Settings ← MCP):", "Add to .cursor/mcp.json (or Settings → MCP):"] },
  { key: "vscode", name: "VS Code", where: ["הוסיפו ל-‎.vscode/mcp.json:", "Add to .vscode/mcp.json:"] },
];

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
        </>
      )}
    </section>
  );
}
