import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { Diff } from "../ChatCards";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface ChangedFile { path: string; state: "A" | "M" | "D" | "R" | "?"; added: number; removed: number; from?: string }
interface GitState { repo: boolean; branch?: string; upstream?: string; ahead: number; behind: number; files: ChangedFile[]; origin?: boolean; github?: string; head?: { sha: string; subject: string } }
interface Run { id: number; name: string; status: string; conclusion: string | null; url: string }
interface GitResult { ok: boolean; out: string; sha?: string }

/** The diff from its first hunk (git's header lines say nothing the row does not). */
const hunks = (d: string) => (d.includes("\n@@") ? d.slice(d.indexOf("\n@@") + 1) : d);

const STATE: Record<ChangedFile["state"], [string, string]> = { A: ["נוסף", "added"], M: ["שונה", "changed"], D: ["נמחק", "deleted"], R: ["שם חדש", "renamed"], "?": ["חדש", "new"] };

/**
 * The project's git on the code page (computer and phone): what changed since
 * the last commit with a diff per file, one button for the next step (Commit →
 * Push), a commit message the chat's model writes in the repo's style, the
 * branch and its switcher, and the GitHub Actions runs after a push. A failed
 * step shows git's output with "Fix in chat". See docs/RESEARCH_LOG.md (Claude
 * Code Desktop, Kilo).
 *
 * @param props.convId - The code chat.
 * @param props.refresh - Changes whenever the agent may have changed files.
 * @param props.onFixInChat - Puts text into the chat's message box.
 */
