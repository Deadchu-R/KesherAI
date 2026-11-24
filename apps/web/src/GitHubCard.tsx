import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** `GET /api/github`: the sign-in's state (never the token). */
interface GitHubStatus {
  configured: boolean;
  connected: boolean;
  via: "gcm" | "device" | null;
  login: string | null;
  scopes: string | null;
  customClient: boolean;
  /** Git Credential Manager can sign in here (only on the PC that runs KesherAI). */
  gcm: boolean;
  pending: { kind: "device" | "gcm"; state: "waiting" | "done" | "denied" | "expired"; error?: string } | null;
}

/** What each GitHub permission lets KesherAI do, in words. */
const SCOPES: Record<string, [string, string]> = {
  repo: ["המאגרים שלך: קוד, issues ו-pull requests (גם פרטיים)", "Your repositories: code, issues and pull requests (private ones too)"],
  "read:org": ["לראות את הארגונים שלך", "See your organisations"],
  workflow: ["לשנות קובצי GitHub Actions (תיקון בדיקות שנכשלו)", "Change GitHub Actions files (fixing failed checks)"],
  gist: ["Gists", "Gists"],
  "read:user": ["הפרופיל שלך (קריאה)", "Your profile (read)"],
  user: ["הפרופיל שלך", "Your profile"],
};

/**
 * Settings › Connections › GitHub: sign in without pasting a token. On the PC, through Git Credential Manager when git
 * uses it (its browser sign-in; the token stays in the system's credential store), else with a code approved on
 * github.com, which also works from the phone (the code shows there and the link opens there). Signed in: the
 * account, what it may do, the repositories it reaches, and Sign out. Pull requests, checks and the GitHub tools use
 * this account.
 */
