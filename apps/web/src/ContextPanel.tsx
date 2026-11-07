import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface View {
  windowTokens: number;
  system: { tokens: number; text: string };
  tools: Array<{ name: string; tokens: number }>;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; tokens: number; text: string; toolCalls?: string[]; toolName?: string; images?: number; shortened?: boolean; summarized?: boolean }>;
  summary?: string;
  totalTokens: number;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const ROLE: Record<string, [string, string]> = { user: ["את/ה", "You"], assistant: ["המודל", "Model"], tool: ["כלי", "Tool"], system: ["מערכת", "System"] };

/**
 * The context explorer: exactly what the model reads on its next turn —
 * the system prompt, its tools and the messages — with the size of each
 * and how full the model's context is.
 */
export function ContextPanel({ convId, refresh }: { convId: string; refresh: number }) {
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<View>(`/api/conversations/${convId}/context`).then(setV, (e: Error) => setError(e.message));
  }, [convId, refresh]);
  if (error) return <div className="coach-panel"><p className="error">{error}</p></div>;
  if (!v) return <div className="coach-panel"><p className="muted">{L("טוען…", "Loading…")}</p></div>;
  const toolTokens = v.tools.reduce((n, t) => n + t.tokens, 0);
  const msgTokens = v.messages.filter((m) => !m.summarized).reduce((n, m) => n + m.tokens, 0);
  const pct = (n: number) => `${Math.min(100, (n / v.windowTokens) * 100)}%`;
  const full = v.totalTokens / v.windowTokens;
  return (
    <div className="coach-panel ctx-panel">
      <div className="row">
        <strong>{L("מה המודל רואה", "What the model sees")}</strong>
        <span className="muted small">{L(`בערך ${k(v.totalTokens)} מתוך ${k(v.windowTokens)} טוקנים`, `about ${k(v.totalTokens)} of ${k(v.windowTokens)} tokens`)}</span>
      </div>
      <div className="ctx-bar" role="img" aria-label={L(`ההקשר מלא ב-${Math.round(full * 100)}%`, `Context ${Math.round(full * 100)}% full`)}>
        <span className="ctx-sys" style={{ width: pct(v.system.tokens) }} />
        <span className="ctx-tools" style={{ width: pct(toolTokens) }} />
        <span className="ctx-msgs" style={{ width: pct(msgTokens) }} />
      </div>
      <div className="ctx-legend muted small">
        <span><i className="ctx-sys" /> {L("הוראות", "Instructions")} {k(v.system.tokens)}</span>
        <span><i className="ctx-tools" /> {L("כלים", "Tools")} {k(toolTokens)}</span>
        <span><i className="ctx-msgs" /> {L("הודעות", "Messages")} {k(msgTokens)}</span>
      </div>
      {full > 0.85 && <p className="muted small">{L("ההקשר כמעט מלא: ההודעות הישנות יסוכמו. אפשר לפצל לענף חדש או לבחור מודל עם הקשר גדול יותר.", "The context is almost full: older messages will be summarized. You can branch, or pick a model with a larger context.")}</p>}
      <details>
        <summary>{L("הוראות המערכת", "System prompt")} · {k(v.system.tokens)}</summary>
        <pre className="ctx-text" dir="auto">{v.system.text}</pre>
      </details>
      <details>
        <summary>{L(`כלים (${v.tools.length})`, `Tools (${v.tools.length})`)} · {k(toolTokens)}</summary>
        <ul className="ctx-tools-list" dir="ltr">
          {[...v.tools].sort((a, b) => b.tokens - a.tokens).map((t) => <li key={t.name}><span>{t.name}</span><span className="muted">{k(t.tokens)}</span></li>)}
        </ul>
      </details>
      {v.summary && (
        <details open>
          <summary>{L("סיכום של תחילת השיחה (במקום ההודעות האפורות)", "Summary of the start (stands in for the greyed messages)")}</summary>
          <pre className="ctx-text" dir="auto">{v.summary}</pre>
        </details>
      )}
      <ol className="ctx-msgs-list">
        {v.messages.map((m, i) => (
          <li key={i} className={m.summarized ? "summarized" : ""}>
            <details>
              <summary>
                <span className={`ctx-role ${m.role}`}>{L(...(ROLE[m.role] ?? [m.role, m.role]))}{m.toolName ? ` · ${m.toolName}` : ""}</span>
                <span className="ctx-preview" dir="auto">{m.toolCalls?.length ? `→ ${m.toolCalls.join(", ")} ` : ""}{m.text.slice(0, 120)}</span>
                <span className="muted small">{k(m.tokens)}{m.images ? ` · 🖼 ${m.images}` : ""}{m.shortened ? ` · ${L("מקוצר", "shortened")}` : ""}{m.summarized ? ` · ${L("מסוכם", "summarized")}` : ""}</span>
              </summary>
              <pre className="ctx-text" dir="auto">{m.text || L("(רק קריאה לכלים)", "(tool calls only)")}</pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
