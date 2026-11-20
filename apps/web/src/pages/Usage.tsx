import { useEffect, useState } from "react";
import { api } from "../api";
import { tokens } from "../CoachPanel";
import { useModels } from "../useModels";
import { ModelMenu, shortModelName } from "../ModelMenu";
import { getLocale, he$, t } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface UsageReport {
  totals: { requests: number; calls: number; inputTokens: number; outputTokens: number; wastedTokens: number; failedSteps: number; estimated: boolean };
  byModel: Record<string, number>;
  byDay: Record<string, number>;
  costly: Array<{ conversationId: string; title: string; prompt: string; tokens: number; wasted: number }>;
  /** Sub-agents, apart from the chats' own models (older servers leave it out). */
  helpers?: { runs: number; calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; estimated: boolean; byRole: Record<string, { runs: number; tokens: number }>; byModel: Record<string, number> };
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

  return (
    <div className="page usage">
      <h1>{t("usageTitle")}</h1>
      <p className="muted">{t("usageIntro")}</p>
      {u && (
        <div className="usage-stats">
          <div><span className="big">{tokens(all)}</span><span className="muted small">{t("usageTokens")}</span></div>
          <div><span className="big waste">{tokens(u.totals.wastedTokens)}</span><span className="muted small">{t("usageWasted", { pct: all ? Math.round((u.totals.wastedTokens / all) * 100) : 0 })}</span></div>
          <div><span className="big">{u.totals.requests}</span><span className="muted small">{t("usageRequests")}</span></div>
          {!!u.helpers?.runs && <div><span className="big">{tokens(u.helpers.inputTokens + u.helpers.outputTokens)}</span><span className="muted small">{L(`סוכני משנה (${u.helpers.runs} הרצות)`, `sub-agents (${u.helpers.runs} runs)`)}</span></div>}
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
                <span dir="ltr" className="hbar-label" title={m}>{shortModelName(m)}</span>
                <span className="hbar"><span style={{ width: `${(n / maxModel) * 100}%` }} /></span>
                <span className="muted small">{tokens(n)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!u?.helpers?.runs && <HelperUsageCard h={u.helpers} />}

      {Object.keys(u?.byDay ?? {}).length > 0 && <UsageHeatmap byDay={u!.byDay} />}

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

/**
 * The last 12 weeks as a grid of days (Open WebUI's and GitHub's usage picture, audit F21): darker = more tokens.
 * Weeks are columns, days run down; the streak counts the days in a row up to today (or yesterday).
 *
 * @param p.byDay - Tokens per day (YYYY-MM-DD).
 */
export function UsageHeatmap({ byDay }: { byDay: Record<string, number> }) {
  const he = getLocale() === "he";
  const day = (d: Date) => d.toLocaleDateString("sv-SE");
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  // Start on the Sunday 11 weeks before this week's, so the last column is this week.
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - 77);
  const cells: Array<{ d: string; n: number; future: boolean }> = [];
  for (let i = 0; i < 84; i++) {
    const at = new Date(start);
    at.setDate(start.getDate() + i);
    cells.push({ d: day(at), n: byDay[day(at)] ?? 0, future: at > today });
  }
  const max = Math.max(1, ...cells.map((c) => c.n));
  const level = (n: number) => (n <= 0 ? 0 : Math.min(4, 1 + Math.floor((n / max) * 3.999)));
  let streak = 0;
  const back = new Date(today);
  if (!byDay[day(back)]) back.setDate(back.getDate() - 1);
  while (byDay[day(back)]) {
    streak++;
    back.setDate(back.getDate() - 1);
  }
  const active = cells.filter((c) => c.n > 0).length;
  return (
    <section className="card stack">
      <h2>{he ? "12 השבועות האחרונים" : "The last 12 weeks"}</h2>
      <div className="heat-scroll">
        <div className="heatmap" role="img" aria-label={he ? `שימוש ב־${active} ימים מתוך 84` : `Used on ${active} of 84 days`}>
          {cells.map((c) => (
            <span key={c.d} className={`heat l${c.future ? "x" : level(c.n)}`} title={c.future ? undefined : `${c.d}: ${tokens(c.n)}`} />
          ))}
        </div>
      </div>
      <div className="row wrap small">
        <span>{he ? `רצף: ${streak} ימים` : `Streak: ${streak} days`}</span>
        <span className="muted">{he ? `${active} ימי שימוש` : `${active} days used`}</span>
        <span className="grow" />
        <span className="heat-legend muted" aria-hidden="true">{he ? "פחות" : "Less"} <span className="heat l0" /><span className="heat l1" /><span className="heat l2" /><span className="heat l3" /><span className="heat l4" /> {he ? "יותר" : "More"}</span>
      </div>
    </section>
  );
}

/**
 * The sub-agents' tokens apart from the chats' own models: in, out and the cache's share, by role (the named agent or
 * its type) and by model. Tokens only: KesherAI keeps no price list for cloud models.
 *
 * @param p.h - The totals from `GET /api/usage`.
 */
function HelperUsageCard({ h }: { h: NonNullable<UsageReport["helpers"]> }) {
  const roleName: Record<string, [string, string]> = { lookup: ["חיפוש", "lookup"], research: ["מחקר", "research"], build: ["בנייה", "build"], external: ["סוכן חיצוני", "outside agent"] };
  const roles = Object.entries(h.byRole).sort((a, b) => b[1].tokens - a[1].tokens);
  const models = Object.entries(h.byModel).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...roles.map(([, r]) => r.tokens), ...models.map(([, n]) => n));
  const pct = h.inputTokens ? Math.round((h.cachedTokens / h.inputTokens) * 100) : 0;
  const bar = (key: string, label: string, n: number, extra?: string) => (
    <li key={key}>
      <span dir="auto" className="hbar-label" title={label}>{label}</span>
      <span className="hbar"><span style={{ width: `${(n / max) * 100}%` }} /></span>
      <span className="muted small">{tokens(n)}{extra ?? ""}</span>
    </li>
  );
  return (
    <section className="card usage-helpers">
      <h2>{L("סוכני משנה", "Sub-agents")}</h2>
      <p className="muted small">
        {L(
          `${h.runs} הרצות · ${h.calls} קריאות · ${tokens(h.inputTokens)} נקראו, ${tokens(h.outputTokens)} נכתבו${pct ? ` · ${pct}% מהמטמון` : ""}. בנפרד מהמודל של הצ׳אט עצמו.`,
          `${h.runs} runs · ${h.calls} calls · ${tokens(h.inputTokens)} read, ${tokens(h.outputTokens)} written${pct ? ` · ${pct}% from the cache` : ""}. Apart from the chat's own model.`,
        )}
        {h.estimated ? ` ${t("coachEstimated")}` : ""}
      </p>
      <h3 className="small">{L("לפי תפקיד", "By role")}</h3>
      <ul className="hbars">{roles.map(([k, r]) => bar(`r-${k}`, roleName[k] ? L(roleName[k][0], roleName[k][1]) : k, r.tokens, ` · ${r.runs}×`))}</ul>
      <h3 className="small">{L("לפי מודל", "By model")}</h3>
      <ul className="hbars">{models.map(([m, n]) => bar(`m-${m}`, m, n))}</ul>
    </section>
  );
}
