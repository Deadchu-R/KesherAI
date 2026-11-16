import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { BarPopover } from "../ui/BarPopover";
import { groupNotes } from "../note-groups";
import { noteTitle } from "../note-text";
import { ComputerScreen } from "./WatchPage";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Something an agent waits for the user to approve (a chat, or the self-work run). */
export interface InboxApproval { kind: "chat" | "self-work"; conversationId: string; title: string; requestId: string; tool: string; preview: string; reason: string; purpose?: string; at: string }
/** A notification that went out (to the phone and/or this computer). */
export interface InboxNote { title: string; body: string; path?: string; at: number; channels: string[]; resolved?: string }

/** How a "waiting" note ended, in the user's words. */
const resolvedLabel = (how: string): string =>
  ({ approved: L("אושר", "Approved"), denied: L("נדחה", "Denied"), answered: L("נענה", "Answered"), expired: L("פג תוקף", "Expired"), stopped: L("נעצר", "Stopped"), finished: L("הסתיים", "Finished"), "ended with an error": L("נגמר בשגיאה", "Ended with an error") })[how] ?? how;
interface Inbox { approvals: InboxApproval[]; notes: InboxNote[] }

const SEEN_KEY = "kesher-inbox-seen";
const seenAt = (): number => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};
/** Fired when the notifications page marks everything read, so the bell updates at once. */
const SEEN_EVENT = "kesher:inbox-seen";

/** @returns The inbox, polled (and refreshed after an answer). */
export function useInbox(every = 5000): [Inbox, () => void] {
  const [box, setBox] = useState<Inbox>({ approvals: [], notes: [] });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => !document.hidden && api<Inbox>("/api/inbox").then((b) => alive && setBox(b), () => undefined);
    void tick();
    const id = setInterval(tick, every);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [every, n]);
  return [box, () => setN((x) => x + 1)];
}

/** Marks everything up to `at` as seen (the bell's mark goes away). */
function markSeen(at: number): void {
  if (at <= seenAt()) return;
  try {
    localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    /* private window: the bell keeps its mark */
  }
  dispatchEvent(new Event(SEEN_EVENT));
}

/** Answers an approval from the inbox (the panel and the page). */
async function answerApproval(p: InboxApproval, decision: "allow" | "deny"): Promise<void> {
  try {
    await api("/api/inbox/answer", { method: "POST", body: { kind: p.kind, conversationId: p.conversationId, requestId: p.requestId, decision } });
    toast(decision === "allow" ? L("אושר", "Allowed") : L("נדחה", "Denied"));
  } catch (e) {
    toast((e as Error).message);
  }
}

/**
 * The top bar's 🔔. It opens a small panel under it, like notification centers in GitHub, Linear and Slack
 * (docs/RESEARCH_LOG.md, 2026-11-13): what waits for approval first, answered in place; then the latest
 * notifications; "mark all read"; a link to the full page and to the settings. The mark on the bell counts only
 * what needs you (approvals); other news shows as a dot, and opening the panel clears it.
 */
