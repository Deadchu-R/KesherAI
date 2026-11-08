import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { refreshComputers } from "./computers";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Google { configured: boolean; connected: boolean; email: string | null; name: string | null; picture: string | null; services: string[] }
interface Devices { connected: boolean; share: boolean; devices: Array<{ id: string; name: string; me: boolean; online: boolean }> }

/** The account circle: who is signed in (Google), their devices, sign in and out — like Claude's. */
export function AccountButton() {
  const [g, setG] = useState<Google | null>(null);
  const [d, setD] = useState<Devices | null>(null);
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [finding, setFinding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const load = () => {
    void api<Google>("/api/google").then(setG, () => undefined);
    void api<Devices>("/api/devices").then(setD, () => undefined);
  };
  useEffect(load, []);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => {
      void api<Google>("/api/google").then((x) => {
        setG(x);
        if (x.connected) {
          setWaiting(false);
          load();
          toast(L("התחברת לחשבון Google.", "Signed in to Google."));
        }
      });
    }, 2000);
    return () => clearInterval(id);
  }, [waiting]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  if (!g) return null;
  const signIn = async () => {
    try {
      const { url } = await api<{ url: string }>("/api/google/connect", { method: "POST", body: { services: ["gmail", "calendar", "drive"] } });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const signOut = async () => {
    if (!confirm(L("להתנתק מחשבון Google? הגיבוי, Gmail, היומן והמכשירים יפסיקו לעבוד עד שתתחבר שוב.", "Sign out of Google? Backup, Gmail, Calendar and your devices stop until you sign in again."))) return;
    await api("/api/google/disconnect", { method: "POST" }).catch((e: Error) => toast(e.message));
    setOpen(false);
    load();
  };
  const share = async (on: boolean) => {
    await api("/api/devices", { method: "PUT", body: { share: on } }).catch((e: Error) => toast(e.message));
    load();
  };
  const label = g.name || g.email || "";
  const initial = (label.trim()[0] ?? "?").toUpperCase();
  const others = d?.devices.filter((x) => !x.me) ?? [];
  const SERVICES: Record<string, string> = { gmail: "Gmail", calendar: L("יומן", "Calendar"), drive: "Drive" };
  return (
    <div className="account" ref={ref}>
      <button type="button" className={`account-btn${g.connected ? "" : " out"}`} aria-expanded={open} onClick={() => setOpen(!open)} title={g.connected ? label : L("התחברות עם Google", "Sign in with Google")}>
        <span className="account-circle" aria-hidden>
          {g.connected && g.picture ? <img src={g.picture} alt="" referrerPolicy="no-referrer" /> : g.connected ? initial : (
            <svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          )}
          {g.connected && <span className="account-dot" />}
        </span>
        <span className="account-text">
          <strong dir="auto">{g.connected ? g.name || g.email : L("לא מחובר", "Not signed in")}</strong>
          <small dir="ltr">{g.connected ? (g.name ? g.email : L("מחובר ל-Google", "Signed in with Google")) : L("התחברות עם Google", "Sign in with Google")}</small>
        </span>
      </button>
      {open && (
        <div className="account-pop" role="dialog" aria-label={L("חשבון", "Account")}>
          {g.connected ? (
            <>
              <div className="row">
                <span className="account-circle big" aria-hidden>{g.picture ? <img src={g.picture} alt="" referrerPolicy="no-referrer" /> : initial}</span>
                <span className="account-text"><strong dir="auto">{g.name || g.email}</strong><small dir="ltr">{g.email}</small></span>
              </div>
              <div className="account-services">
                {["drive", "gmail", "calendar"].map((x) => (
                  <span key={x} className={`pill ${x === "drive" || g.services.includes(x) ? "good" : ""}`}>{x === "drive" || g.services.includes(x) ? "✓ " : ""}{SERVICES[x]}</span>
                ))}
                {(!g.services.includes("gmail") || !g.services.includes("calendar")) && <button type="button" className="as-link" onClick={() => void signIn()}>{L("לחבר הכול", "Connect all")}</button>}
              </div>
              {d && (
                <>
                  <label className="check">
                    <input type="checkbox" checked={d.share} onChange={(e) => void share(e.target.checked)} />
                    <span>{L("המכשירים שלי יכולים להשתמש במחשב הזה", "My devices can use this computer")}</span>
                  </label>
                  <div className="account-devices">
                    <span className="row muted small">
                      <span className="grow">{L("המכשירים שלי", "My devices")}</span>
                      <button type="button" className="link-btn small" disabled={finding} onClick={() => {
                        setFinding(true);
                        void refreshComputers().then((msg) => { toast(msg); void api<Devices>("/api/devices").then(setD); }, (e: Error) => toast(e.message)).finally(() => setFinding(false));
                      }}>{finding ? "⟳ …" : `⟳ ${L("רענן", "Refresh")}`}</button>
                    </span>
                    {others.length === 0 && <span className="muted small">{L("עוד אין — התחבר עם אותו חשבון במחשב או בטלפון השני.", "None yet — sign in with the same account on your other computer or phone.")}</span>}
                    {others.map((x) => <span key={x.id} className="small"><span style={{ color: x.online ? "var(--good)" : "var(--muted)" }}>●</span> {x.name}</span>)}
                  </div>
                </>
              )}
              <div className="row">
                <a href="#/connections" onClick={() => setOpen(false)}>{L("חיבורים", "Connections")}</a>
                <span className="grow" />
                <button type="button" onClick={() => void signOut()}>{L("התנתקות", "Sign out")}</button>
              </div>
            </>
          ) : (
            <>
              <strong>{L("התחברות עם חשבון Google", "Sign in with your Google account")}</strong>
              <p className="muted small">{L("מחבר את המחשבים והטלפון שלך זה לזה, מגבה את השיחות ל-Drive שלך, ומאפשר להשתמש ב-Gmail וביומן בצ׳אטים. הכול נשמר רק בחשבון שלך.", "Links your computers and phone, backs up your chats to your own Drive, and lets chats use Gmail and Calendar. Everything stays in your own account.")}</p>
                <button type="button" className="primary google-signin" disabled={waiting} onClick={() => void signIn()}>
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
                  {waiting ? L("ממתין לאישור בדפדפן…", "Waiting for the browser…") : L("התחברות עם Google", "Sign in with Google")}
                </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
