import { useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { explainCommand } from "@kesher/shared";
import { api, withToken } from "./api";
import { stepLabel } from "./Activity";
import { getLocale, t } from "./i18n";
import { desktop } from "./library";
import { RichText } from "./RichText";
import { Select } from "./ui/Select";

/*
 * The cards a chat shows between messages: a tool the model ran (with its
 * diff), an approval it waits for, and a question it asks. One file, so the
 * chat page, the Blueprint bubble and any other chat view render them the
 * same way.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

/**
 * Colours a unified diff.
 *
 * @param props - `diff` is the text; `onLine` (optional) fires with the line's index and text when a line is clicked.
 */
export function Diff({ diff, onLine, marks }: { diff: string; onLine?: (i: number, line: string) => void; marks?: Record<number, string[]> }) {
  return (
    <pre className={`code diff${onLine ? " clickable" : ""}`} dir="ltr">
      {diff.split("\n").map((l, i) => (
        <span key={i}>
          <span
            className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}
            onClick={onLine ? () => onLine(i, l) : undefined}
          >
            {l}
            {"\n"}
          </span>
          {/* Review comments on this line ("Review code"). */}
          {marks?.[i]?.map((m, j) => (
            <span key={j} className="diff-mark" dir="auto">
              {m}
              {"\n"}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}

export function summary(name: string, input: Record<string, unknown>): string {
  const v = input.path ?? input.command ?? input.pattern ?? input.prompt ?? input.glob ?? input.question;
  return typeof v === "string" ? v : "";
}

export function ToolCard({ call, result }: { call: Ev<"tool_call">; result?: Ev<"tool_result"> }) {
  if (call.name === "ask_user") return null;
  // Agent group: a member's part, shown as that member's answer.
  if (call.name === "ask_member") {
    const head = result?.ok ? result.output.split("\n")[0] ?? "" : "";
    const body = result?.ok ? result.output.slice(head.length + 1) : result?.output ?? "";
    return (
      <details className="teammate member" open={!!result}>
        <summary>
          <span className="mate-role">{head || `👤 ${String(call.input.member ?? "")}`}</span>
          {!result && <span className="muted small">{getLocale() === "he" ? "עובד…" : "working…"}</span>}
        </summary>
        <p className="muted small" dir="auto">{String(call.input.task ?? "")}</p>
        {result && <div className="mate-body"><RichText text={body} /></div>}
      </details>
    );
  }
  const state = !result ? "pending" : result.ok ? "ok" : "fail";
  return (
    <details className={`tool ${state}`}>
      <summary>
        <span className="tool-state" aria-hidden>{state === "pending" ? "…" : state === "ok" ? "✓" : "✕"}</span>
        <span className="tool-label" dir="auto">{stepLabel({ call, ...(result ? { result } : {}) })}</span>
      </summary>
      {result?.diff && <Diff diff={result.diff} />}
      {result?.assetIds?.map((id) => (
        <img key={id} src={withToken(`/api/assets/${id}`)} alt={summary(call.name, call.input)} className="asset" />
      ))}
      {result && !result.diff && <pre className="code" dir="ltr">{result.output}</pre>}
    </details>
  );
}

/** Shows the server's approval reason in the user's language. */
export function reasonText(reason: string): string {
  if (reason === "The agent wants to change a file.") return t("reasonWrite");
  if (reason === "The agent wants to run a command on your computer.") return t("reasonExec");
  const danger = /^This command (.+), so it always needs your approval\.$/.exec(reason);
  if (danger) return t("reasonDanger", { what: danger[1]! });
  return reason;
}

export function ApprovalCard({ convId, ev, pending, result }: { convId: string; ev: Ev<"approval_request">; pending: boolean; result?: Ev<"approval_result"> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  // "Always": for how long (0 = for good) and, for a command, only commands that start like this one.
  const [minutes, setMinutes] = useState(0);
  const firstCmd = ev.name === "run_command" && typeof ev.input.command === "string" ? ev.input.command.trim() : "";
  const [onlyCmd, setOnlyCmd] = useState(!!firstCmd);
  const [prefix, setPrefix] = useState(() => firstCmd.split(/\s+/).slice(0, firstCmd.split(/\s+/).length > 2 ? 2 : 3).join(" ").split(/[;&|]/)[0]!.trim());
  const decide = async (decision: "allow" | "always" | "deny", scope?: "conversation" | "model" | "everywhere") => {
    setBusy(true);
    const always = decision === "always" ? { ...(minutes > 0 ? { minutes } : {}), ...(firstCmd && onlyCmd && prefix.trim() ? { command: prefix.trim() } : {}) } : {};
    await api(`/api/conversations/${convId}/approvals/${ev.requestId}`, { method: "POST", body: { decision, ...(scope ? { scope } : {}), ...always, ...(note ? { feedback: note } : {}) } }).catch(() => undefined);
    setBusy(false);
  };
  if (!pending) {
    const d = result?.decision;
    return (
      <p className="muted approval-done">
        <span dir="auto">{summary(ev.name, ev.input)}</span> · {d === "deny" ? t("denied") : d === "expired" ? t("expired") : t("allowed")}
      </p>
    );
  }
  const cmd = ev.name === "run_command" && typeof ev.input.command === "string" ? ev.input.command : ev.name === "install_tool" ? ev.preview.split("\n").pop() : undefined;
  const parts = cmd ? explainCommand(cmd) : [];
  const he = getLocale() === "he";
  const path = typeof ev.input.path === "string" ? ev.input.path : "";
  const headline =
    ev.name === "run_command" ? t("apRun")
    : ev.name === "install_tool" ? t("apInstall", { what: String(ev.input.name ?? "") })
    : ev.name === "build_executable" ? t("apBuild", { what: String(ev.input.entry ?? "") })
    : ev.name === "download_file" ? t("apDownload")
    : ev.name === "computer_use_app" ? t("apComputer", { what: String(ev.input.app ?? "") })
    : ev.name === "write_file" || ev.name === "edit_file" ? t("apWrite", { what: path })
    : reasonText(ev.reason);
  const danger = /^This command .+, so it always needs your approval\.$/.test(ev.reason);
  return (
    <div className="card approval" role="group" aria-label={headline} data-guard="">
      <strong dir="auto">{headline}</strong>
      {danger && <p className="ap-danger">⚠ {reasonText(ev.reason)}</p>}
      {ev.purpose && (
        <div className="ap-why">
          <span className="muted small">{t("apWhy")}</span>
          <p dir="auto">{ev.purpose}</p>
        </div>
      )}
      {ev.name === "run_command" ? <pre className="code" dir="ltr">{ev.preview}</pre> : ev.preview.startsWith("---") || ev.preview.includes("@@") ? <Diff diff={ev.preview} /> : <pre className="code" dir="ltr">{ev.preview}</pre>}
      {parts.length > 0 && (
        <div className="ap-what">
          <span className="muted small">{t("apWhat")}</span>
          <ul>
            {parts.map((p, i) => (
              <li key={i} className={p.risky ? "risky" : ""}>
                <span dir="auto">{he ? p.he : p.en}</span>
                {parts.length > 1 && <code dir="ltr">{p.text}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {ev.folder && (
        <p className="muted small">
          {t("apWhere")} <code dir="ltr">{ev.folder}</code>
        </p>
      )}
      <input placeholder={t("noteForAgent")} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("noteForAgent")} />
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void decide("allow")}>{t("allow")}</button>
        {/* The browser: Allow once / Always on this site / Deny (like Claude in Chrome); sites are listed in Settings. */}
        {ev.scope?.startsWith("site:") ? (
          <button type="button" disabled={busy} onClick={() => void decide("always")} title={L("מתי שהוא עובד באתר הזה, בלי לשאול. אפשר לבטל בהגדרות ← דפדפן.", "Whenever it works on this site, without asking. Undo in Settings → Browser.")}>
            {L(`תמיד ב-${ev.scope.slice(5)}`, `Always on ${ev.scope.slice(5)}`)}
          </button>
        ) : (
          <button type="button" disabled={busy} aria-expanded={scopeOpen} onClick={() => setScopeOpen(!scopeOpen)}>{t("allowAlways")} ▾</button>
        )}
        <button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("deny")}</button>
      </div>
      {scopeOpen && (
        <div className="scope-menu" role="menu">
          <label className="small row">
            {L("לכמה זמן", "For how long")}
            <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              <option value={0}>{L("לתמיד", "For good")}</option>
              <option value={60}>{L("שעה", "1 hour")}</option>
              <option value={240}>{L("4 שעות", "4 hours")}</option>
              <option value={Math.max(1, Math.round((new Date().setHours(24, 0, 0, 0) - Date.now()) / 60_000))}>{L("עד סוף היום", "Until the end of today")}</option>
              <option value={7 * 24 * 60}>{L("שבוע", "1 week")}</option>
            </Select>
          </label>
          {firstCmd && (
            <label className="small row ap-only">
              <input type="checkbox" checked={onlyCmd} onChange={(e) => setOnlyCmd(e.target.checked)} />
              {L("רק פקודות שמתחילות ב:", "Only commands that start with:")}
              <input dir="ltr" value={prefix} disabled={!onlyCmd} onChange={(e) => setPrefix(e.target.value)} aria-label={L("תחילת הפקודה", "The command's start")} />
            </label>
          )}
          {!ev.scope && <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "conversation")}>{t("alwaysChat", { tool: ev.name })}</button>}
          {!ev.scope && <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "model")}>{t("alwaysModel", { tool: ev.name })}</button>}
          {!ev.scope && <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "everywhere")}>{t("alwaysEverywhere", { tool: ev.name })}</button>}
          <span className="muted small">{t("alwaysNote")}</span>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({ convId, ev, pending, answer }: { convId: string; ev: Ev<"question">; pending: boolean; answer?: Ev<"answer"> }) {
  const [text, setText] = useState(ev.path ?? "");
  const send = (value: string) => void api(`/api/conversations/${convId}/answers/${ev.questionId}`, { method: "POST", body: { text: value } }).catch(() => undefined);
  if (ev.kind === "access") {
    // The agent asks for a folder or file outside its own: allow it, pick another, or refuse.
    return (
      <div className={`card question access ${pending ? "" : "done"}`}>
        <strong>{t("accessRequest")}</strong>
        <p>{ev.question}</p>
        {pending ? (
          <>
            <input className="mono" dir="ltr" value={text} onChange={(e) => setText(e.target.value)} placeholder="C:\Users\…" aria-label={t("accessPath")} />
            <div className="row">
              <button type="button" className="primary" disabled={!text.trim()} onClick={() => send(text.trim())}>{t("allowAccess")}</button>
              {desktop() && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && send(f))}>{t("chooseFolder")}</button>}
              {desktop()?.pickFiles && <button type="button" onClick={() => void desktop()!.pickFiles!().then((f) => f[0] && send(f[0]))}>{t("chooseFile")}</button>}
              <button type="button" onClick={() => send("")}>{t("refuse")}</button>
            </div>
          </>
        ) : (
          <p className="muted mono" dir="ltr">{answer?.text ? `✓ ${answer.text}` : t("refused")}</p>
        )}
      </div>
    );
  }
  return (
    <div className={`card question ${pending ? "" : "done"}`}>
      <strong>{ev.question}</strong>
      {pending ? (
        <>
          {ev.options && (
            <div className="row">
              {ev.options.map((o) => (
                <button key={o} type="button" onClick={() => send(o)}>{o}</button>
              ))}
            </div>
          )}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send(text.trim()); }}>
            <input className="grow" value={text} onChange={(e) => setText(e.target.value)} aria-label={t("answer")} />
            <button type="submit" className="primary">{t("answer")}</button>
          </form>
        </>
      ) : (
        <p className="muted">{answer?.text}</p>
      )}
    </div>
  );
}
