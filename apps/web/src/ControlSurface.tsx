import { useState } from "react";
import { api } from "./api";
import { closePanel, openSurface } from "./ArtifactPanel";
import { ControlLive } from "./ControlLive";
import { controlAskMessage } from "./control-surface";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";

/** The computer-control surface (design ChatControlSurface): a card in the message, and the live view in the panel. */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * The card in the message: "Computer control", one line, Open.
 *
 * @param props - `item`: the control item.
 */
export function ControlCard({ item, live }: SurfaceCardProps) {
  return (
    <button type="button" className="item-card control-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${L("שליטה במחשב", "Computer control")}`}>
      <span className="item-card-text">
        <strong>🖥 {L("שליטה במחשב", "Computer control")}</strong>
        <small className="muted">{live ? L("הסוכן עובד במחשב עכשיו: צפייה חיה ועצירה", "The agent is working on the computer: live view and Stop") : L("הצעדים והמסך של הסוכן", "The agent's steps and screen")}</small>
      </span>
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * The panel: the live view with its steps list and Stop (`ControlLive`), and "Ask about this" under it, which sends
 * the question to the chat (on the phone this is all there is besides Stop: view + ask).
 *
 * @param props - `item`: the control item (its chat is `convId`).
 */
export function ControlPanel({ item }: SurfacePanelProps) {
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!ask.trim() || !item.convId) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${encodeURIComponent(item.convId)}/messages`, { method: "POST", body: { text: controlAskMessage(ask, getLocale() === "he") } });
      toast(L("נשלח לצ'אט", "Sent to the chat"));
      setAsk("");
      if (matchMedia("(max-width: 700px)").matches) closePanel();
    } catch (e) {
      toast((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="control-sf">
      <header className="control-head">
        <b>🖥 {L("שליטה במחשב", "Computer control")}</b>
      </header>
      <div className="control-body">
        <ControlLive />
      </div>
      <form className="control-ask" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input dir="auto" value={ask} maxLength={2000} onChange={(e) => setAsk(e.target.value)} placeholder={L("לשאול על מה שעל המסך…", "Ask about what is on the screen…")} aria-label={L("שאלה על המסך", "Ask about the screen")} />
        <button type="submit" className="primary" disabled={busy || !ask.trim()}>{L("שליחה", "Send")}</button>
      </form>
    </div>
  );
}
