import { useEffect, useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { explainCommand, parseScenePreview } from "@kesher/shared";
import { api } from "./api";
import { callDuration, errorLine, formatDuration, maskSecrets, paramSummary, pastChatHits, pastChatTitle, prettyOutput, searchHits, toolInfo, toolLabel, travelTable } from "./chat/tool-cards";
import { FileChips } from "./MediaView";
import { ShotThumb } from "./chat/ShotView";
import { stepPreview, type ActedOn } from "./chat/step-fold";
import { mediaKindOf } from "./chat/chat-inline";
import { dangerWhat, reviewHeldText, splitReview } from "./chat/gate-text";
import { getLocale, t, he$ } from "./i18n";
import { desktop, toast } from "./library";
import { RichText } from "./RichText";
import { Select } from "./ui/Select";
import { allowLabel, GrantPicker, grantWhere, type GrantChoice } from "./GrantChoice";
import { McpAppView } from "./McpAppView";
import { helperAskerName } from "./Helpers";
import { SceneDiffCard } from "./SceneDiffCard";
import { ScheduleConfirmCard } from "./chat/ScheduleConfirmCard";
import { parseSchedulePreview } from "./schedule-confirm";

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
export function ToolCard({ call, result, convId, pinned, acted }: { call: Ev<"tool_call">; result?: Ev<"tool_result">; /** With it, the result can be pinned. */ convId?: string; pinned?: boolean; /** The screenshot this step acted on, with its click, typing or scroll to draw on it. */ acted?: ActedOn }) {
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
  const he = getLocale() === "he";
  const info = toolInfo(call.name);
  const param = paramSummary(call.input);
  const hits = call.name === "web_search" && result?.ok ? searchHits(result.output) : [];
  // Past chats: "Searched past chats: 'X' · 3 results", with a link to each chat found.
  const past = /^(search_chats|recent_chats)$/.test(call.name) && result?.ok ? pastChatHits(result.output) : [];
  const pastTitle = pastChatTitle(call.name, call.input, result ? (result.ok ? past.length : 0) : undefined, he);
  // Travel: a compact table (airline, times, stops, price in shekels) instead of the raw text.
  const trip = /^travel_search_(flights|stays)$/.test(call.name) && result?.ok ? travelTable(result.output) : undefined;
  const out = result && !result.diff && !hits.length && !past.length && !trip ? prettyOutput(result.output) : "";
  const preview = maskSecrets(stepPreview(call.name, result));
  const card = (
    <details className={`tool tool-card ${state}`}>
      <summary>
        <span className="tool-icon" aria-hidden>{info.icon}</span>
        <span className="tool-label" dir="auto">{pastTitle ?? toolLabel(call.name, he)}</span>
        {/* Names and parameters are code, a query or a path: isolated so Hebrew text does not reorder them. */}
        {param && !pastTitle && <bdi className="tool-param" dir="ltr">{param}</bdi>}
        <span className="tool-state" aria-label={state === "pending" ? L("רץ", "Running") : state === "ok" ? L("הסתיים", "Done") : L("נכשל", "Failed")}>
          {state === "pending" ? <span className="spinner" aria-hidden /> : <span aria-hidden>{state === "ok" ? "✓" : "✕"}</span>}
          <ToolClock call={call} result={result} />
        </span>
        {pinned && <span className="tool-pinned" title={L("נעוץ: המודל מקבל את התוצאה במלואה", "Pinned: the model gets this result in full")}>📌</span>}
        {result && !result.ok && <span className="tool-err" dir="auto">{errorLine(result.output)}</span>}
        {/* What the step ended on (page title · domain, window, command's last line, +N −M), as Claude's step rows. */}
        {preview && <bdi className="tool-preview" dir="auto">{preview}</bdi>}
      </summary>
      {result && convId && <PinResult convId={convId} callId={call.callId} pinned={!!pinned} />}
      {result?.diff && <Diff diff={result.diff} />}
      {/* Search hits: a list of titles that open the page. */}
      {hits.length > 0 && (
        <ol className="tool-hits">
          {hits.map((h) => (
            <li key={h.url}>
              <a href={h.url} target="_blank" rel="noreferrer noopener" dir="auto">{h.title}</a>
              <bdi className="muted small" dir="ltr">{hostOf(h.url)}</bdi>
            </li>
          ))}
        </ol>
      )}
      {past.length > 0 && (
        <ol className="tool-hits">
          {past.map((h) => (
            <li key={h.id}>
              <a href={`#/c/${h.id}`} dir="auto">{h.title}</a>
              {h.day && <bdi className="muted small" dir="ltr">{h.day}</bdi>}
            </li>
          ))}
        </ol>
      )}
      {trip && (
        <div className="travel-card">
          <p className="travel-card-head small" dir="auto">{trip.head}</p>
          <div className="travel-scroll">
            <table className="travel-table">
              <thead><tr>{trip.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{trip.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} dir="auto">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {trip.foot.map((f, i) => <p key={i} className="travel-foot muted small" dir="auto">{f}</p>)}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" onClick={() => composeText(L("תעקוב אחרי המחיר של האפשרות הראשונה ותתריע לי בטלפון כשהוא יורד", "Watch the price of the first option and alert my phone when it drops"))}>{L("עקוב אחרי המחיר", "Watch this price")}</button>
          </div>
        </div>
      )}
      {/* Files the step made: chips (download, Drive, editor). */}
      {!!result?.files?.length && convId && (
        <div className="tool-files">
          {result.files.map((f) => <FileChips key={f} file={{ convId, path: f }} name={f.split("/").pop() ?? f} kind={mediaKindOf(null, f)} convId={convId} />)}
        </div>
      )}
      {/* Anything else: the result as formatted JSON or text; long ones fold. */}
      {out && (out.length > 600 ? (
        <details className="tool-raw">
          <summary className="muted small">{L("התוצאה המלאה", "Full result")} · <bdi dir="ltr">{out.length}</bdi></summary>
          <pre className="code" dir="ltr">{out}</pre>
        </details>
      ) : <pre className="code" dir="ltr">{out}</pre>)}
    </details>
  );
  // Pictures the step made (a browser or screen shot, a render) as small thumbnails under the card, so they show
  // while the fold is open without opening each step; tap opens the picture large. A step that clicked, typed or
  // scrolled shows the screenshot it acted on with the action drawn on it.
  const own = result?.assetIds ?? [];
  const thumbs = own.length || acted ? (
    <div className="step-thumbs">
      {own.map((id) => <ShotThumb key={id} id={id} alt={summary(call.name, call.input) || toolLabel(call.name, he)} />)}
      {!own.length && acted && <ShotThumb id={acted.assetId} acted={acted} alt={`${toolLabel(call.name, he)} ${summary(call.name, call.input)}`.trim()} />}
    </div>
  ) : null;
  // MCP Apps: the tool's own view, open under the step (text it sends goes into the message box).
  return (
    <>
      {card}
      {thumbs}
      {result?.app && <McpAppView app={result.app} onMessage={composeText} />}
    </>
  );
}

/** The host of a link ("docs.unity3d.com"), or the text itself when it is not a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The time on a tool card: counts up every second while the call runs, then shows how long it took. Its own clock,
 * so the chat around it does not render again for the time alone.
 */
export function ToolClock({ call, result }: { call: Ev<"tool_call">; result?: Ev<"tool_result"> | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (result) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [result]);
  const ms = callDuration(call, result, now);
  return ms === undefined ? null : <bdi className="tool-time muted small" dir="ltr">{formatDuration(ms)}</bdi>;
}

/**
 * Pins a tool result: the token budget sends results from before the last two turns as one summary line; a pinned
 * one always goes to the model in full. Works the same from the phone (it is a server call).
 */
function PinResult({ convId, callId, pinned }: { convId: string; callId: string; pinned: boolean }) {
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    setBusy(true);
    void api(`/api/conversations/${encodeURIComponent(convId)}/pin-output`, { method: "POST", body: { callId, pinned: !pinned } })
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" className={`ghost small tool-pin${pinned ? " on" : ""}`} disabled={busy} onClick={toggle} aria-pressed={pinned}
      title={L("תוצאות ישנות נשלחות למודל כשורת סיכום כדי לחסוך טוקנים. תוצאה נעוצה נשלחת תמיד במלואה.", "Older results go to the model as a summary line to save tokens. A pinned result is always sent in full.")}>
      📌 {pinned ? L("נעוץ למודל", "Pinned for the model") : L("נעיצה למודל", "Pin for the model")}
    </button>
  );
}

/** Puts text in the chat's message box (a tool's view asked to). */
function composeText(text: string): void {
  window.dispatchEvent(new CustomEvent("kesher:compose", { detail: text }));
}

/** Shows the server's approval reason in the user's language. */
export function reasonText(reason: string): string {
  // The command reviewer's "left it to you" note (agent/session.ts) is added after the reason: both in the user's words.
  const { base, review } = splitReview(reason);
  if (review) return `${reasonText(base)} ${reviewHeldText(review, L)}`;
  if (reason === "The agent wants to change a file.") return t("reasonWrite");
  if (reason === "The agent wants to run a command on your computer.") return t("reasonExec");
  const danger = /^This command (.+), so it always needs your approval\.$/.exec(reason);
  if (danger) return t("reasonDanger", { what: dangerWhat(danger[1]!, L) });
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
    case "schedule_task": return L(`לתזמן "${str("name")}"`, `schedule "${str("name")}"`);
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
  // How long "Allow" holds: this time, this chat, 1 hour, or until revoked (approval-grants.ts on the server).
  const [grant, setGrant] = useState<GrantChoice>("once");
  const firstCmd = ev.name === "run_command" && typeof ev.input.command === "string" ? ev.input.command.trim() : "";
  const [onlyCmd, setOnlyCmd] = useState(!!firstCmd);
  const [prefix, setPrefix] = useState(() => firstCmd.split(/\s+/).slice(0, firstCmd.split(/\s+/).length > 2 ? 2 : 3).join(" ").split(/[;&|]/)[0]!.trim());
  const decide = async (decision: "allow" | "always" | "deny", scope?: "conversation" | "model" | "everywhere", choice?: GrantChoice) => {
    setBusy(true);
    const onlyThis = firstCmd && onlyCmd && prefix.trim() ? { command: prefix.trim() } : {};
    const always = decision === "always" ? { ...(minutes > 0 ? { minutes } : {}), ...onlyThis } : {};
    const granted = decision === "allow" && choice && choice !== "once" ? { grant: choice, ...onlyThis } : {};
    await api(`/api/conversations/${convId}/approvals/${ev.requestId}`, { method: "POST", body: { decision, ...(scope ? { scope } : {}), ...always, ...granted, ...(note ? { feedback: note } : {}) } }).catch(() => undefined);
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
  // A scheduled task the model wants to save: its own card (name, schedule, next run, instructions; Save / Edit / Cancel).
  if (ev.name === "schedule_task" && parseSchedulePreview(ev.preview)) return <ScheduleConfirmCard convId={convId} requestId={ev.requestId} preview={ev.preview} />;
  const cmd = ev.name === "run_command" && typeof ev.input.command === "string" ? ev.input.command : ev.name === "install_tool" ? ev.preview.split("\n").pop() : undefined;
  const parts = cmd ? explainCommand(cmd) : [];
  const he = getLocale() === "he";
  const path = typeof ev.input.path === "string" ? ev.input.path : "";
  // A Unity, Unreal or Godot scene change: the objects and old → new values, instead of the raw preview.
  const scene = parseScenePreview(ev.preview);
  const headline =
    scene ? L("לשנות את הסצנה", "Change the scene")
    : ev.name === "run_command" ? t("apRun")
    : ev.name === "install_tool" ? t("apInstall", { what: String(ev.input.name ?? "") })
    : ev.name === "build_executable" ? t("apBuild", { what: String(ev.input.entry ?? "") })
    : ev.name === "download_file" ? t("apDownload")
    : ev.name === "computer_use_app" ? t("apComputer", { what: String(ev.input.app ?? "") })
    : ev.name === "write_file" || ev.name === "edit_file" ? t("apWrite", { what: path })
    : reasonText(ev.reason);
  const danger = /^This command .+, so it always needs your approval\.$/.test(ev.reason);
  // Grants are offered where the server may keep one (never for an always-ask step); where it holds, in words.
  const canGrant = !danger && !ev.noAlways;
  const where = grantWhere(ev.name, ev.input, ev.scope);
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
      {scene ? <SceneDiffCard diff={scene.diff} /> : ev.name === "run_command" ? <pre className="code" dir="ltr">{ev.preview}</pre> : ev.preview.startsWith("---") || ev.preview.includes("@@") ? <Diff diff={ev.preview} /> : <pre className="code" dir="ltr">{ev.preview}</pre>}
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
        {/* Allow, and for how long: this time, this chat, 1 hour, or until revoked in Settings › Approvals. */}
        <button type="button" className="primary" disabled={busy} onClick={() => void decide("allow", undefined, canGrant ? grant : "once")}>{allowLabel(canGrant ? grant : "once")}</button>
        {canGrant && <GrantPicker value={grant} onChange={setGrant} helper={!!ev.helper} {...(where ? { where } : {})} />}
        {/* More choices (for this model, everywhere, other times) for tools without a narrower place. */}
        {!ev.scope && !danger && <button type="button" disabled={busy} aria-expanded={scopeOpen} onClick={() => setScopeOpen(!scopeOpen)}>{L("עוד", "More")} ▾</button>}
        <button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("deny")}</button>
      </div>
      {canGrant && grant !== "once" && where && <p className="muted small grant-where" dir="auto">{L(`רק ${where}`, `Only ${where}`)}{grant === "revoke" ? L(" · אפשר לבטל בהגדרות › אישורים", " · Revoke in Settings › Approvals") : ""}</p>}
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
  if (ev.kind === "signin" && ev.signIn) return <SignInCard info={ev.signIn} pending={pending} answer={answer} send={send} />;
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
 * "Sign in needed" (browser-signin.ts): a browser step reached a sign-in, code or robot check. The user does it in the
 * named browser on the PC (KesherAI never types passwords or codes), then presses Continue here, on the PC or the phone.
 * The card also closes by itself when the page moves on.
 */
export function SignInCard({ info, pending, answer, send }: { info: NonNullable<Ev<"question">["signIn"]>; pending: boolean; answer?: Ev<"answer"> | undefined; send: (text: string) => void }) {
  const where = info.browser === "pane" ? L("בדפדפן של KesherAI", "in KesherAI's browser") : L("ב-Chrome שלך", "in your Chrome");
  const title = info.wall === "captcha" ? L("צריך לאשר שאתה לא רובוט", "Check that you're human") : info.wall === "code" ? L("צריך קוד אימות", "Verification code needed") : L("צריך להתחבר", "Sign in needed");
  const what = info.wall === "captcha" ? L("עשה את הבדיקה", "Do the check") : info.wall === "code" ? L("הזן את הקוד", "Enter the code") : L("התחבר", "Sign in");
  const done = answer?.text ?? "";
  const result = done.startsWith("continue")
    ? done === "continue:auto" ? L("✓ ההתחברות הסתיימה, ממשיך", "✓ Signed in, continuing") : L("✓ ממשיך", "✓ Continued")
    : done === "(timed out)" ? L("הזמן עבר, העבודה נעצרה", "Timed out; the work stopped") : L("בוטל", "Canceled");
  return (
    <div className={`card question signin ${pending ? "" : "done"}`} role="group" aria-label={title} data-guard="">
      <div className="row signin-top">
        <span className="signin-icon" aria-hidden="true">{info.wall === "captcha" ? "🤖" : "🔒"}</span>
        <strong className="grow">{title}</strong>
        <span className="q-chip" dir="ltr">{info.site}</span>
      </div>
      {pending ? (
        <>
          <p dir="auto">
            {what} {L("ב-", "on ")}<b dir="ltr">{info.site}</b> {where} {L("במחשב, ואז לחץ המשך.", "on the PC, then press Continue.")}
          </p>
          <p className="muted small">{L("KesherAI לא מקליד סיסמאות או קודים. ממשיך לבד כשהדף עובר הלאה.", "KesherAI never types passwords or codes. It goes on by itself when the page moves on.")}</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => send("continue")}>{L("המשך", "Continue")}</button>
            <button type="button" onClick={() => send("cancel")}>{L("ביטול", "Cancel")}</button>
          </div>
        </>
      ) : (
        <p className="muted small">{result}</p>
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
