import { useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { explainCommand } from "@kesher/shared";
import { api, withToken } from "./api";
import { stepLabel } from "./Activity";
import { getLocale, t, he$ } from "./i18n";
import { desktop } from "./library";
import { RichText } from "./RichText";
import { Select } from "./ui/Select";
import { durations } from "./settings/PermissionsSection";
import { McpAppView } from "./McpAppView";
import { helperAskerName } from "./Helpers";

/*
 * The cards a chat shows between messages: a tool the model ran (with its
 * diff), an approval it waits for, and a question it asks. One file, so the
 * chat page, the Blueprint bubble and any other chat view render them the
 * same way.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

/**
 * Colours a unified diff.
 *
 * @param props - `diff` is the text; `onLine` (optional) fires with the line's index and text when a line is clicked.
 */
export function Diff({ diff, onLine, marks, onHunk, hunkLabel }: { diff: string; onLine?: (i: number, line: string) => void; marks?: Record<number, string[]>; onHunk?: (hunk: number) => void; hunkLabel?: string }) {
  let hunks = -1;
  return (
    <pre className={`code diff${onLine ? " clickable" : ""}`} dir="ltr">
      {diff.split("\n").map((l, i) => (
        <span key={i}>
          {/* Per-change undo (as Zed's and Cursor's ↶ on a hunk), on each "@@" line. */}
          {onHunk && l.startsWith("@@") && ((n) => <button type="button" className="ghost small diff-hunk-undo" title={hunkLabel} aria-label={hunkLabel} onClick={() => onHunk(n)}>↶</button>)(++hunks)}
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

/**
 * A tool call in a few words: its path, command, pattern, prompt or question.
 *
 * @param name - The tool's name.
 * @param input - The call's arguments.
 * @returns The short text, or "" when there is none.
 */
export function summary(name: string, input: Record<string, unknown>): string {
  const v = input.path ?? input.command ?? input.pattern ?? input.prompt ?? input.glob ?? input.question;
  return typeof v === "string" ? v : "";
}

/** One tool call in the chat, with its result once it comes (a group member's part shows as that member's answer). */
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
  const card = (
    <details className={`tool ${state}`}>
      <summary>
        <span className="tool-state" aria-hidden>{state === "pending" ? "…" : state === "ok" ? "✓" : "✕"}</span>
        <span className="tool-label" dir="auto">{stepLabel({ call, ...(result ? { result } : {}) })}</span>
      </summary>
      {result?.diff && <Diff diff={result.diff} />}
      {/* Pictures the step made (a browser or screen shot, a render) as small thumbnails: the full-size ones and the
          players show under the whole group (Activity.tsx), so the open step stays short. Tap opens the picture. */}
      {!!result?.assetIds?.length && (
        <div className="step-thumbs">
          {result.assetIds.map((id) => (
            <a key={id} href={withToken(`/api/assets/${id}`)} target="_blank" rel="noreferrer">
              <img src={withToken(`/api/assets/${id}`)} alt={summary(call.name, call.input)} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {result && !result.diff && <pre className="code" dir="ltr">{result.output}</pre>}
    </details>
  );
  // MCP Apps: the tool's own view, open under the step (text it sends goes into the message box).
  if (!result?.app) return card;
  return (
    <>
      {card}
      <McpAppView app={result.app} onMessage={composeText} />
    </>
  );
}

/** Puts text in the chat's message box (a tool's view asked to). */
function composeText(text: string): void {
  window.dispatchEvent(new CustomEvent("kesher:compose", { detail: text }));
}

/** Shows the server's approval reason in the user's language. */
export function reasonText(reason: string): string {
  if (reason === "The agent wants to change a file.") return t("reasonWrite");
  if (reason === "The agent wants to run a command on your computer.") return t("reasonExec");
  const danger = /^This command (.+), so it always needs your approval\.$/.exec(reason);
  if (danger) return t("reasonDanger", { what: danger[1]! });
  // Unity scene changes that are always asked (unity-edit-tools.ts sceneAskReason, unity_create_pbr_material).
  if (reason === "Changes the selected objects in the Unity scene.") return L("שינוי האובייקטים שנבחרו בסצנה של Unity", reason);
  const unity = /^Changes (\d+) objects? in the Unity scene(?:, deleting (\d+))?\.$/.exec(reason);
  if (unity) {
    const n = Number(unity[1]);
    const del = unity[2] ? Number(unity[2]) : 0;
    return L(`שינוי ${n === 1 ? "אובייקט אחד" : `${n} אובייקטים`} בסצנה של Unity${del ? `, כולל מחיקה של ${del === 1 ? "אחד" : del}` : ""}`, reason);
  }
  return reason;
}

/**
 * What a sub-agent asks to do, as the end of its card's header ("…asks to open example.com").
 *
 * @param name - The tool.
 * @param input - Its input.
 */
export function helperAction(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? String(input[k]).slice(0, 80) : "");
  switch (name) {
    case "run_command": return L("להריץ פקודה", "run a command");
    case "run_tests": return L("להריץ את הבדיקות של הפרויקט בעותק שלו", "run the project's tests in its copy");
    case "browser_open": return L(`לפתוח את ${str("url")}`, `open ${str("url")}`);
    case "browser_click": return L("ללחוץ על משהו בדף", "click on a page");
    case "browser_type": return L("להקליד בדף", "type on a page");
    case "computer_use_app": return L(`לראות את המסך ולשלוט ב-${str("app")}`, `see the screen and control ${str("app")}`);
    case "computer_click": return L("ללחוץ על המסך", "click on the screen");
    case "computer_type": return L("להקליד במחשב", "type on the computer");
    case "computer_key": return L("ללחוץ על מקשים", "press keys");
    case "computer_scroll": return L("לגלול במסך", "scroll the screen");
    case "computer_open_app": return L(`לפתוח את ${str("app") || "האפליקציה"}`, `open ${str("app") || "an app"}`);
    case "computer_batch": return L("לבצע כמה פעולות במסך", "do several actions on the screen");
    case "write_file":
    case "edit_file": return L(`לשנות את ${str("path")}`, `change ${str("path")}`);
    default: return L(`להשתמש ב-${name}`, `use ${name}`);
  }
}

/** The agent asks to run a tool: allow once, deny with a note, or always (in this chat, for this model, everywhere). */
export function ApprovalCard({ convId, ev, pending, result }: { convId: string; ev: Ev<"approval_request">; pending: boolean; result?: Ev<"approval_result"> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  // "Always": for how long (0 = for good) and, for a command, only commands that start like this one.
  const [minutes, setMinutes] = useState(0);
  // "Allow" for a while (0 = once).
  const [forTime, setForTime] = useState(0);
  const firstCmd = ev.name === "run_command" && typeof ev.input.command === "string" ? ev.input.command.trim() : "";
  const [onlyCmd, setOnlyCmd] = useState(!!firstCmd);
  const [prefix, setPrefix] = useState(() => firstCmd.split(/\s+/).slice(0, firstCmd.split(/\s+/).length > 2 ? 2 : 3).join(" ").split(/[;&|]/)[0]!.trim());
  const decide = async (decision: "allow" | "always" | "deny", scope?: "conversation" | "model" | "everywhere", forMinutes?: number) => {
    setBusy(true);
    const m = forMinutes ?? minutes;
    const always = decision === "always" ? { ...(m > 0 ? { minutes: m } : {}), ...(firstCmd && onlyCmd && prefix.trim() ? { command: prefix.trim() } : {}) } : {};
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
  // A sub-agent's step: the header names it and its role ("Find prices (research agent) asks to open …").
  const asker = ev.helper ? helperAskerName(ev.helper) : undefined;
  const helperLine = ev.helper && asker ? `${ev.helper.title} (${asker.role}) ${L("מבקש", "asks to")} ${helperAction(ev.name, ev.input)}` : "";
  return (
    <div className={`card approval${ev.helper ? " ap-helper" : ""}`} role="group" aria-label={helperLine || headline} data-guard="">
      {ev.helper && asker && (
        <p className="ap-asker" dir="auto">
          <span aria-hidden="true">{asker.icon}</span> <b>{ev.helper.title}</b> <span className="muted">({asker.role})</span> {L("מבקש", "asks to")} {helperAction(ev.name, ev.input)}
        </p>
      )}
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
        {/* Allow for a while, right here (like sudo's timeout): a rule for this chat that ends by itself. */}
        <button type="button" className="primary" disabled={busy} onClick={() => void (forTime > 0 && !ev.scope ? decide("always", "conversation", forTime) : decide("allow"))}>{forTime > 0 && !ev.scope ? L(`אשר ל${durations().find(([m]) => m === forTime)?.[1] ?? ""}`, `Allow for ${durations().find(([m]) => m === forTime)?.[1].toLowerCase() ?? ""}`) : t("allow")}</button>
        {!ev.scope && !danger && (
          <Select className="model-chip" value={forTime} aria-label={L("לכמה זמן לאשר", "Allow for how long")} onChange={(e) => setForTime(Number(e.target.value))}>
            <option value={0}>{L("פעם אחת", "Once")}</option>
            {durations().filter(([m]) => m > 0 && m <= 24 * 60).map(([m, label]) => <option key={label} value={m}>{label}</option>)}
          </Select>
        )}
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
              <option value={15}>{L("15 דקות", "15 minutes")}</option>
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
          {/* A sub-agent runs on its own model: "for this model" would not mean the chat's, so it is not offered. */}
          {!ev.scope && !ev.helper && <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "model")}>{t("alwaysModel", { tool: ev.name })}</button>}
          {!ev.scope && <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "everywhere")}>{t("alwaysEverywhere", { tool: ev.name })}</button>}
          <span className="muted small">{t("alwaysNote")}</span>
        </div>
      )}
    </div>
  );
}

/** The agent asks the user a question (or for a path): the choices or a text box, then the answer as given. */
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
  if (ev.items?.length) return <QuestionsCard ev={ev} pending={pending} answer={answer} send={send} />;
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

/**
 * A card of up to four questions (ask_user with `questions`): each with a header, options with a line of
 * explanation (the recommended one first), several picks where allowed, and her own answer. One "Send" answers all;
 * "Decide yourself" lets the model choose.
 */
function QuestionsCard({ ev, pending, answer, send }: { ev: Ev<"question">; pending: boolean; answer?: Ev<"answer">; send: (text: string) => void }) {
  const items = ev.items ?? [];
  const [picked, setPicked] = useState<string[][]>(() => items.map(() => []));
  const [other, setOther] = useState<string[]>(() => items.map(() => ""));
  const he = getLocale() === "he";
  const answers = items.map((_, i) => [...picked[i]!, ...(other[i]!.trim() ? [other[i]!.trim()] : [])]);
  const done = answers.filter((a) => a.length).length;
  const toggle = (i: number, label: string, multi?: boolean) =>
    setPicked((p) => p.map((x, j) => (j !== i ? x : multi ? (x.includes(label) ? x.filter((y) => y !== label) : [...x, label]) : [label])));
  if (!pending)
    return (
      <div className="card question done">
        {items.map((q, i) => <p key={i} className="small"><span className="muted">{q.question}</span></p>)}
        <p className="muted" dir="auto">{answer?.text}</p>
      </div>
    );
  return (
    <div className="card question questions" role="group" aria-label={ev.question}>
      <div className="row q-top">
        <strong>{he ? `${items.length} שאלות` : `${items.length} question${items.length > 1 ? "s" : ""}`}</strong>
        <span className="muted small">{he ? `${done} מתוך ${items.length} נענו` : `${done} of ${items.length} answered`}</span>
      </div>
      {items.map((q, i) => (
        <fieldset key={i} className="q-item">
          <legend className="sr-only">{q.question}</legend>
          <div className="row">
            {q.header && <span className="q-chip">{q.header}</span>}
            {q.multiSelect && <span className="muted small">{he ? "אפשר לסמן כמה" : "Pick any"}</span>}
          </div>
          <strong className="q-text" dir="auto">{q.question}</strong>
          {q.options.map((o) => {
            const on = picked[i]!.includes(o.label);
            return (
              <button key={o.label} type="button" role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} className={`q-opt ${on ? "on" : ""}`} onClick={() => toggle(i, o.label, q.multiSelect)}>
                <span className="q-mark" aria-hidden>{q.multiSelect ? (on ? "☑" : "☐") : on ? "◉" : "○"}</span>
                <span className="q-label"><span dir="auto">{o.label}</span>{o.description && <span className="muted small" dir="auto">{o.description}</span>}</span>
              </button>
            );
          })}
          <input value={other[i]} dir="auto" placeholder={he ? "תשובה אחרת…" : "Another answer…"} aria-label={he ? "תשובה אחרת" : "Another answer"} onChange={(e) => setOther((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="primary" disabled={!done} onClick={() => send(items.map((q, i) => `"${q.question}" = "${answers[i]!.join(", ") || (he ? "(בלי תשובה: תחליט אתה)" : "(no answer: decide yourself)")}"`).join("\n"))}>{he ? "שליחה" : "Send"}</button>
        <button type="button" className="ghost" onClick={() => send(he ? "(תחליט אתה, ותגיד מה בחרת)" : "(Decide yourself and say what you chose)")}>{he ? "דלג, תחליט אתה" : "Skip, you decide"}</button>
      </div>
    </div>
  );
}
