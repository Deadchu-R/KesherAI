import { Code } from "./ui/Code";
import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { desktop } from "./library";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Info { connected: boolean; extension?: boolean; extensionCdp?: boolean; browser?: string; version?: string; key: string; folder: string | null }

/** Settings → Browser: the extension that lets the agent work in the user's own browser. */
export function BrowserSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const load = () => void api<Info>("/api/browser").then(setInfo, () => undefined);
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);
  if (!info) return null;
  // "connected" also counts KesherAI's own browser pane; this card is about the extension.
  const ext = info.extension ?? info.connected;
  return (
    <section className="card stack">
      <h2>{L("הדפדפן שלך", "Your browser")}</h2>
      <p className="muted">{L("עם התוסף של KesherAI הסוכן יכול לעבוד בדפדפן שלך, איפה שאתה כבר מחובר: לפתוח דפים, לקרוא, ללחוץ ולמלא. הוא שואל לפני כל פעולה (אלא אם בחרת מצב אוטומטי), ולעולם לא מקליד סיסמאות.", "With the KesherAI extension the agent can work in your own browser, where you are already signed in: open pages, read, click and fill in. It asks before each action (unless you chose the automatic mode) and never types passwords.")}</p>
      <p>
        {ext ? (
          <span className="pill good">{L(`מחובר${info.browser ? ` · ${info.browser}` : ""}`, `Connected${info.browser ? ` · ${info.browser}` : ""}`)}</span>
        ) : (
          <span className="pill">{L("התוסף לא מחובר", "The extension is not connected")}</span>
        )}
      </p>
      {/* Extension 0.3.0 (Chrome, Edge, Brave): the exact tools over Chrome's debugger, and the bar Chrome shows for it. */}
      {ext && info.extensionCdp && (
        <p className="muted small" dir="auto">
          {L(
            "כלי הניפוי (מבנה הדף, קונסול, רשת, מקשים) עובדים גם כאן. בפעם הראשונה התוסף יבקש הרשאת \"debugger\", ובזמן העבודה Chrome יציג פס \"KesherAI started debugging this browser\". זה צפוי; לחיצה על Cancel בפס עוצרת את KesherAI. הלשוניות שלו נמצאות בקבוצת לשוניות \"KesherAI\".",
            "The debugging tools (page structure, console, network, keys) work here too. The first time, the extension asks for the \"debugger\" permission, and while it works Chrome shows a \"KesherAI started debugging this browser\" bar. That is expected; Cancel on that bar stops KesherAI. Its tabs are in a \"KesherAI\" tab group.",
          )}
        </p>
      )}
      {ext && !info.extensionCdp && !/firefox/i.test(info.browser ?? "") && (
        <p className="muted small" dir="auto">{L("עדכן את התוסף ל-0.3.0 כדי לקבל את כלי הניפוי (קונסול, רשת, לחיצות מדויקות) גם בדפדפן שלך.", "Update the extension to 0.3.0 to get the debugging tools (console, network, exact clicks) in your own browser too.")}</p>
      )}
      {!ext && (
        <>
        <ol className="small">
          <li>{L("פתח בדפדפן (Chrome, ‏Edge או Brave) את ", "In Chrome, Edge or Brave open ")}<Code>chrome://extensions</Code>{L(" והדלק את Developer mode.", " and turn on Developer mode.")}</li>
          <li>{L("לחץ Load unpacked ובחר את תיקיית התוסף.", "Click Load unpacked and choose the extension's folder.")} {info.folder && <Code>{info.folder}</Code>}</li>
          <li>{L("לחץ על הסמל של KesherAI בסרגל, הדבק את המפתח ולחץ Connect.", "Click the KesherAI icon in the toolbar, paste the key and press Connect.")}</li>
        </ol>
        <p className="muted small">{L("ב-Firefox: הורד את הגרסה ל-Firefox, פתח ", "In Firefox: download the Firefox version, open ")}<Code>about:debugging#/runtime/this-firefox</Code>{L(", לחץ Load Temporary Add-on ובחר את קובץ ה-zip (עד שהתוסף יהיה בחנות של Firefox).", ", click Load Temporary Add-on and choose the zip (until the extension is in Firefox's store).")}</p>
        </>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="muted small">{L("מפתח חיבור:", "Connection key:")}</span>
        <Code>{info.key}</Code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(info.key).then(() => setCopied(true))}>{copied ? L("הועתק", "Copied") : L("העתק", "Copy")}</button>
        {info.folder && desktop()?.openPath && <button type="button" onClick={() => void desktop()!.openPath!(info.folder!)}>{L("פתח את תיקיית התוסף", "Open the extension folder")}</button>}
        {info.folder && <a className="button" href={withToken("/api/browser/package?for=chrome")} download>{L("הורד zip ל-Chrome / Edge / Brave", "Download zip for Chrome / Edge / Brave")}</a>}
        {info.folder && <a className="button" href={withToken("/api/browser/package?for=firefox")} download>{L("הורד zip ל-Firefox", "Download zip for Firefox")}</a>}
      </div>
    </section>
  );
}

