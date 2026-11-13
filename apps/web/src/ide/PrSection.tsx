import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Pr {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  base: string;
}
interface PrView {
  github: boolean;
  connected?: boolean;
  pr: Pr | null;
  checks: { state: "none" | "pending" | "success" | "failure"; runs: Array<{ id: number; name: string; conclusion: string | null; status: string; url: string }> } | null;
  compare?: string;
  base?: string;
  branch?: string;
  onBase?: boolean;
  watch: { autoFix: boolean; autoMerge: boolean } | null;
}

/**
 * The session branch's pull request, like Claude Code's desktop: Create PR (the model writes the title and body),
 * its checks, Fix failing checks (the failed logs go to the chat), Merge, and watching it in the background
 * (fix failures by itself, merge when all checks pass).
 */
export function PrSection({ convId, refresh }: { convId: string; refresh: number }) {
  const base = `/api/conversations/${convId}/git`;
  const [v, setV] = useState<PrView | null>(null);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState("");
  const load = () => void api<PrView>(`${base}/pr`).then(setV, () => setV(null));
  useEffect(load, [convId, refresh]);
  // While checks run, look again every 30 seconds.
  useEffect(() => {
    if (v?.checks?.state !== "pending") return;
    const tm = setInterval(load, 30_000);
    return () => clearInterval(tm);
  }, [v?.checks?.state]);
  if (!v?.github) return null;

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const write = () =>
    run("write", async () => {
      setDraft(await api<{ title: string; body: string }>(`${base}/pr-text`, { method: "POST" }));
    });
  const create = () =>
    run("create", async () => {
      const r = await api<{ pr?: Pr; compare?: string }>(`${base}/pr`, { method: "POST", body: draft ?? { title: "" } });
      if (r.compare) window.open(r.compare, "_blank", "noopener");
      setDraft(null);
      load();
    });
  const watch = (w: { autoFix: boolean; autoMerge: boolean }) =>
    run("watch", async () => {
      const r = await api<{ watch: PrView["watch"] }>(`${base}/watch`, { method: "PUT", body: w });
      setV({ ...v, watch: r.watch });
    });
  const pr = v.pr;
  const checks = v.checks;
  const failed = checks?.runs.filter((r) => r.conclusion === "failure") ?? [];

  return (
    <div className="pr-section stack">
      {!pr || pr.state !== "open" ? (
        <>
          {pr && <p className="small muted">{pr.state === "merged" ? L(`PR #${pr.number} מוזג.`, `PR #${pr.number} was merged.`) : L(`PR #${pr.number} נסגר.`, `PR #${pr.number} was closed.`)}</p>}
          {v.onBase ? (
            <p className="muted small">{L(`את/ה על ${v.base} עצמו: PR צריך ענף משלו (התחילו סשן ב-worktree).`, `You are on ${v.base} itself: a PR needs its own branch (start the session in a worktree).`)}</p>
          ) : draft ? (
            <div className="stack">
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label={L("כותרת ה-PR", "PR title")} />
              <textarea rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label={L("תיאור ה-PR", "PR description")} />
              <div className="row">
                <button type="button" className="primary" disabled={!!busy || !draft.title.trim()} onClick={() => void create()}>{busy === "create" ? L("פותח…", "Opening…") : v.connected ? L("Push ופתיחת PR", "Push and open PR") : L("Push ופתיחה ב-GitHub", "Push and open on GitHub")}</button>
                <button type="button" onClick={() => setDraft(null)}>{L("ביטול", "Cancel")}</button>
              </div>
              {!v.connected && <p className="muted small">{L("אין חשבון GitHub מחובר: הדף של GitHub ייפתח עם הענף, והכותרת תצטרך הדבקה שם.", "No GitHub account connected: GitHub's page opens with the branch; paste the title there.")}</p>}
            </div>
          ) : (
            <button type="button" disabled={!!busy} onClick={() => void write()}>{busy === "write" ? L("המודל כותב…", "The model is writing…") : L("⤴ Create PR", "⤴ Create PR")}</button>
          )}
        </>
      ) : (
        <>
          <div className="row">
            <a className="grow" href={pr.url} target="_blank" rel="noreferrer" dir="auto">#{pr.number} {pr.title}</a>
            {checks && (
              <span className={`pill ${checks.state === "success" ? "good" : checks.state === "failure" ? "bad" : checks.state === "pending" ? "warn" : ""}`}>
                {checks.state === "success" ? L("הבדיקות עברו", "Checks passed") : checks.state === "failure" ? L(`${failed.length} נכשלו`, `${failed.length} failed`) : checks.state === "pending" ? L("בדיקות רצות", "Checks running") : L("אין בדיקות", "No checks")}
              </span>
            )}
          </div>
          <div className="row pr-actions">
            {failed.length > 0 && <button type="button" disabled={!!busy} onClick={() => void run("fix", async () => { await api(`${base}/fix-checks`, { method: "POST" }); toast(L("הלוגים נשלחו לצ'אט; המודל מתקן.", "The logs went to the chat; the model is fixing it.")); })}>{L("תקן בדיקות שנכשלו", "Fix failing checks")}</button>}
            {checks?.state === "success" && v.connected && (
              <button type="button" className="primary" disabled={!!busy} onClick={() => confirm(L(`למזג את PR #${pr.number} ל-${pr.base}?`, `Merge PR #${pr.number} into ${pr.base}?`)) && void run("merge", async () => { await api(`${base}/merge`, { method: "POST" }); load(); })}>{L("מיזוג", "Merge")}</button>
            )}
          </div>
          {v.connected && (
            <div className="stack small pr-watch">
              <label className="row"><input type="checkbox" checked={!!v.watch?.autoFix} disabled={!!busy} onChange={(e) => void watch({ autoFix: e.target.checked, autoMerge: !!v.watch?.autoMerge })} />{L("לתקן לבד בדיקות שנכשלות (שולח את הלוג לצ'אט)", "Fix failing checks by itself (sends the log to the chat)")}</label>
              <label className="row"><input type="checkbox" checked={!!v.watch?.autoMerge} disabled={!!busy} onChange={(e) => void watch({ autoFix: !!v.watch?.autoFix, autoMerge: e.target.checked })} />{L("למזג כשכל הבדיקות עוברות", "Merge when all checks pass")}</label>
            </div>
          )}
        </>
      )}
    </div>
  );
}
