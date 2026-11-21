import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { refreshPluginUi } from "../plugins";
import { getLocale } from "../i18n";
import { toast } from "../library";

/** One plugin in the store index (plugins/index.json), with what is installed here. */
interface StoreItem {
  id: string;
  name: { he: string; en: string };
  description: { he: string; en: string };
  version: string;
  author: string;
  repo: string;
  permissions: Array<"files" | "network" | "models" | "engines">;
  size: number;
  installedVersion: string | null;
  updateAvailable: boolean;
}

/** A phone's install request waiting for the computer. */
interface Req {
  id: string;
  pluginId: string;
}

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** What each permission means, in plain words. */
const PERM: Record<StoreItem["permissions"][number], [string, string, string]> = {
  files: ["קבצים", "Files", "Reads and writes files outside its own folder."],
  network: ["אינטרנט", "Internet", "Makes requests to the internet."],
  models: ["מודלים", "Models", "Uses your local image, speech, video, sound or 3D models."],
  engines: ["תוכנות", "Programs", "Starts programs on this computer (a game engine, Blender); each start asks you first."],
};
const PERM_HE: Record<StoreItem["permissions"][number], string> = {
  files: "קורא וכותב קבצים מחוץ לתיקייה שלו.",
  network: "שולח בקשות לאינטרנט.",
  models: "משתמש במודלי התמונה, הדיבור, הווידאו, הצליל או התלת-ממד המקומיים שלך.",
  engines: "מפעיל תוכנות במחשב הזה (מנוע משחק, Blender); כל הפעלה שואלת אותך קודם.",
};

/** The permissions a plugin asks for, one line each (or a line saying it asks for none). */
function PermList({ list }: { list: StoreItem["permissions"] }) {
  if (list.length === 0) return <p className="small muted">{L("לא מבקש שום הרשאה מיוחדת.", "Asks for no special permission.")}</p>;
  return (
    <ul className="pl-warn" aria-label={L("הרשאות", "Permissions")}>
      {list.map((p) => <li key={p}><b>{L(PERM[p][0], PERM[p][1])}</b> {L(PERM_HE[p], PERM[p][2])}</li>)}
    </ul>
  );
}

/**
 * The plugin store: the catalog in plugins/index.json. Install shows the permissions and waits for a press; the file is
 * checked against the index's hash on the computer. On a phone the button sends a request, and the computer shows the
 * approval card (a plugin's code never starts from a phone alone).
 */
