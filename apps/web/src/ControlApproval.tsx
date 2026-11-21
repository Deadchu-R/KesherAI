import { useEffect, useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { api, withToken } from "./api";
import { getLocale, he$, t } from "./i18n";
import { helperAskerName } from "./Helpers";
import { allowLabel, GrantPicker, type GrantChoice } from "./GrantChoice";
import "./control-card.css";

/**
 * Approval card v2 for browser and computer actions (safety v2, docs/research/browser-computer-control.md §3.7): who
 * asks (the helper's name), what happens if approved, where (site or app and window), a picture of the target cut
 * from a screenshot, why it is asked, and a countdown — unanswered for 5 minutes counts as denied (the server
 * decides that; the countdown only shows it). Buttons: Allow (this time, or for this chat, 1 hour or until revoked
 * on that site or app, only where the server allows it), Deny, Stop everything. The same card shows on the phone (it is the chat's own thread).
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }> & { seq: number; at: string };

/** What the action does, in the user's language: "click", "type into"… (the card's headline verb). */
function verbText(verb: string): string {
  const v: Record<string, [string, string]> = {
    click: ["ללחוץ על", "click"],
    "click at": ["ללחוץ בנקודה במסך", "click a point on the page"],
    type: ["להקליד ב", "type into"],
    "set value": ["לכתוב ב", "write into"],
    hover: ["לרחף מעל", "hover over"],
    select: ["לבחור ב", "choose in"],
    scroll: ["לגלול", "scroll"],
    "press key": ["ללחוץ על מקשים", "press keys"],
    key: ["ללחוץ על מקשים", "press keys"],
    open: ["לפתוח כתובת", "open an address"],
    navigate: ["לנווט בלשונית", "move in the tab"],
    eval: ["להריץ JavaScript בדף", "run JavaScript on the page"],
    upload: ["להעלות קובץ", "upload a file"],
    dialog: ["לענות לחלון קופץ", "answer a pop-up"],
    "close tab": ["לסגור לשונית", "close a tab"],
    invoke: ["ללחוץ על", "press"],
    toggle: ["להחליף מצב של", "toggle"],
    "use app": ["לשלוט באפליקציה", "control the app"],
    "open app": ["לפתוח אפליקציה", "open an app"],
    batch: ["לבצע כמה פעולות", "do several actions"],
    drag: ["לגרור", "drag"],
  };
  const w = v[verb];
  return w ? L(w[0], w[1]) : L(`לבצע ${verb}`, verb);
}

/** What happens if the user approves, one sentence. */
function effectText(c: NonNullable<Ev<"approval_request">["control"]>, input: Record<string, unknown>): string {
  // Isolated, so an English label or address inside a Hebrew sentence keeps its place.
  const iso = (x: string) => (x ? `\u2068${x}\u2069` : x);
  const where = iso(c.site ?? c.app ?? "");
  const target = iso(c.target ?? "");
  const n = typeof input.text === "string" ? input.text.length : typeof input.value === "string" ? input.value.length : 0;
  switch (c.verb) {
    case "click":
    case "invoke":
      return L(`הוא ילחץ על ${target || "הרכיב"}${where ? ` ב-${where}` : ""}. אם זה כפתור שליחה, שמירה או מחיקה, זה יקרה.`, `It clicks ${target || "the element"}${where ? ` on ${where}` : ""}. If it is a send, save or delete button, that happens.`);
    case "type":
    case "set value":
      return L(`הוא יקליד ${n} תווים ב-${target || "השדה"}${where ? ` (${where})` : ""}.`, `It types ${n} characters into ${target || "the field"}${where ? ` (${where})` : ""}.`);
    case "open":
      return L(`הדף ${String(input.url ?? where)} ייפתח בדפדפן.`, `${String(input.url ?? where)} opens in the browser.`);
    case "eval":
      return L("קוד JavaScript ירוץ בדף ויוכל לקרוא ולשנות את מה שבו.", "JavaScript runs on the page and can read and change what is on it.");
    case "upload":
      return L(`הקובץ ${String(input.path ?? "")} יישלח לאתר ${where}.`, `The file ${String(input.path ?? "")} is sent to ${where}.`);
    default:
      return L(`הפעולה תתבצע${where ? ` ב-${where}` : ""}.`, `The action runs${where ? ` on ${where}` : ""}.`);
  }
}

/** Why the card asks, as short badges. */
function whyBadges(c: NonNullable<Ev<"approval_request">["control"]>): Array<{ text: string; warn?: boolean }> {
  const kind: Record<string, [string, string]> = {
    bank: ["בנק", "bank"], payment: ["תשלומים", "payments"], email: ["דואר", "email"], account: ["הגדרות חשבון", "account settings"],
    government: ["אתר ממשלתי", "government"], user: ["ברשימה הרגישה שלך", "on your sensitive list"],
  };
  return c.why.map((w) => {
    switch (w) {
      case "sensitive": { const k = kind[c.sensitive ?? ""] ?? ["רגיש", "sensitive"]; return { text: L(`אתר רגיש: ${k[0]}. שואלים על כל פעולה`, `Sensitive site: ${k[1]}. Every action is asked`), warn: true }; }
      case "origin": return { text: L("יוצא מהאתרים של המשימה", "Leaves this task's sites"), warn: true };
      case "js": return { text: L("JavaScript: שואלים כל פעם", "JavaScript: asked every time"), warn: true };
      case "always-ask": return { text: L("תמיד שואלים על זה", "Always asked") };
      case "review": return { text: L("הבודק המקומי השאיר לך את ההחלטה", "The local reviewer left it to you") };
      default: return { text: L("מצב ידני: שואלים על כל פעולה", "Manual: every action is asked") };
    }
  });
}

/** The reviewer's reason from the server's sentence ("The local reviewer left it to you: …."), or "". */
function reviewerSaid(reason: string): string {
  return /^The local reviewer left it to you: (.*?)\.?$/.exec(reason)?.[1] ?? "";
}

/** "4:12" left until the card counts as denied. */
function useLeft(until: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The card for one browser or computer action that waits for the user.
 *
 * @param props.convId - The chat.
 * @param props.ev - The request (with its `control` facts).
 * @param props.pending - Whether it still waits.
 * @param props.result - Its answer, once there is one.
 */
export function ControlApproval({ convId, ev, pending, result }: { convId: string; ev: Ev<"approval_request">; pending: boolean; result?: Ev<"approval_result"> }) {
  const c = ev.control!;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // How long "Allow" holds (approval-grants.ts): this time, this chat, 1 hour, or until revoked.
  const [grant, setGrant] = useState<GrantChoice>("once");
  const left = useLeft(c.expiresAt);
  // While the card waits on a screen that is in front, the computer is told so: no phone notification for it then.
  useEffect(() => {
    if (!pending) return;
    const seen = () => !document.hidden && void api("/api/control/seen", { method: "POST", body: { chats: [convId] } }).catch(() => undefined);
    seen();
    const id = setInterval(seen, 5000);
    return () => clearInterval(id);
  }, [pending, convId]);
  const decide = async (decision: "allow" | "deny", choice: GrantChoice = "once") => {
    setBusy(true);
    await api(`/api/conversations/${convId}/approvals/${ev.requestId}`, { method: "POST", body: { decision, ...(decision === "allow" && choice !== "once" ? { grant: choice } : {}), ...(note ? { feedback: note } : {}) } }).catch(() => undefined);
    setBusy(false);
  };
  const stopAll = async () => {
    setBusy(true);
    await Promise.all([api("/api/browser/stop", { method: "POST" }), api("/api/computer/stop", { method: "POST" }), api(`/api/conversations/${convId}/approvals/${ev.requestId}`, { method: "POST", body: { decision: "deny", feedback: "The user pressed Stop everything." } })].map((p) => p.catch(() => undefined)));
    setBusy(false);
  };
  const where = c.kind === "browser" ? c.site : c.app;
  if (!pending) {
    const d = result?.decision;
    return (
      <p className="muted approval-done">
        <span dir="auto">{verbText(c.verb)} {c.target ?? ""}{where ? ` · ${where}` : ""}</span> · {d === "deny" ? t("denied") : d === "expired" ? L("לא נענה ב-5 דקות: נדחה", "No answer in 5 minutes: denied") : t("allowed")}
      </p>
    );
  }
  const asker = ev.helper ? helperAskerName(ev.helper) : undefined;
  const warn = c.why.some((w) => w === "sensitive" || w === "origin" || w === "js");
  const canAlways = !ev.noAlways && !!where;
  return (
    <div className={`card approval cc-card${warn ? " cc-warn" : ""}${ev.helper ? " ap-helper" : ""}`} role="group" aria-label={`${ev.helper?.title ?? "KesherAI"}: ${verbText(c.verb)} ${c.target ?? ""}`} data-guard="">
      <p className="ap-asker" dir="auto">
        <span aria-hidden="true">{asker?.icon ?? (c.kind === "browser" ? "🌐" : "🖥")}</span>{" "}
        <b>{ev.helper?.title ?? "KesherAI"}</b>{asker && <span className="muted"> ({asker.role})</span>} {L("רוצה", "wants to")}:
      </p>
      <strong className="cc-title" dir="auto">
        {verbText(c.verb)} {c.target && <bdi className="cc-target">{c.target}</bdi>}
      </strong>
      <div className="cc-body">
        {c.crop && <img className="cc-crop" src={withToken(`/api/assets/${c.crop}`)} alt={L("תמונה של הרכיב", "Picture of the element")} />}
        <div className="cc-facts">
          <p className="cc-where" dir="auto">
            <span className="muted small">{c.kind === "browser" ? L("אתר", "Site") : L("אפליקציה", "App")}</span> <bdi dir="ltr">{where ?? L("לא ידוע", "unknown")}</bdi>
          </p>
          {c.window && <p className="muted small cc-window" dir="auto"><span>{L("חלון", "Window")}</span> <bdi>{c.window}</bdi></p>}
          <div className="ap-why">
            <span className="muted small">{L("מה יקרה אם תאשר", "What happens if you approve")}</span>
            <p dir="auto">{effectText(c, ev.input)}</p>
          </div>
        </div>
      </div>
      {ev.purpose && (
        <div className="ap-why">
          <span className="muted small">{t("apWhy")}</span>
          <p dir="auto">{ev.purpose}</p>
        </div>
      )}
      <ul className="cc-badges">
        {whyBadges(c).map((b, i) => <li key={i} className={b.warn ? "warn" : ""} dir="auto">{b.warn ? "⚠ " : ""}{b.text}</li>)}
      </ul>
      {/* The reviewer's own words (a model's text, in whatever language it answered). */}
      {c.why.includes("review") && reviewerSaid(ev.reason) && <p className="muted small" dir="auto">{L("הבודק:", "Reviewer:")} <bdi>{reviewerSaid(ev.reason)}</bdi></p>}
      <input placeholder={t("noteForAgent")} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("noteForAgent")} />
      <div className="cc-buttons">
        <button type="button" className="primary" disabled={busy} onClick={() => void decide("allow", canAlways ? grant : "once")}>{canAlways ? allowLabel(grant) : L("אשר פעם אחת", "Allow once")}</button>
        {/* Only there (this site or app): this time, this chat, 1 hour, or until revoked in Settings › Approvals. */}
        {canAlways && <GrantPicker value={grant} onChange={setGrant} helper={!!ev.helper} where={c.kind === "browser" ? L(`ב-${where}`, `on ${where}`) : L(`ב-${where}`, `in ${where}`)} />}
        <button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("deny")}</button>
        <button type="button" className="danger-btn" disabled={busy} onClick={() => void stopAll()}>■ {L("עצור הכול", "Stop everything")}</button>
      </div>
      <p className="muted small cc-left" aria-live="off">{L(`בלי תשובה תוך ${left} — נחשב כדחייה`, `No answer in ${left} counts as denied`)}</p>
    </div>
  );
}
