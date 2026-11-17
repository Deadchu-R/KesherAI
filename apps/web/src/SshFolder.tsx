import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Ready { windows: boolean; sshfs: boolean; key: boolean; publicKey: string }
type Check = { ok: true } | { ok: false; why: "key" | "reach" | "hostkey" | "other"; detail?: string };

/**
 * New project / code session → "Another computer (SSH)": a folder on another computer, through SSHFS-Win (files) and
 * Windows' ssh (commands, agent/shell.ts). Checks SSHFS-Win, the key and the connection; makes the key once and shows
 * the line to add on the server. Fills the folder field with SSHFS-Win's path when the connection works.
 */
export function SshFolder({ onPath }: { onPath: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<Ready | null>(null);
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("22");
  const [folder, setFolder] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState("");
  const load = () => void api<Ready>("/api/ssh").then(setReady, () => setReady(null));
  useEffect(() => { if (open) load(); }, [open]);
  if (isRemote()) return null;
  if (!open) return <button type="button" className="link small" onClick={() => setOpen(true)}>{L("פרויקט במחשב אחר (SSH)…", "A project on another computer (SSH)…")}</button>;
  if (!ready) return <p className="muted small">{L("בודק…", "Checking…")}</p>;
  if (!ready.windows) return <p className="muted small">{L("כרגע רק ב-Windows (דרך SSHFS-Win).", "Windows only for now (through SSHFS-Win).")}</p>;
  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast((e as Error).message); } finally { setBusy(""); }
  };
  const tryIt = () => act("check", async () => {
    const c = await api<Check>("/api/ssh/check", { method: "POST", body: { target, port: Number(port) } });
    setCheck(c);
    if (c.ok) onPath((await api<{ path: string }>("/api/ssh/path", { method: "POST", body: { target, port: Number(port), folder } })).path);
  });
  const why = check && !check.ok ? {
    key: L("השרת לא מכיר את המפתח של המחשב הזה. הוסף בשרת את השורה למטה לקובץ ~/.ssh/authorized_keys, ואז בדוק שוב.", "The server does not know this computer's key. Add the line below to ~/.ssh/authorized_keys there, then check again."),
    reach: L("אין חיבור לכתובת הזו. בדוק את הכתובת, את הפורט, ושהשרת דולק.", "Could not reach it. Check the address, the port and that the server is on."),
    hostkey: L("טביעת האצבע של השרת השתנתה מאז הפעם הקודמת. אם זה צפוי, הסר את השורה הישנה מ-known_hosts.", "The server's fingerprint changed since last time. If that is expected, remove its old line from known_hosts."),
    other: L("החיבור לא הצליח.", "The connection did not work."),
  }[check.why] : "";
  return (
    <fieldset className="stack ssh-folder">
      <legend>{L("מחשב אחר (SSH)", "Another computer (SSH)")}</legend>
      <div className="row wrap">
        <input className="grow" dir="ltr" placeholder="user@host" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={L("משתמש וכתובת", "User and address")} />
        <input dir="ltr" inputMode="numeric" style={{ width: 72 }} value={port} onChange={(e) => setPort(e.target.value)} aria-label={L("פורט", "Port")} />
        <input className="grow" dir="ltr" placeholder="/home/me/game" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label={L("תיקייה שם", "Folder there")} />
      </div>
      <ul className="plain small stack">
        <li className="row"><span className="grow">{L("SSHFS-Win (מציג את הקבצים כאילו הם כאן)", "SSHFS-Win (shows the files as if they were here)")}</span>
          {ready.sshfs ? <span className="good">{L("מותקן ✓", "Installed ✓")}</span> : <button type="button" disabled={!!busy} onClick={() => void act("install", async () => { await api("/api/ssh/install", { method: "POST" }); load(); })}>{busy === "install" ? L("מתקין…", "Installing…") : L("התקן (חינם, קוד פתוח)", "Install (free, open source)")}</button>}</li>
        <li className="row"><span className="grow">{L("מפתח SSH במחשב הזה", "An SSH key on this computer")}</span>
          {ready.key ? <span className="good">{L("יש ✓", "Ready ✓")}</span> : <button type="button" disabled={!!busy} onClick={() => void act("key", async () => { await api("/api/ssh/key", { method: "POST" }); load(); })}>{L("צור מפתח", "Make a key")}</button>}</li>
        {check && <li className="row"><span className="grow" dir="auto">{L(`חיבור ל-${target}`, `Connection to ${target}`)}</span><span className={check.ok ? "good" : "warn"}>{check.ok ? L("עובד ✓", "Works ✓") : L("לא עובד", "Not working")}</span></li>}
      </ul>
      {why && <p className="small">{why}</p>}
      {ready.publicKey && check && !check.ok && check.why === "key" && (
        <>
          <pre className="code small" dir="ltr" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{ready.publicKey}</pre>
          <button type="button" onClick={() => void navigator.clipboard.writeText(ready.publicKey).then(() => toast(L("הועתק", "Copied")))}>{L("העתק", "Copy")}</button>
        </>
      )}
      <div className="row">
        <button type="button" disabled={!target || !ready.sshfs || !ready.key || !!busy} onClick={() => void tryIt()}>{busy === "check" ? L("בודק…", "Checking…") : check ? L("בדוק שוב", "Check again") : L("בדוק חיבור", "Check the connection")}</button>
      </div>
    </fieldset>
  );
}