export function PluginStore() {
  const [items, setItems] = useState<StoreItem[] | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  /** The plugin whose permissions card is open. */
  const [open, setOpen] = useState<{ item: StoreItem; request?: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const remote = isRemote();

  const load = () =>
    api<{ plugins: StoreItem[]; requests: Req[] }>("/api/plugins/store").then(
      (r) => { setItems(r.plugins); setReqs(r.requests); },
      (e: Error) => { setItems([]); setError(e.message); },
    );
  useEffect(() => {
    void load();
    // The computer sees a phone's request without a refresh.
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      toast(done);
      setOpen(null);
      await load();
      await refreshPluginUi();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const name = (p: StoreItem) => L(p.name.he, p.name.en);
  const shown = (items ?? []).filter((p) => !q.trim() || `${p.id} ${p.name.he} ${p.name.en} ${p.description.he} ${p.description.en}`.toLowerCase().includes(q.trim().toLowerCase()));
  const approve = (item: StoreItem, request?: string) =>
    run(`i:${item.id}`, () => api(request ? `/api/plugins/store/requests/${request}/approve` : "/api/plugins/store/install", { method: "POST", body: { id: item.id, accept: item.permissions } }),
      L("הותקן, כבוי. הפעל אותו מהרשימה למעלה.", "Installed, turned off. Turn it on from the list above."));

  return (
    <section className="card plugin-store">
      <h2>{L("חנות התוספים", "Plugin store")}</h2>
      <p className="muted small">{L("תוספים מרשימה שנבדקת בפרויקט. הקובץ נבדק מול סכום הביקורת שברשימה לפני שהוא נפתח, וכל תוסף מתחיל כבוי.", "Plugins from a list kept in the project. The file is checked against the list's checksum before it is opened, and every plugin starts turned off.")}</p>
      {remote && <p className="muted small">{L("מהטלפון אפשר לבקש התקנה. המחשב מציג כרטיס אישור.", "From the phone you can request an install. The computer shows an approval card.")}</p>}
      {error && <p className="error small" role="alert">{error}</p>}

      {!remote && reqs.map((r) => {
        const item = items?.find((x) => x.id === r.pluginId);
        return item && (
          <div key={r.id} className="pl-preview" role="alert">
            <strong>{L(`בקשה מהטלפון: להתקין את "${name(item)}"`, `Request from the phone: install "${name(item)}"`)}</strong>
            <PermList list={item.permissions} />
            <div className="row">
              <button type="button" onClick={() => void run(`d:${r.id}`, () => api(`/api/plugins/store/requests/${r.id}`, { method: "DELETE" }), L("הבקשה נדחתה.", "Request declined."))}>{L("דחה", "Decline")}</button>
              <button type="button" className="primary" disabled={!!busy} onClick={() => void approve(item, r.id)}>{L("אשר והתקן (כבוי)", "Approve and install (off)")}</button>
            </div>
          </div>
        );
      })}

      {(items?.length ?? 0) > 4 && <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש תוספים…", "Search plugins…")} aria-label={L("חיפוש תוספים", "Search plugins")} />}
      {items && items.length === 0 && !error && <p className="muted">{L("עדיין אין תוספים ברשימה. כדי לפרסם אחד: פתח בקשת משיכה ל-plugins/index.json (ראה המדריך).", "No plugins listed yet. To publish one: open a pull request to plugins/index.json (see the guide).")}</p>}
      <ul className="plugin-list">
        {shown.map((p) => (
          <li key={p.id}>
            <div className="pl-main">
              <strong>{name(p)}</strong> <span className="muted small" dir="ltr">v{p.version} · {p.author} · {(p.size / 1048576).toFixed(1)} MB</span>
              <p className="muted small" dir="auto">{L(p.description.he, p.description.en)}</p>
              <p className="small pl-perms">{p.permissions.length === 0 ? L("בלי הרשאות מיוחדות", "No special permissions") : p.permissions.map((x) => <span key={x} className="pill bad">{L(PERM[x][0], PERM[x][1])}</span>)}</p>
            </div>
            <div className="pl-actions">
              {p.installedVersion && !p.updateAvailable && <span className="muted small">{L("מותקן", "Installed")} v{p.installedVersion}</span>}
              {p.updateAvailable && <button type="button" disabled={!!busy} onClick={() => setOpen({ item: p })}>{L(`עדכון ל-v${p.version}`, `Update to v${p.version}`)}</button>}
              {!p.installedVersion && <button type="button" disabled={!!busy} onClick={() => setOpen({ item: p })}>{L("התקנה", "Install")}</button>}
              {p.installedVersion && <button type="button" className="link-btn" disabled={!!busy} onClick={() => void run(`rm:${p.id}`, () => api(`/api/plugins/${p.id}`, { method: "DELETE" }), L("הוסר.", "Removed."))}>{L("הסרה", "Remove")}</button>}
            </div>
          </li>
        ))}
      </ul>

      {open && (
        <div className="pl-preview" role="dialog" aria-label={L("הרשאות לפני התקנה", "Permissions before installing")}>
          <strong>{name(open.item)} <span className="muted small" dir="ltr">v{open.item.version}</span></strong>
          <p className="small">{L("התוסף מבקש:", "This plugin asks for:")}</p>
          <PermList list={open.item.permissions} />
          <a className="small" dir="ltr" href={`https://github.com/${open.item.repo}`} target="_blank" rel="noopener noreferrer">github.com/{open.item.repo}</a>
          <div className="row">
            <button type="button" onClick={() => setOpen(null)}>{L("ביטול", "Cancel")}</button>
            {remote ? (
              <button type="button" className="primary" disabled={!!busy} onClick={() => void run(`r:${open.item.id}`, () => api("/api/plugins/store/requests", { method: "POST", body: { id: open.item.id } }), L("הבקשה נשלחה. המחשב צריך לאשר.", "Request sent. The computer has to approve."))}>{L("בקש מהמחשב להתקין", "Ask the computer to install")}</button>
            ) : (
              <button type="button" className="primary" disabled={!!busy} onClick={() => void approve(open.item)}>{open.item.permissions.length ? L("אני מאשר, התקן (כבוי)", "I allow this, install (off)") : L("התקן (כבוי)", "Install (off)")}</button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
