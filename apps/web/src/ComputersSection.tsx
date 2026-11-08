import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale } from "./i18n";
import { desktop, toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * "A link for another device": a key of its own for the user's laptop (or a
 * browser), through the internet link. Shown on the computer and on devices
 * connected to it.
 */
export function InviteDevice() {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const make = () =>
    void api<{ link: string }>("/api/remote/devices/invite", { method: "POST", body: { device: name.trim() || L("מחשב נייד", "Laptop") } }).then((r) => setLink(r.link), (e: Error) => toast(e.message));
  return (
    <div className="stack">
      <h3>{L("קישור למכשיר אחר שלך", "A link for another device of yours")}</h3>
      <p className="muted small">{L("למשל הלפטופ: הדבק את הקישור ב-KesherAI שבלפטופ (הגדרות ← טלפון ← \"התחבר למחשב אחר\"). לכל קישור מפתח משלו, אפשר לנתק אותו לבד, ותקבל התראה כשנוצר אחד. אל תשלח את הקישור לאחרים: הוא נותן גישה למחשב.", "For example your laptop: paste the link in the laptop's KesherAI (Settings → Phone → \"Connect to another computer\"). Each link has its own key that can be removed alone, and you are told when one is made. Do not send it to anyone else: it opens this computer.")}</p>
      <div className="row">
        <input className="grow" dir="auto" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={L("שם המכשיר, למשל: לפטופ", "Device name, e.g. Laptop")} aria-label={L("שם המכשיר", "Device name")} />
        <button type="button" onClick={make}>{L("צור קישור", "Make a link")}</button>
      </div>
      {link && (
        <div className="row">
          <input className="grow mono" dir="ltr" readOnly value={link} onFocus={(e) => e.target.select()} aria-label={L("הקישור", "The link")} />
          <button type="button" className="primary" onClick={() => void navigator.clipboard.writeText(link).then(() => toast(L("הועתק", "Copied")), () => toast(L("סמן והעתק ידנית", "Select it and copy")))}>{L("העתק", "Copy")}</button>
        </div>
      )}
    </div>
  );
}

/**
 * In the desktop app: connect it to another computer that runs KesherAI
 * (the laptop opening the home PC). It opens in a window of its own, with
 * no access to this computer.
 */
export function ComputersSection() {
  const d = desktop();
  const [list, setList] = useState<Array<{ name: string; origin: string }>>([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => void d?.computers?.().then(setList, () => undefined);
  useEffect(load, []);
  return (
    <section className="card stack" id="computers">
      <h2>{L("התחבר למחשב אחר", "Connect to another computer")}</h2>
      {d?.connectComputer && !isRemote() ? (
        <>
          <p className="muted small">{L("פתח מכאן מחשב אחר שרץ עליו KesherAI, למשל את המחשב הנייח מהלפטופ, מכל מקום. במחשב ההוא (או בטלפון שמחובר אליו): הגדרות ← טלפון ← \"צור קישור\", והדבק אותו כאן. הוא נפתח בחלון נפרד, בלי גישה לקבצים של המחשב הזה.", "Open another computer that runs KesherAI from here (the home PC from your laptop), from anywhere. On that computer (or the phone connected to it): Settings → Phone → \"Make a link\", and paste it here. It opens in a separate window with no access to this computer's files.")}</p>
          <div className="row">
            <input className="grow mono" dir="ltr" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://….trycloudflare.com/?token=…" aria-label={L("קישור למחשב", "Link to the computer")} />
            <button type="button" className="primary" disabled={busy || !link.trim()} onClick={() => {
              setBusy(true);
              void d.connectComputer!(link).then((r) => {
                setBusy(false);
                if (r.error) return toast(r.error);
                setLink("");
                toast(L(`מחובר ל-${r.name}`, `Connected to ${r.name}`));
                load();
              });
            }}>{busy ? "…" : L("התחבר", "Connect")}</button>
          </div>
          {list.length > 0 && (
            <ul className="al-list">
              {list.map((c) => (
                <li key={c.origin} className="row">
                  <span className="grow"><b>{c.name}</b> <span className="muted mono small" dir="ltr">{new URL(c.origin).hostname}</span></span>
                  <button type="button" className="primary" onClick={() => void d.openComputer!(c.origin).then((r) => r.error && toast(r.error))}>{L("פתח", "Open")}</button>
                  <button type="button" onClick={() => confirm(L(`לשכוח את ${c.name}? המפתח שלו יימחק מהמחשב הזה.`, `Forget ${c.name}? Its key is deleted from this computer.`)) && void d.forgetComputer!(c.origin).then(load)}>{L("שכח", "Forget")}</button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted small">{d ? L("עדכן את האפליקציה במחשב הזה כדי להתחבר ממנה למחשב אחר.", "Update the app on this computer to connect from it to another computer.") : L("מתוך אפליקציית KesherAI למחשב אפשר להתחבר למחשב אחר. בדפדפן: פתח את הקישור ישירות.", "From the KesherAI desktop app you can connect to another computer. In a browser, just open the link.")}</p>
      )}
      <InviteDevice />
    </section>
  );
}