export function GitHubCard() {
  const [st, setSt] = useState<GitHubStatus | null>(null);
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [repos, setRepos] = useState<{ count: number; more: boolean; names: string[] } | null>(null);
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api<GitHubStatus>("/api/github").then(setSt, () => undefined);
  useEffect(() => void load(), []);

  const waiting = st?.pending?.state === "waiting";
  // While a sign-in waits, the page checks every few seconds (GitHub or GCM finishes it on the server).
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void load(), 2500);
    return () => clearInterval(id);
  }, [waiting]);
  useEffect(() => {
    if (st?.connected) void api<{ count: number; more: boolean; names: string[] }>("/api/github/repos").then(setRepos, () => setRepos(null));
    else setRepos(null);
    if (!waiting) setCode(null);
  }, [st?.connected, st?.login, waiting]);
  if (!st) return null;

  const run = (p: Promise<unknown>) => {
    setBusy(true);
    void p.then(load, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const withCode = () => run(api<{ userCode: string; verificationUri: string }>("/api/github/connect", { method: "POST" }).then(setCode));
  const withGcm = () => run(api("/api/github/connect-gcm", { method: "POST" }));
  const cancel = () => run(api("/api/github/cancel", { method: "POST" }).then(() => setCode(null)));
  const signOut = () => {
    if (!window.confirm(L("להתנתק מ-GitHub ב-KesherAI?", "Sign out of GitHub in KesherAI?"))) return;
    run(api("/api/github/disconnect", { method: "POST" }));
  };
  const openGitHub = async () => {
    if (!code) return;
    await navigator.clipboard?.writeText(code.userCode).catch(() => undefined);
    // Opens where the user is: the PC's browser on the PC, the phone's on the phone.
    window.open(code.verificationUri, "_blank", "noopener");
  };
  const failed = st.pending && (st.pending.state === "denied" || st.pending.state === "expired");
  const scopes = (st.scopes ?? "").split(/[\s,]+/).filter(Boolean);

  return (
    <section className="card stack gh-card">
      <div className="row wrap">
        <h2 className="grow">GitHub</h2>
        <span className={`pill ${st.connected ? "good" : "warn"}`} dir="auto">{st.connected ? L(`מחובר${st.login ? ` · ${st.login}` : ""}`, `Signed in${st.login ? ` · ${st.login}` : ""}`) : L("לא מחובר", "Not signed in")}</span>
      </div>

      {st.connected ? (
        <>
          <p className="small muted" dir="auto">
            {st.via === "gcm"
              ? L("דרך Git Credential Manager: הטוקן נשמר במנהל האישורים של Windows, לא אצל KesherAI.", "Through Git Credential Manager: the token stays in Windows' credential store, not in KesherAI.")
              : L("עם קוד שאישרת ב-GitHub: הטוקן שמור מוצפן במחשב הזה.", "With a code you approved on GitHub: the token is kept encrypted on this PC.")}
          </p>
          {scopes.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="small"><b>{L("מה KesherAI יכול לעשות", "What KesherAI may do")}</b></span>
              <ul className="small gh-scopes">
                {scopes.map((s) => <li key={s} dir="auto"><code dir="ltr">{s}</code> {SCOPES[s] ? L(SCOPES[s][0], SCOPES[s][1]) : ""}</li>)}
              </ul>
            </div>
          )}
          {repos && (
            <div className="stack" style={{ gap: 2 }}>
              <span className="small" dir="auto"><b>{L(`מגיע ל-${repos.count}${repos.more ? "+" : ""} מאגרים`, `Reaches ${repos.count}${repos.more ? "+" : ""} repositories`)}</b></span>
              {repos.names.length > 0 && <span className="small muted gh-repos">{repos.names.map((n, i) => <span key={n}>{i > 0 && " · "}<bdi>{n}</bdi></span>)}</span>}
            </div>
          )}
          <p className="small muted" dir="auto">{L("משמש לפתיחת pull requests, לבדיקות GitHub Actions ולכלי GitHub בצ'אטים.", "Used to open pull requests, read GitHub Actions checks and for the GitHub tools in chats.")}</p>
          <div className="row wrap">
            <button type="button" disabled={busy} onClick={signOut}>{L("התנתק", "Sign out")}</button>
            {st.via === "gcm" && <span className="small muted" dir="auto">{L("git במחשב נשאר מחובר.", "git on this PC stays signed in.")}</span>}
          </div>
        </>
      ) : waiting && st.pending?.kind === "gcm" ? (
        <>
          <p className="small" dir="auto">{L("חלון ההתחברות של GitHub נפתח במחשב. התחבר ואשר שם; הכרטיס יתעדכן לבד.", "GitHub's sign-in window opened on this PC. Sign in and approve there; this card updates by itself.")}</p>
          <div className="row"><button type="button" disabled={busy} onClick={cancel}>{L("ביטול", "Cancel")}</button></div>
        </>
      ) : waiting && code ? (
        <>
          <p className="small" dir="auto">{L("הקוד שלך:", "Your code:")}</p>
          <p className="gh-code" dir="ltr">{code.userCode}</p>
          <button type="button" className="primary" onClick={() => void openGitHub()}>{L("העתק ופתח את GitHub", "Copy and open GitHub")}</button>
          <p className="small muted" dir="auto">{isRemote() ? L("GitHub ייפתח בטלפון. הדבק את הקוד ואשר; הכרטיס יתעדכן לבד.", "GitHub opens on this phone. Paste the code and approve; this card updates by itself.") : L("הדבק את הקוד ב-GitHub ואשר; הכרטיס יתעדכן לבד.", "Paste the code on GitHub and approve; this card updates by itself.")}</p>
          <div className="row"><button type="button" disabled={busy} onClick={cancel}>{L("ביטול", "Cancel")}</button></div>
        </>
      ) : (
        <>
          <p className="small muted" dir="auto">{L("בלי טוקן להדביק: GitHub מראה מה KesherAI יוכל לעשות, ואתה מאשר שם.", "No token to paste: GitHub shows what KesherAI may do, and you approve it there.")}</p>
          {failed && <p className="small error" dir="auto">{st.pending?.state === "expired" ? L("הקוד פג. נסה שוב.", "The code expired. Try again.") : (st.pending?.error ?? L("GitHub לא אישר את ההתחברות.", "GitHub did not approve the sign-in."))}</p>}
          {st.gcm ? (
            <div className="row wrap">
              <button type="button" className="primary" disabled={busy} onClick={withGcm}>{L("התחבר עם GitHub", "Sign in with GitHub")}</button>
              {st.configured && <button type="button" disabled={busy} onClick={withCode}>{L("התחבר עם קוד", "Sign in with a code")}</button>}
            </div>
          ) : st.configured ? (
            <div className="row wrap"><button type="button" className="primary" disabled={busy} onClick={withCode}>{L("התחבר עם GitHub", "Sign in with GitHub")}</button></div>
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); run(api("/api/github/client", { method: "PUT", body: { clientId: clientId.trim() } })); }}>
              <p className="small" dir="auto">{L("בגרסה הזו אין עדיין Client ID של GitHub. פעם אחת: GitHub › Settings › Developer settings › OAuth Apps › New, סמן Enable Device Flow, והדבק כאן רק את ה-Client ID (לא את הסוד).", "This build has no GitHub Client ID yet. Once: GitHub › Settings › Developer settings › OAuth Apps › New, tick Enable Device Flow, and paste only its Client ID here (not the secret).")}</p>
              {isRemote() ? (
                <p className="small muted" dir="auto">{L("את ה-Client ID מדביקים במחשב.", "Paste the Client ID on the PC.")}</p>
              ) : (
                <div className="row wrap">
                  <input className="grow" dir="ltr" placeholder="Ov23li…" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client ID" />
                  <button type="submit" className="primary" disabled={busy || !clientId.trim()}>{L("שמור", "Save")}</button>
                </div>
              )}
            </form>
          )}
          <p className="small muted" dir="auto">{L("ההרשאות: repo (המאגרים, issues ו-PR), read:org (הארגונים), workflow (קובצי Actions).", "Permissions: repo (repositories, issues and PRs), read:org (organisations), workflow (Actions files).")}</p>
        </>
      )}
    </section>
  );
}