export function InboxBell() {
  const [box, refresh] = useInbox(6000);
  const [seen, setSeen] = useState(seenAt);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    const on = () => setSeen(seenAt());
    addEventListener(SEEN_EVENT, on);
    return () => removeEventListener(SEEN_EVENT, on);
  }, []);
  // A "waiting" note that was answered (here, on the phone, or by Stop) is no longer new.
  const unread = box.notes.filter((x) => x.at > seen && !x.resolved).length;
  const waiting = box.approvals.length;
  const label = waiting ? L(`התראות: ${waiting} מחכים לאישור`, `Notifications: ${waiting} waiting for approval`) : unread ? L(`התראות: ${unread} חדשות`, `Notifications: ${unread} new`) : L("התראות", "Notifications");
  const newest = box.notes[0]?.at ?? 0;
  const answer = async (p: InboxApproval, decision: "allow" | "deny") => {
    setBusy(p.requestId);
    await answerApproval(p, decision);
    setBusy("");
    refresh();
  };
  // Notes in a row from the same place are one line with a count ("Download done (3)").
  const notes = groupNotes(box.notes).slice(0, 8);
  return (
    <BarPopover
      className={`inbox-bell${waiting ? " urgent" : ""}`}
      label={label}
      title={L("התראות", "Notifications")}
      icon={<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 12.5V8a4 4 0 0 1 8 0v4.5l1.5 1.5h-11zM7.5 15.5a1.6 1.6 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" fill="none" /></svg>}
      badge={waiting > 0 ? <span className="inbox-count">{waiting > 9 ? "9+" : waiting}</span> : unread > 0 ? <span className="inbox-dot" /> : null}
      // What the panel shows now has been seen: the dot goes, the highlight stays until the panel closes.
      onOpen={() => window.setTimeout(() => markSeen(newest), 1500)}
    >
      {(close) => (
        <>
          <div className="row inbox-pop-head">
            <strong className="grow">{L("התראות", "Notifications")}</strong>
            <a className="icon-btn" href="#/settings/notifications" aria-label={L("הגדרות התראות", "Notification settings")} title={L("הגדרות התראות", "Notification settings")} onClick={close}>⚙</a>
          </div>
          {waiting > 0 && (
            <div className="stack inbox-pop-wait">
              {box.approvals.slice(0, 4).map((p) => (
                <div key={p.requestId} className="inbox-pop-approval">
                  <div className="row">
                    <span aria-hidden="true">{p.kind === "self-work" ? "🤖" : "💬"}</span>
                    <a className="grow inbox-pop-title" href={p.kind === "chat" ? `#/c/${p.conversationId}` : "#/self-work"} dir="auto" onClick={close}>{p.title || (p.kind === "self-work" ? L("עבודה עצמית", "Self-work") : L("שיחה", "Chat"))}</a>
                    <span className="muted small">{time(p.at)}</span>
                  </div>
                  <div className="small" dir="auto"><code dir="ltr">{p.tool}</code> {p.purpose || p.reason}</div>
                  <details>
                    <summary className="muted small">{L("מה בדיוק", "Details")}</summary>
                    <pre className="ctx-text" dir="ltr">{p.preview}</pre>
                  </details>
                  <div className="row">
                    <button type="button" className="primary small" disabled={busy === p.requestId} onClick={() => void answer(p, "allow")}>{L("אשר", "Allow")}</button>
                    <button type="button" className="small" disabled={busy === p.requestId} onClick={() => void answer(p, "deny")}>{L("דחה", "Deny")}</button>
                  </div>
                </div>
              ))}
              {waiting > 4 && <a className="muted small" href="#/inbox" onClick={close}>{L(`ועוד ${waiting - 4} מחכים`, `and ${waiting - 4} more waiting`)}</a>}
            </div>
          )}
          {notes.length === 0 && waiting === 0 ? (
            <p className="muted inbox-pop-empty">{L("אין התראות. הן מגיעות כשעבודה ארוכה נגמרת, כשהורדה מסתיימת או כשסוכן מחכה לך.", "Nothing here. Notifications arrive when long work ends, a download finishes, or an agent waits for you.")}</p>
          ) : (
            <ul className="inbox-pop-notes">
              {notes.map((n) => {
                const inner = (
                  <>
                    <span className="row">
                      <strong className="grow" dir="auto">{noteTitle(n.title, getLocale())}{n.count > 1 && <span className="muted"> ({n.count})</span>}</strong>
                      <span className="muted small">{time(n.at)}</span>
                    </span>
                    {n.resolved ? <span className="inbox-resolved small">✓ {resolvedLabel(n.resolved)}</span> : n.body && <span className="muted small inbox-pop-body" dir="auto">{n.body}</span>}
                  </>
                );
                const cls = n.resolved ? "resolved" : n.at > seen ? "new" : "";
                return (
                  <li key={`${n.at}-${n.title}`} className={cls}>
                    {n.path?.startsWith("#/") ? <a href={n.path} onClick={close}>{inner}</a> : <div>{inner}</div>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="row inbox-pop-foot">
            <a href="#/inbox" onClick={close}>{L("לתיבת הדואר", "Open the inbox")}</a>
            <span className="grow" />
            {unread > 0 && <button type="button" className="link-btn" onClick={() => markSeen(newest)}>{L("סמן הכל כנקרא", "Mark all read")}</button>}
          </div>
        </>
      )}
    </BarPopover>
  );
}

const time = (at: number | string) => {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(getLocale() === "he" ? "he-IL" : undefined, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** The inbox's tabs: what waits for you, the notifications, the computer's screen (once "Watch and approve"). */
export type InboxTab = "waiting" | "notes" | "screen";

/**
 * The inbox: everything that waits for your approval (chats and self-work), answered right here with Allow / Deny,
 * the latest notifications KesherAI sent, and the computer's screen while the agent uses it. One page for what
 * used to be two ("Notifications" and "Watch and approve"; redesign 2026-11). From the phone too.
 *
 * @param p.tab - The tab to open (#/watch opens the screen).
 */
export function InboxPage({ tab: first }: { tab?: InboxTab }) {
  const [box, refresh] = useInbox(3000);
  const [tab, setTab] = useState<InboxTab>(first ?? "waiting");
  useEffect(() => {
    setTab(first ?? "waiting");
  }, [first]);
  const [busy, setBusy] = useState("");
  const [seen, setSeen] = useState(seenAt);
  const newestNote = box.notes[0]?.at ?? 0;
  // Opening the page reads everything that is there.
  useEffect(() => {
    if (newestNote > seenAt()) {
      try {
        localStorage.setItem(SEEN_KEY, String(newestNote));
      } catch {
        /* private window: the bell keeps counting */
      }
      dispatchEvent(new Event(SEEN_EVENT));
    }
  }, [newestNote]);
  // "Mark all read": the notes highlighted as new on this page stop being highlighted (board task t15).
  const markAllRead = () => {
    try {
      localStorage.setItem(SEEN_KEY, String(newestNote));
    } catch {
      /* private window: the bell keeps counting */
    }
    setSeen(newestNote);
    dispatchEvent(new Event(SEEN_EVENT));
  };
  const answer = async (p: InboxApproval, decision: "allow" | "deny") => {
    setBusy(p.requestId);
    await answerApproval(p, decision);
    setBusy("");
    refresh();
  };
  return (
    <div className="page inbox">
      <div className="page-head">
        <h1>{L("תיבת דואר", "Inbox")}</h1>
        <p className="muted">{L("מה שמחכה לאישור שלך מכל שיחה ומהעבודה העצמית, ההתראות האחרונות, והמסך של המחשב כשסוכן משתמש בו.", "What waits for your approval from every chat and self-work, the latest notifications, and the computer's screen while an agent uses it.")}</p>
      </div>
      <nav className="tabs" role="tablist" aria-label={L("תיבת דואר", "Inbox")}>
        {([["waiting", L("מחכה לך", "Waiting for you"), box.approvals.length], ["notes", L("הודעות", "Notifications"), 0], ["screen", L("מסך המחשב", "The computer's screen"), 0]] as const).map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}{n > 0 && <span className="tab-count">{n}</span>}
          </button>
        ))}
      </nav>
      {tab === "waiting" && (
      <section className="stack">
        {box.approvals.length === 0 && <p className="muted">{L("אין מה לאשר כרגע. כשסוכן יחכה לך, זה יופיע כאן ובפעמון.", "Nothing to approve now. When an agent waits for you, it shows here and on the bell.")}</p>}
        {box.approvals.map((p) => (
          <article key={p.requestId} className="card inbox-approval">
            <div className="row wrap">
              <span className="inbox-src"><span className="waiting-dot" aria-hidden="true" />{p.kind === "self-work" ? L("עבודה עצמית", "Self-work") : L("שיחה", "Chat")}</span>
              {p.kind === "chat" ? <a href={`#/c/${p.conversationId}`} dir="auto"><strong>{p.title || L("שיחה", "Chat")}</strong></a> : <a href="#/self-work" dir="auto"><strong>{L("עבודה עצמית", "Self-work")}</strong></a>}
              <span className="grow" />
              <span className="muted small">{time(p.at)}</span>
            </div>
            <div className="row wrap"><code dir="ltr">{p.tool}</code>{p.purpose && <span dir="auto">{p.purpose}</span>}</div>
            {p.reason && <p className="muted small" dir="auto">{p.reason}</p>}
            <pre className="ctx-text inbox-preview" dir="ltr">{p.preview}</pre>
            <div className="row inbox-actions">
              <button type="button" className="primary" disabled={busy === p.requestId} onClick={() => void answer(p, "allow")}>{L("אישור", "Allow")}</button>
              <button type="button" disabled={busy === p.requestId} onClick={() => void answer(p, "deny")}>{L("דחייה", "Deny")}</button>
              <span className="grow" />
              <a className="small" href={p.kind === "chat" ? `#/c/${p.conversationId}` : "#/self-work"}>{p.kind === "chat" ? L("פתח את הצ׳אט", "Open the chat") : L("לעבודה העצמית", "Open self-work")}</a>
            </div>
          </article>
        ))}
      </section>
      )}
      {tab === "notes" && (
      <section className="stack">
        <div className="row">
          <span className="grow" />
          {newestNote > seen && (
            <button type="button" className="link-btn" onClick={markAllRead}>
              {L("סמן הכל כנקרא", "Mark all read")}
            </button>
          )}
        </div>
        {box.notes.length === 0 && <p className="muted">{L("עוד לא נשלחו התראות. הן מגיעות כשעבודה ארוכה נגמרת, כשהורדה מסתיימת או כשסוכן מחכה לך.", "No notifications yet. They come when long work ends, a download finishes, or an agent waits for you.")}</p>}
        <ul className="inbox-notes">
          {box.notes.map((n) => (
            <li key={`${n.at}-${n.title}`} className={n.resolved ? "resolved" : n.at > seen ? "new" : ""}>
              {n.path?.startsWith("#/") ? <a href={n.path} dir="auto"><strong>{noteTitle(n.title, getLocale())}</strong></a> : <strong dir="auto">{noteTitle(n.title, getLocale())}</strong>}
              <span className="muted small">{time(n.at)}</span>
              {n.resolved && <span className="inbox-resolved small">✓ {resolvedLabel(n.resolved)}</span>}
              {n.body && <p dir="auto">{n.body}</p>}
            </li>
          ))}
        </ul>
        <p className="muted small"><a href="#/settings/notifications">{L("הגדרות התראות (טלפון ומחשב)", "Notification settings (phone and computer)")}</a></p>
      </section>
      )}
      {tab === "screen" && <ComputerScreen />}
    </div>
  );
}