export function GitPanel({ convId, refresh, onFixInChat }: { convId: string; refresh: number; onFixInChat?: (text: string) => void }) {
  const base = `/api/conversations/${convId}/git`;
  const [st, setSt] = useState<GitState | null>(null);
  const [openFile, setOpenFile] = useState("");
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [fail, setFail] = useState<{ step: string; out: string } | null>(null);
  const [note, setNote] = useState("");
  const [branches, setBranches] = useState<{ current?: string; local: string[]; remote: string[] } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [runs, setRuns] = useState<{ sha: string; list: Run[]; reason?: string } | null>(null);
  const [reload, setReload] = useState(0);
  const runTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void api<GitState>(base).then(setSt, () => setSt({ repo: false, ahead: 0, behind: 0, files: [] }));
    setDiffs({});
  }, [convId, refresh, reload]);
  useEffect(() => () => clearTimeout(runTimer.current), []);

  const loadRuns = (sha: string) => {
    clearTimeout(runTimer.current);
    void api<{ runs: Run[]; reason?: string }>(`${base}/runs?sha=${sha}`).then((r) => {
      setRuns({ sha, list: r.runs, ...(r.reason ? { reason: r.reason } : {}) });
      // Keep watching while a run is queued or running (GitHub may take a few seconds to start one).
      if (!r.reason && (r.runs.length === 0 || r.runs.some((x) => x.status !== "completed"))) runTimer.current = setTimeout(() => loadRuns(sha), 15_000);
    }, () => undefined);
  };

  if (!st) return null;
  if (!st.repo) return <p className="muted">{L("התיקייה הזו לא מנוהלת ב־git.", "This folder is not a git repository.")}</p>;

  const step = async (name: string, fn: () => Promise<GitResult>) => {
    setBusy(name);
    setFail(null);
    setNote("");
    try {
      const r = await fn();
      if (!r.ok) setFail({ step: name, out: r.out });
      return r;
    } catch (e) {
      setFail({ step: name, out: (e as Error).message });
      return undefined;
    } finally {
      setBusy("");
      setReload((n) => n + 1);
    }
  };
  const toggleFile = (f: ChangedFile) => {
    if (openFile === f.path) return setOpenFile("");
    setOpenFile(f.path);
    if (diffs[f.path] === undefined) {
      void api<{ diff: string; cut: boolean }>(`${base}/diff?path=${encodeURIComponent(f.path)}${f.state === "?" ? "&untracked=1" : ""}`).then(
        (d) => setDiffs((x) => ({ ...x, [f.path]: hunks(d.diff) + (d.cut ? `\n… ${L("(ה־diff ארוך מדי, קוצר)", "(diff too long, cut)")}` : "") })),
        (e: Error) => setDiffs((x) => ({ ...x, [f.path]: e.message })),
      );
    }
  };
  const writeMessage = async () => {
    setBusy("message");
    setFail(null);
    try {
      const r = await api<{ message: string }>(`${base}/message`, { method: "POST", body: {} });
      setMessage(r.message);
    } catch (e) {
      setFail({ step: "message", out: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  const commit = async () => {
    const r = await step("commit", () => api<GitResult>(`${base}/commit`, { method: "POST", body: { message } }));
    if (r?.ok) {
      setWriting(false);
      setMessage("");
      setNote(L(`נשמר commit ${r.sha ?? ""}`, `Committed ${r.sha ?? ""}`));
    }
  };
  const push = async () => {
    if (!confirm(L(`לדחוף ${st.ahead || ""} commit ל־${st.upstream ?? "origin"}?`, `Push ${st.ahead || ""} commit(s) to ${st.upstream ?? "origin"}?`))) return;
    const r = await step("push", () => api<GitResult>(`${base}/push`, { method: "POST" }));
    if (r?.ok) {
      setNote(L("נדחף.", "Pushed."));
      if (st.github && st.head) loadRuns(st.head.sha);
    }
  };
  const openBranches = () => void api<typeof branches>(`${base}/branches`).then(setBranches, () => undefined);
  const switchTo = async (name: string, create = false) => {
    const r = await step("switch", () => api<GitResult>(`${base}/switch`, { method: "POST", body: { name, create } }));
    if (r?.ok) {
      setBranches(null);
      setNewBranch("");
    }
  };

  const added = st.files.reduce((n, f) => n + f.added, 0);
  const removed = st.files.reduce((n, f) => n + f.removed, 0);
  const stepNames: Record<string, string> = { commit: "commit", push: "push", pull: "pull", switch: L("החלפת ענף", "switch branch"), message: L("כתיבת הודעה", "writing the message") };

  return (
    <section className="git-panel stack" aria-label="Git">
      <div className="row wrap git-head">
        <button type="button" className="pill mono" dir="ltr" onClick={() => (branches ? setBranches(null) : openBranches())} aria-expanded={!!branches} title={L("החלפת ענף", "Switch branch")}>
          ⑂ {st.branch ?? "HEAD"}
          {st.ahead > 0 && ` ↑${st.ahead}`}
          {st.behind > 0 && ` ↓${st.behind}`}
        </button>
        {st.files.length > 0 && (
          <span className="muted small">
            <bdi dir="ltr"><span className="git-add">+{added}</span> <span className="git-del">−{removed}</span></bdi> · {L(`${st.files.length} קבצים`, `${st.files.length} files`)}
          </span>
        )}
        <span className="grow" />
        {st.behind > 0 && <button type="button" disabled={!!busy} onClick={() => void step("pull", () => api<GitResult>(`${base}/pull`, { method: "POST" }))}>{busy === "pull" ? "…" : L(`משיכה (${st.behind})`, `Pull (${st.behind})`)}</button>}
        {st.files.length > 0 ? (
          <button type="button" className="primary" disabled={!!busy || writing} onClick={() => setWriting(true)}>Commit</button>
        ) : (
          st.origin && (st.ahead > 0 || (!st.upstream && st.head)) && <button type="button" className="primary" disabled={!!busy} onClick={() => void push()}>{busy === "push" ? L("דוחף…", "Pushing…") : `Push${st.ahead ? ` (${st.ahead})` : ""}`}</button>
        )}
      </div>

      {branches && (
        <div className="card stack git-branches">
          <div className="row wrap">
            <input dir="ltr" placeholder={L("ענף חדש מהנוכחי", "New branch from this one")} value={newBranch} onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, "-"))} />
            <button type="button" disabled={!newBranch || !!busy} onClick={() => void switchTo(newBranch, true)}>{L("יצירה", "Create")}</button>
          </div>
          {st.files.length > 0 && <p className="muted small">{L("יש שינויים שלא נשמרו: git יעביר אותם איתך, או יסרב אם הם מתנגשים.", "There are uncommitted changes: git carries them over, or refuses if they clash.")}</p>}
          <div className="list" dir="ltr">
            {branches.local.map((b) => (
              <button key={b} type="button" className={`tree-row ${b === branches.current ? "on" : ""}`} disabled={b === branches.current || !!busy} onClick={() => void switchTo(b)}>{b}</button>
            ))}
            {branches.remote.filter((r) => !branches.local.includes(r.replace(/^[^/]+\//, ""))).map((b) => (
              <button key={b} type="button" className="tree-row muted" disabled={!!busy} onClick={() => void switchTo(b)}>{b}</button>
            ))}
          </div>
        </div>
      )}

      {writing && (
        <div className="card stack">
          <div className="row">
            <strong className="grow">{L("הודעת commit", "Commit message")}</strong>
            <button type="button" disabled={!!busy} onClick={() => void writeMessage()} title={L("המודל של הצ'אט כותב לפי השינויים ובסגנון ה־commits האחרונים", "The chat's model writes it from the changes, in the style of the recent commits")}>
              {busy === "message" ? L("כותב…", "Writing…") : L("✨ כתיבה", "✨ Write it")}
            </button>
          </div>
          <textarea dir="auto" rows={Math.min(14, Math.max(4, message.split("\n").length + 1))} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={L("מה השתנה ולמה", "What changed and why")} />
          <div className="row">
            <button type="button" className="primary" disabled={!message.trim() || !!busy} onClick={() => void commit()}>{busy === "commit" ? "…" : L(`שמירת ${st.files.length} קבצים`, `Commit ${st.files.length} files`)}</button>
            <button type="button" onClick={() => setWriting(false)}>{L("ביטול", "Cancel")}</button>
          </div>
        </div>
      )}

      {note && <p className="pill good" style={{ alignSelf: "flex-start" }}>{note}</p>}
      {fail && (
        <div className="card stack git-fail">
          <span className="error">{L(`${stepNames[fail.step] ?? fail.step} נכשל:`, `${stepNames[fail.step] ?? fail.step} failed:`)}</span>
          <pre className="code" dir="ltr">{fail.out}</pre>
          {onFixInChat && (
            <button type="button" style={{ alignSelf: "flex-start" }} onClick={() => onFixInChat(L(`git ${fail.step} נכשל. תתקן בבקשה:\n\`\`\`\n${fail.out.slice(-3000)}\n\`\`\``, `git ${fail.step} failed. Please fix it:\n\`\`\`\n${fail.out.slice(-3000)}\n\`\`\``))}>
              {L("תיקון בצ'אט", "Fix in chat")}
            </button>
          )}
        </div>
      )}

      {runs && (
        <div className="stack git-runs">
          <span className="muted small">{L("GitHub Actions של", "GitHub Actions for")} <span className="mono" dir="ltr">{runs.sha}</span></span>
          {runs.reason === "connect-github" && <p className="muted small">{L("חבר את GitHub בהגדרות כדי לראות את הריצות.", "Connect GitHub in Settings to see the runs.")}</p>}
          {!runs.reason && runs.list.length === 0 && <p className="muted small">{L("מחכה ש־GitHub יתחיל ריצה…", "Waiting for GitHub to start a run…")}</p>}
          {runs.list.map((r) => {
            const done = r.status === "completed";
            const good = r.conclusion === "success";
            return (
              <div key={r.id} className="row">
                <span className={`pill ${!done ? "warn" : good ? "good" : "bad"}`}>{!done ? L("רץ", "running") : good ? L("עבר", "passed") : L("נכשל", "failed")}</span>
                <a className="grow" href={r.url} target="_blank" rel="noreferrer" dir="auto">{r.name}</a>
                {done && !good && onFixInChat && <button type="button" onClick={() => onFixInChat(L(`ה־workflow "${r.name}" נכשל ב־GitHub (${r.url}). תבדוק את הלוג ותתקן.`, `The "${r.name}" workflow failed on GitHub (${r.url}). Check its log and fix it.`))}>{L("תיקון בצ'אט", "Fix in chat")}</button>}
              </div>
            );
          })}
        </div>
      )}

      {st.files.length === 0 && !writing && <p className="muted small">{L("אין שינויים מאז ה־commit האחרון", "No changes since the last commit")}{st.head ? <>: <bdi className="mono">{st.head.sha}</bdi> <bdi>{st.head.subject}</bdi></> : null}</p>}
      <div className="list git-files">
        {st.files.map((f) => (
          <div key={f.path}>
            <button type="button" className={`git-file ${openFile === f.path ? "on" : ""}`} aria-expanded={openFile === f.path} onClick={() => toggleFile(f)}>
              <span className={`git-state s-${f.state === "?" ? "n" : f.state}`} title={L(STATE[f.state][0], STATE[f.state][1])}>{f.state === "?" ? "N" : f.state}</span>
              <bdi className="mono grow git-path" dir="ltr">{f.path}</bdi>
              <span className="mono small" dir="ltr"><span className="git-add">+{f.added}</span> <span className="git-del">−{f.removed}</span></span>
            </button>
            {openFile === f.path && (diffs[f.path] === undefined ? <p className="muted small">…</p> : <Diff diff={diffs[f.path]!} />)}
          </div>
        ))}
      </div>
    </section>
  );
}
