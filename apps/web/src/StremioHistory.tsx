/**
 * "What you watched" on the Stremio page (design StremioHistory): her Stremio library (she signs in here; the password
 * goes only to Stremio and is not kept) and Trakt (Stremio's official integration sends what she watches there;
 * the device code, approved on trakt.tv). Both feed the taste the recommendations come from.
 */
import { useEffect, useRef, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What /api/stremio says about the two connections (never a key or a token). */
export interface HistoryState {
  stremio: { email: string; synced: number | null; count: number; added: number } | null;
  trakt: { connected: boolean; waiting: boolean; hasApp: boolean; synced: number | null; count: number; added: number } | null;
}

const when = (t: number | null) => (t ? new Date(t).toLocaleString(getLocale() === "he" ? "he-IL" : "en-GB", { dateStyle: "short", timeStyle: "short" }) : "");
const done = (r: { added: number; total: number }) => toast(L(`נוספו ${r.added}, סה״כ ${r.total}`, `${r.added} added, ${r.total} in all`));

/**
 * The "What you watched" card.
 *
 * @param props.st - The connections' state.
 * @param props.onChange - Reloads the page's state.
 */
export function StremioHistory({ st, onChange }: { st: HistoryState; onChange: () => void }) {
  const [busy, setBusy] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState<{ userCode: string; url: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(pageTimer.current); }, []);
  // Signing in on Stremio's own page (Google, Facebook or email, all on Stremio's site), in KesherAI's browser on the
  // computer; the email form is the way from the phone.
  const [onPage, setOnPage] = useState(false);
  const [withEmail, setWithEmail] = useState(isRemote());
  const waitPage = (until: number) => {
    pageTimer.current = setTimeout(() => {
      void api<{ waiting: boolean; added?: number; total?: number }>("/api/stremio/account/page", { method: "POST", body: { op: "check" } }).then(
        (r) => {
          if (r.waiting) return Date.now() < until ? waitPage(until) : (setOnPage(false), toast(L("לא זוהתה כניסה. אפשר לנסות שוב.", "No sign-in was seen. Try again.")));
          setOnPage(false);
          done({ added: r.added ?? 0, total: r.total ?? 0 });
          onChange();
        },
        (e: Error) => {
          setOnPage(false);
          toast(e.message);
        },
      );
    }, 3000);
  };
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try {
      await f();
      onChange();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  // Asks Trakt every 5 seconds while the code is waiting for her approval.
  const wait = () => {
    timer.current = setTimeout(() => {
      void api<{ state: "wait" | "gone" | "connected"; added?: number; total?: number }>("/api/stremio/trakt/check", { method: "POST" }).then(
        (r) => {
          if (r.state === "wait") return wait();
          setCode(null);
          if (r.state === "connected") done({ added: r.added ?? 0, total: r.total ?? 0 });
          else toast(L("הקוד פג. אפשר להתחבר שוב.", "The code ended. Connect again."));
          onChange();
        },
        (e: Error) => {
          setCode(null);
          toast(e.message);
        },
      );
    }, 5000);
  };
  return (
    <section className="card stack stremio-history">
      <strong>{L("מה ראית", "What you watched")}</strong>
      <p className="muted small">{L("KesherAI לוקח מכאן מה כבר ראית, כדי לא להמליץ עליו ולהבין את הטעם שלך.", "KesherAI takes what you already watched from here, so it is not recommended again and your taste is clearer.")}</p>

      <div className="card stack stremio-conn">
        <div className="row wrap"><b className="grow">🎬 Stremio</b>{st.stremio && <span className="pill small" dir="ltr">✓ {st.stremio.email}</span>}</div>
        {st.stremio ? (
          <>
            <span className="muted small">{L(`${st.stremio.count} סרטים וסדרות שראית`, `${st.stremio.count} films and series watched`)}{st.stremio.synced ? ` · ${L("עודכן", "updated")} ${when(st.stremio.synced)}` : ""}</span>
            <div className="row wrap">
              <button type="button" disabled={!!busy} onClick={() => void run("s-sync", () => api<{ added: number; total: number }>("/api/stremio/account/sync", { method: "POST" }).then(done))}>{busy === "s-sync" ? "…" : L("↻ עדכן", "↻ Update")}</button>
              <button type="button" className="ghost" disabled={!!busy} onClick={() => void run("s-out", () => api("/api/stremio/account", { method: "DELETE" }).then(() => undefined))}>{L("התנתק", "Sign out")}</button>
            </div>
          </>
        ) : !withEmail ? (
          onPage ? (
            <div className="card trakt-code" role="status">
              <span className="small">{L("דף הכניסה של Stremio נפתח בדפדפן של קשר. התחבר שם (גם עם Google או Facebook), וקשר יזהה את זה לבד.", "Stremio's sign-in page opened in KesherAI's browser. Sign in there (Google or Facebook work too); KesherAI notices by itself.")}</span>
              <span className="muted small">{L("מחכה לכניסה…", "Waiting for you to sign in…")}</span>
            </div>
          ) : (
            <div className="row wrap">
              <button type="button" className="primary" disabled={!!busy} onClick={() => void run("s-page", () => api("/api/stremio/account/page", { method: "POST", body: { op: "signin" } }).then(() => { setOnPage(true); waitPage(Date.now() + 10 * 60_000); }))}>{L("התחבר בדף של Stremio", "Sign in on Stremio's page")}</button>
              <button type="button" className="ghost small" onClick={() => setWithEmail(true)}>{L("או עם אימייל וסיסמה", "Or with email and password")}</button>
            </div>
          )
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void run("s-in", () => api<{ added: number; total: number }>("/api/stremio/account", { method: "POST", body: { email, password } }).then((r) => { setPassword(""); done(r); })); }}>
            <div className="row wrap">
              <input type="email" autoComplete="username" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={L("אימייל של Stremio", "Stremio email")} aria-label={L("אימייל של Stremio", "Stremio email")} />
              <input type="password" autoComplete="current-password" dir="ltr" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder={L("סיסמה", "Password")} aria-label={L("סיסמה של Stremio", "Stremio password")} />
              <button type="submit" className="primary" disabled={!!busy}>{busy === "s-in" ? "…" : L("התחבר", "Sign in")}</button>
            </div>
            <span className="muted small">{L("הסיסמה עוברת רק ל-Stremio ולא נשמרת. נשמר רק מפתח כניסה, ו\"התנתק\" מבטל אותו.", "The password goes only to Stremio and is not kept: only a session key is, and \"Sign out\" ends it.")}</span>
          </form>
        )}
      </div>

      <div className="card stack stremio-conn">
        <div className="row wrap"><b className="grow">📺 Trakt</b>{st.trakt?.connected && <span className="pill small">✓ {L("מחובר", "Connected")}</span>}</div>
        {st.trakt?.connected ? (
          <>
            <span className="muted small">{L(`${st.trakt.count} סרטים וסדרות`, `${st.trakt.count} films and shows`)}{st.trakt.synced ? ` · ${L("עודכן", "updated")} ${when(st.trakt.synced)}` : ""}</span>
            <div className="row wrap">
              <button type="button" disabled={!!busy} onClick={() => void run("t-sync", () => api<{ added: number; total: number }>("/api/stremio/trakt/sync", { method: "POST" }).then(done))}>{busy === "t-sync" ? "…" : L("↻ עדכן", "↻ Update")}</button>
              <button type="button" className="ghost" disabled={!!busy} onClick={() => void run("t-out", () => api("/api/stremio/trakt", { method: "DELETE" }).then(() => undefined))}>{L("התנתק", "Disconnect")}</button>
            </div>
          </>
        ) : code ? (
          <div className="card trakt-code" role="status">
            <span className="small">{L("היכנס ל-", "Go to ")}<a href={code.url} target="_blank" rel="noreferrer" dir="ltr">{code.url.replace(/^https:\/\//, "")}</a>{L(" והקלד:", " and type:")}</span>
            <b className="trakt-user-code" dir="ltr">{code.userCode}</b>
            <span className="muted small">{L("מחכה לאישור…", "Waiting for approval…")}</span>
          </div>
        ) : (
          <>
            <span className="muted small">{L("ב-Stremio: הגדרות ← Trakt ← התחבר. כאן: אפליקציה ב-trakt.tv/oauth/applications (פעם אחת, Redirect URI: urn:ietf:wg:oauth:2.0:oob).", "In Stremio: Settings → Trakt → connect. Here: an app at trakt.tv/oauth/applications (once; Redirect URI: urn:ietf:wg:oauth:2.0:oob).")}</span>
            <div className="row wrap">
              {!st.trakt?.hasApp && <input dir="ltr" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" aria-label="Trakt Client ID" />}
              {!st.trakt?.hasApp && <input dir="ltr" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client Secret" aria-label="Trakt Client Secret" />}
              <button type="button" className="primary" disabled={!!busy || (!st.trakt?.hasApp && (!clientId.trim() || !secret.trim()))} onClick={() => void run("t-in", () => api<{ userCode: string; url: string }>("/api/stremio/trakt", { method: "POST", body: st.trakt?.hasApp ? {} : { clientId, clientSecret: secret } }).then((r) => { setCode(r); setSecret(""); wait(); }))}>{busy === "t-in" ? "…" : L("התחבר", "Connect")}</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
