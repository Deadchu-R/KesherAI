import { useEffect, useState } from "react";
import { api } from "./api";
import { t, type StringKey } from "./i18n";

/** Cost and waste of one request, from `/api/conversations/:id/usage`. */
export interface RequestStats {
  prompt: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  wastedTokens: number;
  failedSteps: number;
  nudges: number;
  reworks: number;
  tools: Record<string, number>;
  estimated: boolean;
  byModel: Record<string, number>;
}

interface Suggestion {
  kind: "prompt" | "tool" | "mcp" | "skill" | "model" | "setting" | "plugin";
  title: string;
  why: string;
  example?: string;
}

/** Formats a token count: 950, 12.3k, 1.2M. */
export function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/**
 * The conversation's coach panel: what each request cost and wasted, and
 * suggestions (better prompt, a tool, MCP server, skill, model or setting).
 *
 * @param props.convId - Conversation.
 * @param props.refresh - Changes when the conversation changes, to reload the numbers.
 * @param props.onUsePrompt - Puts a suggested prompt into the composer.
 */
export function CoachPanel({ convId, refresh, onUsePrompt }: { convId: string; refresh: number; onUsePrompt: (text: string) => void }) {
  const [stats, setStats] = useState<RequestStats[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ suggestions: Suggestion[]; learned: string[]; modelId: string } | null>(null);

  useEffect(() => {
    api<RequestStats[]>(`/api/conversations/${convId}/usage`).then(setStats, () => undefined);
  }, [convId, refresh]);

  const total = stats.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
  const wasted = stats.reduce((a, r) => a + r.wastedTokens, 0);
  const estimated = stats.some((r) => r.estimated);

  const ask = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await api(`/api/conversations/${convId}/coach`, { method: "POST", body: {} }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="coach-panel" aria-label={t("coach")}>
      <div className="coach-head">
        <div>
          <strong>{t("coach")}</strong>
          <p className="muted small">
            {t("coachTotals", { total: tokens(total), wasted: tokens(wasted), n: stats.length })}
            {estimated ? ` · ${t("coachEstimated")}` : ""}
          </p>
        </div>
        <button type="button" className="primary" disabled={busy || stats.length === 0} onClick={() => void ask()}>
          {busy ? t("coachThinking") : t("coachAsk")}
        </button>
      </div>
      {stats.length > 0 && (
        <ol className="coach-requests">
          {stats.slice(-6).map((r, i) => {
            const all = r.inputTokens + r.outputTokens;
            const pct = all ? Math.round((r.wastedTokens / all) * 100) : 0;
            return (
              <li key={i}>
                <span className="coach-prompt" dir="auto">{r.prompt}</span>
                <span className="coach-meter" aria-hidden>
                  <span className="used" style={{ width: `${100 - pct}%` }} />
                  <span className="waste" style={{ width: `${pct}%` }} />
                </span>
                <span className="muted small">
                  {t("coachReq", { tokens: tokens(all), calls: r.calls })}
                  {r.wastedTokens ? ` · ${t("coachWasted", { n: tokens(r.wastedTokens), pct })}` : ""}
                  {r.failedSteps ? ` · ${t("coachFailed", { n: r.failedSteps })}` : ""}
                  {r.reworks ? ` · ${t("coachReworks", { n: r.reworks })}` : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="coach-tips">
          {result.suggestions.length === 0 && <p className="muted">{t("coachNothing")}</p>}
          {result.suggestions.map((s, i) => (
            <div key={i} className={`coach-tip ${s.kind}`}>
              <span className="pill">{t(`coachKind_${s.kind}` as StringKey)}</span>
              <strong dir="auto">{s.title}</strong>
              <p dir="auto">{s.why}</p>
              {s.example && (
                <>
                  <pre className="code" dir="auto">{s.example}</pre>
                  <button type="button" onClick={() => onUsePrompt(s.example!)}>{t("coachUse")}</button>
                </>
              )}
            </div>
          ))}
          {result.learned.length > 0 && (
            <p className="muted small" dir="auto">
              {t("coachLearned")} {result.learned.join(" · ")} — <a href="#/usage">{t("coachManage")}</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
