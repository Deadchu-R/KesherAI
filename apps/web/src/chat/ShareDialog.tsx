import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { ShareReplies } from "./ShareReplies";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A share as the server lists it (shares.ts): the link's path, never a separate secret. */
export interface ShareInfo { id: string; title: string; messages: number; expiresAt: string | null; views: number; path: string; updatedAt?: string }

/** Where a shared page is reached: the "Access from anywhere" link when it is on, else this address (home network only). */
export async function shareBase(): Promise<{ base: string; anywhere: boolean }> {
  const r = await api<{ tunnel?: { url?: string } }>("/api/remote").catch(() => undefined);
  const url = r?.tunnel?.url?.replace(/\/+$/, "");
  return url ? { base: url, anywhere: true } : { base: location.origin, anywhere: false };
}

/** When a share stops working, in words. */
export function untilText(expiresAt: string | null): string {
  if (!expiresAt) return L("עד שתבטלו", "until you stop it");
  const d = new Date(expiresAt);
  return L(`עד ${d.toLocaleDateString("he-IL")}`, `until ${d.toLocaleDateString()}`);
}

/**
 * Share a chat as a read-only web page (like ChatGPT's shared links): a snapshot of what was written and answered,
 * without tool steps or local paths, at a link only those you send it to know. "Update" puts the chat as it is now on
 * the same link; "Stop sharing" ends it at once. Opened from the chat's ⋯ menu.
 */
export function ShareDialog({ convId, onClose }: { convId: string; onClose: () => void }) {
  const [share, setShare] = useState<ShareInfo | null | undefined>(undefined);
  const [days, setDays] = useState(7);
  const [where, setWhere] = useState<{ base: string; anywhere: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ share: ShareInfo | null }>(`/api/conversations/${encodeURIComponent(convId)}/share`).then((r) => setShare(r.share), () => setShare(null));
    void shareBase().then(setWhere);
  }, [convId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  const link = share && where ? `${where.base}${share.path}` : "";
  const make = () => {
    setBusy(true);
    void api<{ share: ShareInfo }>(`/api/conversations/${encodeURIComponent(convId)}/share`, { method: "POST", body: { days, lang: getLocale() === "he" ? "he" : "en" } })
      .then((r) => setShare(r.share), (e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const stop = () => {
    if (!share) return;
    void api(`/api/shares/${share.id}`, { method: "DELETE" }).then(() => setShare(null), (e: Error) => toast(e.message));
  };
  const copy = () => void navigator.clipboard?.writeText(link).then(() => toast(L("הקישור הועתק", "Link copied")), () => toast(link));
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card stack" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={(e) => e.stopPropagation()}>
        <strong id="share-title">{L("שיתוף השיחה", "Share this chat")}</strong>
        <p className="muted small">{L("דף לקריאה בלבד עם מה שכתבתם והתשובות, כמו שהם עכשיו. בלי צעדי הכלים, בלי נתיבים מהמחשב ובלי השם שלכם. רק מי שמקבל את הקישור יכול לפתוח אותו.", "A read-only page with what you wrote and the answers, as they are now. No tool steps, no paths from this computer and no name. Only people you send the link to can open it.")}</p>
        {where && !where.anywhere && <p className="small share-warn">{L("הגישה מכל מקום כבוית, אז הקישור ייפתח רק ברשת של הבית. הפעילו אותה בהגדרות ← טלפון כדי לשתף עם אנשים אחרים.", "Access from anywhere is off, so the link opens only on your home network. Turn it on in Settings → Phone to share with others.")}</p>}
        {share === undefined && <p className="muted small">{L("טוען…", "Loading…")}</p>}
        {share && (
          <>
            <div className="row" style={{ gap: 8 }}>
              <input className="grow" readOnly value={link} dir="ltr" aria-label={L("הקישור", "The link")} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="primary" onClick={copy}>{L("העתק", "Copy")}</button>
            </div>
            <p className="muted small">{L(`${share.messages} הודעות · נפתח ${share.views} פעמים · ${untilText(share.expiresAt)}`, `${share.messages} messages · opened ${share.views} times · ${untilText(share.expiresAt)}`)}</p>
            <ShareReplies convId={convId} />
          </>
        )}
        {share !== undefined && (
          <label className="row small" style={{ gap: 8 }}>
            {L("תוקף:", "Works for:")}
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>{L("יום", "1 day")}</option>
              <option value={7}>{L("שבוע", "7 days")}</option>
              <option value={30}>{L("30 יום", "30 days")}</option>
              <option value={0}>{L("עד שאבטל", "Until I stop it")}</option>
            </select>
          </label>
        )}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          {share && <button type="button" className="danger-btn" onClick={stop}>{L("הפסק לשתף", "Stop sharing")}</button>}
          {share !== undefined && <button type="button" className={share ? "" : "primary"} disabled={busy} onClick={make}>{share ? L("עדכן לשיחה של עכשיו", "Update to the chat now") : L("צור קישור", "Create link")}</button>}
          <button type="button" className="ghost" onClick={onClose}>{L("סגור", "Close")}</button>
        </div>
      </div>
    </div>
  );
}
