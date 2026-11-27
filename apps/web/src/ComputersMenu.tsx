import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, appHome, disconnectComputer, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { desktop, toast } from "./library";
import { COMPUTERS_EVENT, refreshComputers } from "./computers";
import { ACTIVE_COMPUTER_EVENT, activeComputer, computerLine, computerWhy, setActiveComputer, sortComputers, type ComputerRow } from "./active-computer";
import { computerState } from "@kesher/shared";
import "./computers-menu.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** "Why?" under a computer that cannot be used now: the reason and what to do (the phone app's words). */
function why(r: ComputerRow) {
  const v = computerWhy(r);
  if (!v) return null;
  return (
    <details className="pcs-why">
      <summary>{L("למה?", "Why?")}</summary>
      <span className="muted small" dir="auto">
        {L(`${v.title.he}. ${v.fix.he}`, `${v.title.en}. ${v.fix.en}`)}
      </span>
    </details>
  );
}

/**
 * The one list of computers for the whole app (not per chat): the connected one and the user's other computers
 * (My devices), each with its state (online, asleep, last seen, version). "Use for all chats" makes every chat
 * start on that computer (a chat can still pick another in its own model menu); "Open" switches the window or the
 * phone app to it; Disconnect leaves the connected computer. Works from the phone through the connected computer.
 */
export function ComputersPanel() {
  const [rows, setRows] = useState<ComputerRow[]>([]);
  const [active, setActive] = useState(activeComputer);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => void api<{ devices: ComputerRow[] }>("/api/devices").then((r) => alive && setRows(r.devices), () => undefined);
    load();
    const id = setInterval(load, 15_000);
    const sync = () => setActive(activeComputer());
    addEventListener(COMPUTERS_EVENT, load);
    addEventListener(ACTIVE_COMPUTER_EVENT, sync);
    return () => {
      alive = false;
      clearInterval(id);
      removeEventListener(COMPUTERS_EVENT, load);
      removeEventListener(ACTIVE_COMPUTER_EVENT, sync);
    };
  }, []);
  const he = getLocale() === "he";
  const home = appHome()?.replace(/\/$/, "");
  const bridge = desktop();
  /** Switches the window (desktop) or the phone app to another computer. */
  const open = (r: ComputerRow) => {
    if (home) location.href = `${home}/?switch=1&use=${encodeURIComponent(r.name)}`;
    else if (bridge?.openDevice) void bridge.openDevice(r.id).then((x) => x.error && toast(x.error), (e: Error) => toast(e.message));
  };
  const canOpen = (r: ComputerRow) => r.online && !r.me && (!!home || (!!bridge?.openDevice && !isRemote()));
  return (
    <div className="pcs">
      {sortComputers(rows, active).map((r) => {
        const inUse = active ? r.providerId === active : r.me;
        return (
          <div key={r.id} className={`pcs-row${inUse ? " use" : ""}`}>
            <span className={`hub-led ${computerState(r) === "online" ? "ok" : computerState(r) === "asleep" ? "asleep" : "off"}`} aria-hidden />
            <div className="pcs-main">
              <b dir="auto">{r.name}</b>
              <span className="muted small" dir="auto">
                {computerLine(r, inUse, Date.now(), he)}
              </span>
              {why(r)}
            </div>
            <div className="pcs-acts">
              {!r.me && r.providerId && r.online && !inUse && <button type="button" onClick={() => setActiveComputer(r.providerId!)}>{L("השתמש בו בכל הצ'אטים", "Use for all chats")}</button>}
              {inUse && !r.me && <button type="button" onClick={() => setActiveComputer("")}>{L("חזרה למחשב המחובר", "Back to the connected one")}</button>}
              {canOpen(r) && <button type="button" onClick={() => open(r)}>{L("עבור אליו", "Switch to it")}</button>}
              {r.me && (!!home || isRemote()) && <button type="button" className="danger" onClick={() => confirm(L("לנתק מהמחשב הזה? תוכל להתחבר אליו שוב עם הקישור.", "Disconnect from this computer? You can connect again with its link.")) && disconnectComputer()}>{L("נתק", "Disconnect")}</button>}
            </div>
          </div>
        );
      })}
      {rows.length < 2 && <p className="muted small">{L("לא נמצאו מחשבים אחרים. אותו חשבון Google בשני המחשבים, ובשני לסמן \"המכשירים שלי יכולים להשתמש במחשב הזה\".", "No other computers found. The same Google account on both, and on the other tick \"My devices can use this computer\".")}</p>}
      <div className="pcs-foot">
        <button type="button" disabled={busy} onClick={() => { setBusy(true); void refreshComputers().then(toast, (e: Error) => toast(e.message)).finally(() => setBusy(false)); }}>{busy ? "…" : `⟳ ${L("חפש מחשבים", "Find computers")}`}</button>
        {home && <a className="button" href={`${home}/?switch=1`}>{L("כל המחשבים באפליקציה", "All computers in the app")}</a>}
      </div>
    </div>
  );
}

/** The Computers menu as a dialog over the page (from the app menu); Escape or a tap outside closes it. */
export function ComputersDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card stack pcs-dialog" role="dialog" aria-modal="true" aria-label={L("מחשבים", "Computers")} onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 className="grow">{L("מחשבים", "Computers")}</h2><button type="button" className="ghost" aria-label={L("סגירה", "Close")} onClick={onClose}>✕</button></div>
        <ComputersPanel />
      </div>
    </div>,
    document.body,
  );
}
