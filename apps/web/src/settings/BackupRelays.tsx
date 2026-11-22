import { useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Which backup relays have keys (`HubStatus.relays`, never the keys themselves). */
export interface RelaysStatus {
  ably: boolean;
  supabase: boolean;
  supabaseUrl?: string;
}

/** Where the sealed messages go now, each relay's health and this month's use (`HubStatus`). */
export interface RelaysLive {
  path?: "hub" | "ably" | "supabase";
  relayHealth?: Partial<Record<"ably" | "supabase", { state: string; healthy: boolean; error?: string }>>;
  relayUse?: { month: string; ably: number; supabase: number };
}

/** The free plans' monthly messages (as in @kesher/shared relay-failover.ts). */
const ALLOWANCE = { ably: 6_000_000, supabase: 2_000_000 } as const;

/**
 * Settings › Kesher Cloud › Backup relays: the Ably API key and the Supabase project URL + anon key, so Ably and
 * Supabase Realtime carry the sealed messages when the Kesher hub is down or at its limit. The keys go to this PC once
 * (`PUT /api/hub/relays`, saved encrypted) and are never shown again: a saved field shows "saved" with Clear. The
 * paired phones get them sealed through the hub. Works the same from the phone (remote).
 *
 * @param props.relays - Which relays have keys.
 * @param props.live - The path in use, health and use.
 * @param props.onSaved - Called after a save (reloads the status).
 */
export function BackupRelays({ relays, live, onSaved }: { relays: RelaysStatus; live: RelaysLive; onSaved: () => void }) {
  const [ablyKey, setAblyKey] = useState("");
  const [sbUrl, setSbUrl] = useState("");
  const [sbKey, setSbKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, string | null>) => {
    setBusy(true);
    try {
      await api("/api/hub/relays", { method: "PUT", body });
      setAblyKey("");
      setSbUrl("");
      setSbKey("");
      toast(L("נשמר. הטלפונים המחוברים יקבלו את המפתחות נעולים.", "Saved. The paired phones get the keys sealed."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      onSaved();
    }
  };
  const changed = { ...(ablyKey.trim() ? { ablyKey: ablyKey.trim() } : {}), ...(sbUrl.trim() ? { supabaseUrl: sbUrl.trim() } : {}), ...(sbKey.trim() ? { supabaseKey: sbKey.trim() } : {}) };
  const saved = (on: boolean, clear: Record<string, null>, label: string) =>
    on && (
      <span className="row small">
        <span className="good">✓ {L("שמור", "Saved")}</span>
        <button type="button" className="link small" disabled={busy} aria-label={L(`נקה: ${label}`, `Clear: ${label}`)} onClick={() => void save(clear)}>{L("נקה", "Clear")}</button>
      </span>
    );

  const pathName = { hub: L("המרכז", "the hub"), ably: "Ably", supabase: "Supabase" };
  const relayRow = (kind: "ably" | "supabase", name: string) => {
    if (!relays[kind]) return null;
    const h = live.relayHealth?.[kind];
    const pct = live.relayUse ? Math.min(100, Math.round((live.relayUse[kind] / ALLOWANCE[kind]) * 1000) / 10) : 0;
    return (
      <li key={kind} className="row wrap small">
        <span className={`dot ${h?.healthy ? "on" : "off"}`} aria-hidden="true" /> {name}
        <span className="muted">· {h?.healthy ? L("מוכן", "Ready") : h?.state === "connecting" ? L("מתחבר…", "Connecting…") : h ? L("לא זמין", "Unavailable") : L("כבוי", "Off")}</span>
        <span className={pct >= 80 ? "bad" : "muted"}>· {L(`${pct}% מהחינם החודש`, `${pct}% of the free plan this month`)}</span>
      </li>
    );
  };

  return (
    <div className="stack backup-relays">
      <h3>{L("ממסרים לגיבוי", "Backup relays")}</h3>
      {(relays.ably || relays.supabase) && live.path && (
        <div className="stack">
          <span className="small">{L(`ההודעות עוברות עכשיו דרך ${pathName[live.path]}`, `Messages go through ${pathName[live.path]} now`)}</span>
          <ul className="device-list">
            {relayRow("ably", "Ably")}
            {relayRow("supabase", "Supabase")}
          </ul>
        </div>
      )}
      <small className="muted">{L("כשהמרכז נופל או מגיע למגבלה, ההודעות הנעולות עוברות דרך Ably ואז Supabase (חינם, בלי כרטיס). הם רואים רק טקסט מוצפן. המפתחות נשמרים מוצפנים במחשב הזה, ולא נשלחים למרכז.", "When the hub is down or at its limit, the sealed messages go through Ably, then Supabase (free, no card). They see only ciphertext. The keys are saved encrypted on this PC and never sent to the hub.")}</small>

      <label className="stack">
        <span className="row small"><span className="grow">{L("מפתח API של Ably", "Ably API key")}</span>{saved(relays.ably, { ablyKey: null }, "Ably")}</span>
        <input type="password" dir="ltr" autoComplete="off" spellCheck={false} placeholder={relays.ably ? L("להחלפה: הדבק מפתח חדש", "To replace: paste a new key") : "app.key:secret"} value={ablyKey} disabled={busy} onChange={(e) => setAblyKey(e.target.value)} />
      </label>

      <label className="stack">
        <span className="row small"><span className="grow">{L("כתובת הפרויקט ב-Supabase", "Supabase project URL")}</span>{relays.supabaseUrl && <bdi dir="ltr" className="muted">{relays.supabaseUrl.replace(/^https:\/\//, "")}</bdi>}</span>
        <input type="url" dir="ltr" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://<project>.supabase.co" value={sbUrl} disabled={busy} onChange={(e) => setSbUrl(e.target.value)} />
      </label>
      <label className="stack">
        <span className="row small"><span className="grow">{L("מפתח anon (publishable) של Supabase", "Supabase anon (publishable) key")}</span>{saved(relays.supabase, { supabaseUrl: null, supabaseKey: null }, "Supabase")}</span>
        <input type="password" dir="ltr" autoComplete="off" spellCheck={false} placeholder={relays.supabase ? L("להחלפה: הדבק מפתח חדש", "To replace: paste a new key") : "sb_publishable_…"} value={sbKey} disabled={busy} onChange={(e) => setSbKey(e.target.value)} />
      </label>

      <div className="row">
        <button type="button" className="primary" disabled={busy || !Object.keys(changed).length} onClick={() => void save(changed)}>{L("שמור ממסרים", "Save relays")}</button>
      </div>
    </div>
  );
}
