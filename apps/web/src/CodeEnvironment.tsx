import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Env {
  setup?: string;
  setupWindows?: string;
  actions?: Array<{ name: string; command: string }>;
  env?: Record<string, string>;
}

/** A code session's environment as its page sees it. */
export interface SessionEnv {
  folder: string | null;
  actions: string[];
  worktree: { branch: string; path: string } | null;
  setup: { status: "running" | "done" | "failed"; log: string } | null;
}

/** Reads a session's environment; while its setup command runs, again every 3 seconds. */
export function useSessionEnv(convId: string): SessionEnv | null {
  const [env, setEnv] = useState<SessionEnv | null>(null);
  useEffect(() => {
    let stop = false;
    let tm: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      void api<SessionEnv>(`/api/conversations/${convId}/environment`).then(
        (e) => {
          if (stop) return;
          setEnv(e);
          if (e.setup?.status === "running") tm = setTimeout(read, 3000);
        },
        () => undefined,
      );
    read();
    return () => {
      stop = true;
      clearTimeout(tm);
    };
  }, [convId]);
  return env;
}

/**
 * Above a code session: its worktree branch, and its setup command (running, done, or failed with the output),
 * like the setup step Codex shows for a new worktree.
 */
export function SessionEnvBar({ convId }: { convId: string }) {
  const env = useSessionEnv(convId);
  if (!env || (!env.worktree && !env.setup)) return null;
  return (
    <div className="session-env row small">
      {env.worktree && (
        <span className="pill" title={env.worktree.path} dir="ltr">
          ⑂ {env.worktree.branch}
        </span>
      )}
      {env.setup && (
        <details className={`session-setup ${env.setup.status}`}>
          <summary>
            {env.setup.status === "running" ? L("⏳ מכין את הסביבה… (ההודעה הראשונה תחכה לזה)", "⏳ Setting up… (the first message waits for it)") : env.setup.status === "done" ? L("✓ הסביבה מוכנה", "✓ Setup done") : L("⚠ ההכנה נכשלה — פתחו לראות למה", "⚠ Setup failed — open to see why")}
          </summary>
          <pre dir="ltr">{env.setup.log}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * The folder's environment for code sessions (like Codex's local environments): a setup command that runs once
 * in each new worktree, actions (Dev server, Tests) to start in the session's terminal, and variables.
 */
export function EnvironmentEditor({ folder, onClose }: { folder: string; onClose: () => void }) {
  const [env, setEnv] = useState<Env | null>(null);
  const [vars, setVars] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Env>(`/api/code-environment?folder=${encodeURIComponent(folder)}`).then((e) => {
      setEnv({ ...e, actions: e.actions?.length ? e.actions : [] });
      setVars(Object.entries(e.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
    }, (e: Error) => toast(e.message));
  }, [folder]);
  if (!env) return null;
  const actions = env.actions ?? [];
  const setAction = (i: number, patch: Partial<{ name: string; command: string }>) => setEnv({ ...env, actions: actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const save = async () => {
    setBusy(true);
    const envVars = Object.fromEntries(vars.split(/\r?\n/).map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!.trim()]));
    try {
      await api(`/api/code-environment?folder=${encodeURIComponent(folder)}`, { method: "PUT", body: { ...env, actions: actions.filter((a) => a.name.trim() && a.command.trim()), env: envVars } });
      toast(L("הסביבה נשמרה.", "Environment saved."));
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack env-editor" role="dialog" aria-label={L("סביבת קוד", "Code environment")}>
      <div className="row">
        <h2 className="grow">{L("הסביבה של התיקייה", "This folder's environment")}</h2>
        <button type="button" className="icon-btn" aria-label={L("סגור", "Close")} onClick={onClose}>✕</button>
      </div>
      <p className="muted small" dir="ltr">{folder}</p>
      <label className="stack small">
        {L("פקודת הכנה — רצה פעם אחת בכל worktree חדש, לפני שהמודל מתחיל (למשל npm install)", "Setup command: runs once in each new worktree before the model starts (e.g. npm install)")}
        <input dir="ltr" value={env.setup ?? ""} placeholder="npm install" onChange={(e) => setEnv({ ...env, setup: e.target.value })} />
      </label>
      <label className="stack small">
        {L("ב-Windows, אם שונה (לא חובה)", "On Windows, if different (optional)")}
        <input dir="ltr" value={env.setupWindows ?? ""} onChange={(e) => setEnv({ ...env, setupWindows: e.target.value })} />
      </label>
      <div className="stack small">
        <span>{L("פעולות — כפתורים במסוף של הסשן (שרת פיתוח, בדיקות)", "Actions: buttons in the session's terminal (dev server, tests)")}</span>
        {actions.map((a, i) => (
          <div key={i} className="row env-action">
            <input value={a.name} placeholder={L("שם", "Name")} aria-label={L("שם הפעולה", "Action name")} onChange={(e) => setAction(i, { name: e.target.value })} />
            <input dir="ltr" className="grow" value={a.command} placeholder="npm run dev" aria-label={L("הפקודה", "Command")} onChange={(e) => setAction(i, { command: e.target.value })} />
            <button type="button" className="icon-btn" aria-label={L("הסר", "Remove")} onClick={() => setEnv({ ...env, actions: actions.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        {actions.length < 10 && <button type="button" onClick={() => setEnv({ ...env, actions: [...actions, { name: "", command: "" }] })}>＋ {L("פעולה", "Action")}</button>}
      </div>
      <label className="stack small">
        {L("משתנים — שורה לכל אחד, NAME=value. עוברים לפקודות של הסשן ולא נכתבים לצ'אט (פקודה עדיין יכולה להדפיס אותם).", "Variables: one per line, NAME=value. Given to the session's commands, not written into the chat (a command can still print them).")}
        <textarea dir="ltr" rows={3} value={vars} onChange={(e) => setVars(e.target.value)} placeholder="API_URL=http://localhost:3000" />
      </label>
      <p className="muted small">{L("קבצים כמו .env נכנסים ל-worktree חדש לפי הקובץ .worktreeinclude בשורש הפרויקט (כמו ב-Claude Code).", "Files such as .env go into a new worktree by the .worktreeinclude file at the project's root (as in Claude Code).")}</p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{L("שמור", "Save")}</button>
        <button type="button" onClick={onClose}>{L("ביטול", "Cancel")}</button>
      </div>
    </section>
  );
}
