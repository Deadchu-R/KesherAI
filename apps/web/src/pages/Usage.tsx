import { useEffect, useState } from "react";
import { api } from "../api";
import { tokens } from "../CoachPanel";
import { useModels } from "../useModels";
import { ModelMenu } from "../ModelMenu";
import { t } from "../i18n";

interface UsageReport {
  totals: { requests: number; calls: number; inputTokens: number; outputTokens: number; wastedTokens: number; failedSteps: number; estimated: boolean };
  byModel: Record<string, number>;
  byDay: Record<string, number>;
  costly: Array<{ conversationId: string; title: string; prompt: string; tokens: number; wasted: number }>;
}

interface Profile {
  notes: string[];
  analysed: number;
  learn: boolean;
  modelId: string | null;
}

/** Tokens across all conversations, what was wasted, the costliest requests, and what the coach learned. */
export function UsagePage() {
  const [u, setU] = useState<UsageReport | null>(null);
  const [p, setP] = useState<Profile | null>(null);
  const { models } = useModels("chat");

  const load = () => {
    api<UsageReport>("/api/usage").then(setU, () => undefined);
    api<Profile>("/api/coach/profile").then(setP, () => undefined);
  };
  useEffect(load, []);

  const settings = async (body: { learn?: boolean; modelId?: string | null }) => {
    await api("/api/coach/settings", { method: "PUT", body });
    load();
  };

  const all = u ? u.totals.inputTokens + u.totals.outputTokens : 0;
  const models_ = u ? Object.entries(u.byModel).sort((a, b) => b[1] - a[1]) : [];
  const maxModel = Math.max(1, ...models_.map(([, n]) => n));
  const days = u ? Object.entries(u.byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14) : [];
  const maxDay = Math.max(1, ...days.map(([, n]) => n));

  return (
    <div className="page usage">
      <h1>{t("usageTitle")}</h1>
      <p className="muted">{t("usageIntro")}</p>
      {u && (
        <div className="usage-stats">
          <div><span className="big">{tokens(all)}</span><span className="muted small">{t("usageTokens")}</span></div>
          <div><span className="big waste">{tokens(u.totals.wastedTokens)}</span><span className="muted small">{t("usageWasted", { pct: all ? Math.round((u.totals.wastedTokens / all) * 100) : 0 })}</span></div>
          <div><span className="big">{u.totals.requests}</span><span className="muted small">{t("usageRequests")}</span></div>
          <div><span className="big">{u.totals.failedSteps}</span><span className="muted small">{t("usageFailed")}</span></div>
        </div>
      )}
      {u?.totals.estimated && <p className="muted small">{t("coachEstimated")}</p>}

      {models_.length > 0 && (
        <section className="card">
          <h2>{t("usageByModel")}</h2>
          <ul className="hbars">
            {models_.map(([m, n]) => (
              <li key={m}>
                <span dir="ltr" className="hbar-label">{m.split("/").slice(-2).join("/")}</span>
                <span className="hbar"><span style={{ width: `${(n / maxModel) * 100}%` }} /></span>
                <span className="muted small">{tokens(n)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {days.length > 1 && (
        <section className="card">
          <h2>{t("usageByDay")}</h2>
          <div className="vbars" role="img" aria-label={t("usageByDay")}>
            {days.map(([d, n]) => (
              <div key={d} title={`${d}: ${tokens(n)}`}>
                <span style={{ height: `${Math.max(3, (n / maxDay) * 100)}%` }} />
                <small dir="ltr">{d.slice(5)}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {u && u.costly.length > 0 && (
        <section className="card">
          <h2>{t("usageCostly")}</h2>
          <ol className="costly">
            {u.costly.map((c, i) => (
              <li key={i}>
                <a href={`#/c/${c.conversationId}`} dir="auto">{c.prompt || c.title}</a>
                <span className="muted small">{tokens(c.tokens)}{c.wasted ? ` · ${t("coachWasted", { n: tokens(c.wasted), pct: Math.round((c.wasted / c.tokens) * 100) })}` : ""}</span>
              </li>
            ))}
          </ol>
          <p className="muted small">{t("usageCoachHint")}</p>
        </section>
      )}

      {p && (
        <section className="card">
          <h2>{t("usageLearned")}</h2>
          <label className="row">
            <input type="checkbox" checked={p.learn} onChange={(e) => void settings({ learn: e.target.checked })} />
            <span>{t("usageLearn")}</span>
          </label>
          {p.notes.length === 0 ? (
            <p className="muted">{t("usageNoNotes")}</p>
          ) : (
            <ul className="notes">
              {p.notes.map((n, i) => (
                <li key={i}>
                  <span dir="auto">{n}</span>
                  <button type="button" className="link-btn" onClick={() => void api(`/api/coach/profile?index=${i}`, { method: "DELETE" }).then(load)}>{t("remove")}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <span className="muted small">{t("usageCoachModel")}</span>
            {p.modelId ? (
              <>
                <ModelMenu models={models} value={p.modelId} onChange={(id) => void settings({ modelId: id })} />
                <button type="button" className="link-btn" onClick={() => void settings({ modelId: null })}>{t("usageSameModel")}</button>
              </>
            ) : (
              <button type="button" onClick={() => models[0] && void settings({ modelId: models[0].id })}>{t("usageSameModel")} ▾</button>
            )}
          </div>
          {p.notes.length > 0 && (
            <button type="button" onClick={() => void api("/api/coach/profile", { method: "DELETE" }).then(load)}>{t("usageForget")}</button>
          )}
        </section>
      )}
    </div>
  );
}