/** One standing site permission, as the server lists it. */
interface SiteRow { site: string; level: "open" | "act"; at?: string; source: "always" | "grant" }
interface SitesInfo {
  entries: SiteRow[];
  sensitive: { builtIn: Record<string, string[]>; own: string[] };
  blocked: string[];
  canAdd: boolean;
  helperAlways?: boolean;
}

const KIND_NAMES: Record<string, [string, string]> = {
  bank: ["בנקים", "Banks"],
  payment: ["תשלומים", "Payments"],
  email: ["דואר", "Mail"],
  account: ["חשבונות והתחברות", "Accounts and sign-in"],
  government: ["ממשלה", "Government"],
};

/**
 * Settings › Browser and computer › Sites: the sites with a standing permission ("Always on this site" on an
 * approval card, or added here), what each allows and since when, with Remove; the sites that always ask (read-only);
 * and adding a site by hand (on the computer only). The phone views and removes.
 */
export function BrowserSitesSection() {
  const [info, setInfo] = useState<SitesInfo | null>(null);
  const [helperAlways, setHelperAlways] = useState(false);
  const [host, setHost] = useState("");
  const [level, setLevel] = useState<"open" | "act">("act");
  const [error, setError] = useState("");
  const apply = (r: SitesInfo) => {
    setInfo(r);
    setHelperAlways(r.helperAlways === true);
  };
  const load = () => void api<SitesInfo>("/api/browser/sites").then(apply, () => setInfo(null));
  useEffect(load, []);
  if (!info) return null;
  const day = (iso: string) => new Date(iso).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
  const add = () => {
    setError("");
    void api<SitesInfo>("/api/browser/sites", { method: "POST", body: { site: host, level } }).then(
      (r) => {
        apply(r);
        setHost("");
      },
      (e: Error) => setError(e.message),
    );
  };
  return (
    <section className="card stack" id="settings-sites">
      <h2>{L("אתרים (הרשאות קבועות)", "Sites (standing permissions)")}</h2>
      <p className="muted small">{L("באתרים האלה המודל פועל בלי לשאול כל פעם (בחרתם \"תמיד באתר הזה\" או הוספתם כאן). סיסמאות והורדות — אף פעם.", "On these sites the model acts without asking each time (you chose \"Always on this site\" or added it here). Passwords and downloads: never.")}</p>
      {info.entries.length ? (
        <ul className="plain-list">
          {info.entries.map((e) => (
            <li key={e.site} className="row">
              <span className="grow">
                <code dir="ltr">{e.site}</code>
                <span className="muted small" dir="auto"> · {e.level === "open" ? L("פתיחה וקריאה בלבד", "Open and read only") : L("פתיחה, לחיצה והקלדה", "Open, click and type")}{e.at ? ` · ${L("מאז", "since")} ${day(e.at)}` : ""}</span>
              </span>
              <button type="button" onClick={() => void api<SitesInfo>(`/api/browser/sites?site=${encodeURIComponent(e.site)}`, { method: "DELETE" }).then(apply)}>{L("הסר", "Remove")}</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{L("עוד אין. אישורים לצ'אט או לשעה נמצאים בהגדרות › אישורים.", "None yet. Approvals for a chat or 1 hour are in Settings › Approvals.")}</p>
      )}
      {info.canAdd ? (
        <div className="stack">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input dir="ltr" className="grow" style={{ minWidth: "12rem" }} value={host} placeholder="example.com  /  *.example.com" aria-label={L("אתר", "Site")} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && host.trim() && add()} />
            <select value={level} aria-label={L("מה מותר", "What is allowed")} onChange={(e) => setLevel(e.target.value as "open" | "act")}>
              <option value="act">{L("פתיחה, לחיצה והקלדה", "Open, click and type")}</option>
              <option value="open">{L("פתיחה וקריאה בלבד", "Open and read only")}</option>
            </select>
            <button type="button" disabled={!host.trim()} onClick={add}>{L("הוסף אתר", "Add site")}</button>
          </div>
          {error && <p className="small" role="alert" dir="auto">{error}</p>}
          <p className="muted small">{L("שם האתר בלבד, בלי כתובת או נתיב. \"*.\" בהתחלה כולל גם תת-אתרים.", "Only the site's name, no address or path. A leading \"*.\" also covers its subdomains.")}</p>
        </div>
      ) : (
        <p className="muted small">{L("הוספת אתר ידנית אפשרית רק במחשב עצמו; מכאן אפשר לצפות ולהסיר.", "Adding a site by hand is possible only on the computer; here you can view and remove.")}</p>
      )}
      <h3>{L("תמיד שואלים (לקריאה בלבד)", "Always asks (read-only)")}</h3>
      <p className="muted small">{L("באתרים האלה אין \"תמיד\": כל פעולה מבקשת אישור. הרשימה שלכם — בהגדרות הבטיחות למעלה.", "These sites have no \"always\": every action asks. Your own list is in the safety settings above.")}</p>
      <ul className="plain-list">
        {Object.entries(info.sensitive.builtIn).map(([kind, hosts]) => (
          <li key={kind}>
            <details>
              <summary dir="auto">{L(...(KIND_NAMES[kind] ?? [kind, kind]))} <span className="muted small">({hosts.length})</span></summary>
              <p className="muted small" dir="ltr">{hosts.join(", ")}</p>
            </details>
          </li>
        ))}
        {info.sensitive.own.length > 0 && <li><span dir="auto">{L("שלכם", "Yours")}</span> <span className="muted small" dir="ltr">{info.sensitive.own.join(", ")}</span></li>}
        {info.blocked.length > 0 && <li><span dir="auto">{L("חסומים (אף פעם לא נפתחים)", "Blocked (never opened)")}</span> <span className="muted small" dir="ltr">{info.blocked.join(", ")}</span></li>}
      </ul>
      {/* Off by default: helper agents ask before every browser action, even on sites listed above. */}
      <label className="row">
        <input
          type="checkbox"
          checked={helperAlways}
          onChange={(e) => {
            const on = e.target.checked;
            setHelperAlways(on);
            void api<{ on: boolean }>("/api/browser/helper-always", { method: "POST", body: { on } }).then((r) => setHelperAlways(r.on), () => setHelperAlways(!on));
          }}
        />
        <span dir="auto">{L("גם סוכני עזר יכולים להשתמש ב\"תמיד באתר הזה\" (כבוי: סוכן עזר שואל לפני כל פעולה בדפדפן)", "Helper agents may use \"Always on this site\" too (off: a helper asks before every browser action)")}</span>
      </label>
    </section>
  );
}
