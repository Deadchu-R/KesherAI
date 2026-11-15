import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const size = (b: number) => (b >= GB ? `${Math.round((b / GB) * 10) / 10} GB` : b >= MB ? `${Math.round(b / MB)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

type Kind = "video" | "image" | "audio" | "document" | "archive" | "other";
interface SFile { id: string; name: string; folder: string; bytes: number; kind: Kind; mtime: number }
interface Card { id: "large" | "old-downloads" | "installers" | "duplicates" | "screenshots" | "compress-videos"; files: SFile[]; bytes: number }
interface Scan { at: string; kinds: Record<Kind, number>; folders: Array<{ name: string; bytes: number }>; top: Record<Kind, SFile[]>; cards: Card[]; partial: boolean }
interface App { id: string; name: string; publisher?: string; bytes?: number; installed?: string; canUninstall: boolean; source: string; uninstallUrl?: string; lastPlayed?: string }
interface Game { name: string; source: "steam" | "epic" | "store" | "xbox"; bytes?: number; folder?: string; uninstallUrl?: string; lastPlayed?: string }
const SOURCE_NAME: Record<string, string> = { steam: "Steam", epic: "Epic", store: "Microsoft Store", xbox: "Xbox" };
interface Compress { running?: { id: string; name: string; percent: number }; queue: string[]; done: Array<{ original: SFile; result: SFile; saved: number }>; failed: Array<{ name: string; error: string }> }

const KINDS: Kind[] = ["video", "image", "audio", "document", "archive", "other"];
const kindName = (k: Kind) => ({ video: L("סרטונים", "Videos"), image: L("תמונות", "Pictures"), audio: L("מוזיקה ושמע", "Music & audio"), document: L("מסמכים", "Documents"), archive: L("קבצים דחוסים והתקנות", "Archives & installers"), other: L("אחר", "Other") })[k];
const cardText = (c: Card["id"]) =>
  ({
    large: [L("קבצים גדולים", "Large files"), L("קבצים של חצי GB ומעלה", "Files of half a GB and more")],
    "old-downloads": [L("הורדות ישנות", "Old downloads"), L("בתיקיית ההורדות, לא נפתחו יותר מ-3 חודשים", "In Downloads, not changed for over 3 months")],
    installers: [L("קבצי התקנה", "Installers"), L("קבצי התקנה והורדות דחוסות שכבר השתמשתם בהם", "Setup files and archives you already used")],
    duplicates: [L("כפולים", "Duplicates"), L("עותקים זהים; המקור (הישן ביותר) נשאר", "Identical copies; the original (the oldest) stays")],
    screenshots: [L("צילומי מסך ישנים", "Old screenshots"), L("צילומי מסך מלפני יותר מחודשיים", "Screenshots older than two months")],
    "compress-videos": [L("סרטונים שאפשר להקטין", "Videos that can be smaller"), L("כיווץ ל-H.265: בערך חצי עד שליש מהגודל, נראה אותו דבר", "Compress to H.265: about a half to a third of the size, looks the same")],
  })[c] as [string, string];

/** A list of files to tick, then move to the bin (or make smaller). */
function FilesDialog({ title, files, compress, onClose, onChanged }: { title: string; files: SFile[]; compress?: boolean; onClose: () => void; onChanged: () => void }) {
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const chosen = files.filter((f) => pick.has(f.id));
  const total = chosen.reduce((n, f) => n + f.bytes, 0);
  const trash = async () => {
    if (!window.confirm(L(`להעביר ${chosen.length} קבצים לסל המיחזור? (אפשר לשחזר משם)`, `Move ${chosen.length} files to the Recycle Bin? (They can be restored from there.)`))) return;
    setBusy(true);
    try {
      const r = await api<{ done: string[]; failed: Array<{ error: string }>; freed: number }>("/api/storage/trash", { method: "POST", body: { ids: [...pick] } });
      toast(r.failed.length ? L(`הועברו ${r.done.length}, נכשלו ${r.failed.length}: ${r.failed[0]!.error}`, `Moved ${r.done.length}, failed ${r.failed.length}: ${r.failed[0]!.error}`) : L(`הועברו לסל המיחזור: ⁦${size(r.freed)}⁩`, `Moved to the Recycle Bin: ${size(r.freed)}`));
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const shrink = async () => {
    setBusy(true);
    try {
      await api("/api/storage/compress", { method: "POST", body: { ids: [...pick] } });
      toast(L("הכיווץ התחיל. המקור נשאר עד שתחליטו למחוק אותו.", "Compressing started. The original stays until you decide to delete it."));
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="dialog-backdrop on-top" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card stack storage-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="row wrap">
          <strong className="grow">{title}</strong>
          <button type="button" onClick={() => setPick(pick.size === files.length ? new Set() : new Set(files.map((f) => f.id)))}>{pick.size === files.length ? L("נקה בחירה", "Clear") : L("בחר הכל", "Select all")}</button>
        </div>
        <ul className="storage-files">
          {files.map((f) => (
            <li key={f.id}>
              <label className="check">
                <input type="checkbox" checked={pick.has(f.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} />
                <span className="stack grow storage-file">
                  <span dir="auto" className="storage-name">{f.name}</span>
                  <span className="muted small"><span dir="ltr">{size(f.bytes)}</span> · <span dir="ltr">{f.folder}</span> · {new Date(f.mtime).toLocaleDateString()}</span>
                </span>
              </label>
            </li>
          ))}
          {files.length === 0 && <li className="muted">{L("אין כאן כלום.", "Nothing here.")}</li>}
        </ul>
        <div className="row wrap">
          {compress ? (
            <button type="button" className="primary" disabled={busy || !pick.size} onClick={() => void shrink()}>{L(`הקטן (${pick.size})`, `Make smaller (${pick.size})`)}</button>
          ) : (
            <button type="button" className="primary" disabled={busy || !pick.size} onClick={() => void trash()}>{pick.size ? L(`לסל המיחזור (⁦${size(total)}⁩)`, `To the Recycle Bin (${size(total)})`) : L("לסל המיחזור", "To the Recycle Bin")}</button>
          )}
          <button type="button" onClick={onClose}>{L("סגור", "Close")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Speed up: caches and temporary files, like Android's cleaner. Each place shows its size; only ticked places are
 * cleaned, files in use are skipped, and an open browser keeps its cache (close it first).
 */
function SpeedUp() {
  type Spot = { id: string; he: string; en: string; noteHe: string; noteEn: string; bytes: number; closeFirst?: string[] };
  const [spots, setSpots] = useState<Spot[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const he = getLocale() === "he";
  const measure = () => {
    setBusy(true);
    void api<{ spots: Spot[] }>("/api/storage/clean")
      .then((r) => {
        setSpots(r.spots);
        setPick(new Set(r.spots.filter((x) => x.bytes > 0 && !x.closeFirst).map((x) => x.id)));
      }, (e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const clean = async () => {
    const chosen = spots?.filter((x) => pick.has(x.id)) ?? [];
    const sum = chosen.reduce((n, x) => n + x.bytes, 0);
    if (!chosen.length || !window.confirm(L(`לנקות ${chosen.length} מקומות (כ־${size(sum)})? הקבצים נמחקים לצמיתות (לא לסל המיחזור).`, `Clean ${chosen.length} places (about ${size(sum)})? The files are deleted for good (not to the Recycle Bin).`))) return;
    setBusy(true);
    try {
      const r = await api<{ freed: number; skipped: number }>("/api/storage/clean", { method: "POST", body: { ids: [...pick] } });
      toast(L(`התפנו ⁦${size(r.freed)}⁩${r.skipped ? ` · ${r.skipped} קבצים בשימוש נשארו` : ""}`, `${size(r.freed)} freed${r.skipped ? ` · ${r.skipped} files in use were left` : ""}`));
      measure();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };
  const total = (spots ?? []).filter((x) => pick.has(x.id)).reduce((n, x) => n + x.bytes, 0);
  return (
    <div className="stack speed-up">
      <div className="row wrap">
        <strong className="grow">{L("שיפור ביצועים: קאש וקבצים זמניים", "Speed up: caches and temporary files")}</strong>
        <button type="button" className={spots ? "" : "primary"} disabled={busy} onClick={measure}>{busy && !spots ? L("בודק…", "Checking…") : spots ? L("בדוק שוב", "Check again") : L("בדוק מה אפשר לנקות", "See what can be cleaned")}</button>
      </div>
      {spots && (
        <>
          <ul className="speed-list">
            {spots.filter((x) => x.bytes > 0 || x.closeFirst).map((x) => (
              <li key={x.id}>
                <label className="row check-row">
                  <input type="checkbox" checked={pick.has(x.id)} disabled={!!x.closeFirst} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })} />
                  <span className="grow stack" style={{ gap: 2 }}>
                    <span dir="auto">{he ? x.he : x.en} <span className="muted" dir="ltr">{size(x.bytes)}</span></span>
                    <span className="muted small" dir="auto">{x.closeFirst ? L(`סגרו קודם את ${x.closeFirst.join(", ")}`, `Close ${x.closeFirst.join(", ")} first`) : he ? x.noteHe : x.noteEn}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {spots.every((x) => !x.bytes) ? <p className="muted small">{L("הכל נקי.", "All clean.")}</p> : <button type="button" className="primary" style={{ alignSelf: "flex-start" }} disabled={busy || !pick.size} onClick={() => void clean()}>{busy ? "…" : L(`נקה ⁦${size(total)}⁩`, `Clean ${size(total)}`)}</button>}
        </>
      )}
    </div>
  );
}

/** Every program on the computer, biggest first, with its own uninstaller. */
function AppsDialog({ onClose }: { onClose: () => void }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [games, setGames] = useState<App[] | null>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "games" | "programs" | "store">("all");
  useEffect(() => {
    void api<App[]>("/api/storage/apps").then(setApps, (e: Error) => toast(e.message));
    // Games (Steam, Epic) and Store/Xbox apps: Windows' own program list leaves them out.
    void api<Game[]>("/api/storage/games").then((g) => setGames(g.map((x, i) => ({ id: `g${i}`, name: x.name, ...(x.bytes ? { bytes: x.bytes } : {}), canUninstall: !!x.uninstallUrl, source: x.source, ...(x.uninstallUrl ? { uninstallUrl: x.uninstallUrl } : {}), ...(x.lastPlayed ? { lastPlayed: x.lastPlayed } : {}) }))), () => setGames([]));
  }, []);
  const all = useMemo(() => {
    // A game Steam or Epic knows may also be in Windows' list: shown once, with the store's size.
    const names = new Set((games ?? []).map((g) => g.name.toLowerCase()));
    return [...(games ?? []), ...(apps ?? []).filter((a) => !names.has(a.name.toLowerCase()))].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  }, [apps, games]);
  const kindOf = (a: App) => (a.source === "steam" || a.source === "epic" || a.source === "xbox" ? "games" : a.source === "store" ? "store" : "programs");
  const shown = useMemo(() => all.filter((a) => (only === "all" || kindOf(a) === only) && (!q || a.name.toLowerCase().includes(q.toLowerCase()) || a.publisher?.toLowerCase().includes(q.toLowerCase()))), [all, q, only]);
  const remove = async (a: App) => {
    if (a.uninstallUrl) {
      if (!window.confirm(L(`לפתוח את ההסרה של ${a.name} ב־${SOURCE_NAME[a.source] ?? a.source}? שם תאשרו בעצמכם.`, `Open ${a.name}'s removal in ${SOURCE_NAME[a.source] ?? a.source}? You confirm it there.`))) return;
      try {
        await api("/api/storage/games/open", { method: "POST", body: { url: a.uninstallUrl } });
        toast(L("נפתח במחשב.", "Opened on the computer."));
      } catch (e) {
        toast((e as Error).message);
      }
      return;
    }
    if (!window.confirm(L(`להפעיל את מסיר ההתקנה של ${a.name}? הוא ישאל אתכם בעצמו.`, `Start ${a.name}'s uninstaller? It will ask you itself.`))) return;
    try {
      await api("/api/storage/apps/uninstall", { method: "POST", body: { id: a.id } });
      toast(L("מסיר ההתקנה נפתח במחשב.", "The uninstaller opened on the computer."));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return createPortal(
    <div className="dialog-backdrop on-top" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card stack storage-dialog" role="dialog" aria-modal="true" aria-label={L("תוכנות", "Programs")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="row wrap">
          <strong className="grow">{L(`תוכנות ומשחקים${apps ? ` (${all.length})` : ""}`, `Programs and games${apps ? ` (${all.length})` : ""}`)}</strong>
          <input type="search" dir="auto" placeholder={L("חיפוש…", "Search…")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg-pills" role="tablist">
          {(["all", "games", "programs", "store"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? "on" : ""} onClick={() => setOnly(k)}>
              {{ all: L("הכל", "All"), games: L("משחקים", "Games"), programs: L("תוכנות", "Programs"), store: "Store" }[k]}
            </button>
          ))}
        </div>
        {games === null && <p className="muted small">{L("מחפש משחקים ב־Steam, ‏Epic ו־Xbox…", "Looking for games in Steam, Epic and Xbox…")}</p>}
        {!apps ? (
          <p className="muted">{L("קורא את רשימת התוכנות…", "Reading the programs…")}</p>
        ) : (
          <ul className="storage-files">
            {shown.slice(0, 400).map((a) => (
              <li key={a.id} className="row">
                <span className="stack grow storage-file">
                  <span dir="auto" className="storage-name">{a.name}</span>
                  <span className="muted small">{a.bytes ? <span dir="ltr">{size(a.bytes)}</span> : L("גודל לא ידוע", "size unknown")}{SOURCE_NAME[a.source] ? ` · ${SOURCE_NAME[a.source]}` : ""}{a.publisher ? ` · ${a.publisher}` : ""}{a.installed ? ` · ${a.installed}` : ""}{a.lastPlayed ? L(` · שוחק ${a.lastPlayed}`, ` · played ${a.lastPlayed}`) : ""}</span>
                </span>
                {a.canUninstall ? <button type="button" onClick={() => void remove(a)}>{L("הסר", "Uninstall")}</button> : a.source === "dpkg" ? <span className="muted small" dir="ltr">sudo apt remove</span> : null}
              </li>
            ))}
          </ul>
        )}
        <div className="row"><button type="button" onClick={onClose}>{L("סגור", "Close")}</button></div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Storage, like Android's: what takes the space by kind, cards to clean in one press, the biggest files of each kind,
 * every program with its uninstaller, and making videos smaller. Deleting goes to the Recycle Bin.
 */
export function StorageSection() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ title: string; files: SFile[]; compress?: boolean } | null>(null);
  const [apps, setApps] = useState(false);
  const [comp, setComp] = useState<Compress | null>(null);
  const load = (fresh: boolean) => {
    setBusy(true);
    void api<Scan>(`/api/storage${fresh ? "?fresh=1" : ""}`).then(setScan, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const loadComp = () => void api<Compress>("/api/storage/compress").then(setComp, () => undefined);
  useEffect(loadComp, []);
  useEffect(() => {
    if (!comp?.running && !comp?.queue.length) return;
    const t = setInterval(loadComp, 2000);
    return () => clearInterval(t);
  }, [comp?.running, comp?.queue.length]);
  const total = scan ? KINDS.reduce((n, k) => n + scan.kinds[k], 0) : 0;
  const trashOriginal = async (id: string) => {
    if (!window.confirm(L("להעביר את הסרטון המקורי לסל המיחזור? הגרסה המכווצת נשארת.", "Move the original video to the Recycle Bin? The smaller copy stays."))) return;
    try {
      const r = await api<{ freed: number; failed: Array<{ error: string }> }>("/api/storage/trash", { method: "POST", body: { ids: [id] } });
      toast(r.failed.length ? r.failed[0]!.error : L(`התפנו ⁦${size(r.freed)}⁩`, `${size(r.freed)} freed`));
      loadComp();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section className="card stack">
      {open && <FilesDialog {...open} onClose={() => setOpen(null)} onChanged={() => { load(false); loadComp(); }} />}
      {apps && <AppsDialog onClose={() => setApps(false)} />}
      <div className="row wrap">
        <h2 className="grow">{L("אחסון", "Storage")}</h2>
        <button type="button" onClick={() => setApps(true)}>{L("תוכנות", "Programs")}</button>
        <button type="button" className={scan ? "" : "primary"} disabled={busy} onClick={() => load(!!scan)}>{busy ? L("סורק…", "Scanning…") : scan ? L("סרוק שוב", "Scan again") : L("סרוק את הקבצים שלי", "Scan my files")}</button>
      </div>
      <SpeedUp />
      {!scan && !busy && <p className="muted small">{L("סריקה של התיקיות שלכם (מסמכים, הורדות, תמונות, סרטונים, מוזיקה, שולחן העבודה): מה תופס מקום, ומה אפשר לנקות בלחיצה. שום דבר לא נמחק בלי שתבחרו.", "A scan of your folders (Documents, Downloads, Pictures, Videos, Music, Desktop): what takes the space and what can be cleaned in one press. Nothing is deleted unless you choose it.")}</p>}
      {busy && !scan && <p className="muted small">{L("סורק… זה יכול לקחת עד דקה.", "Scanning… this can take up to a minute.")}</p>}
      {comp && (comp.running || comp.queue.length > 0 || comp.done.length > 0 || comp.failed.length > 0) && (
        <div className="stack storage-compress">
          {comp.running && <p className="small" dir="auto">{L(`מכווץ: ${comp.running.name} · ⁦${comp.running.percent}%⁩`, `Compressing: ${comp.running.name} · ${comp.running.percent}%`)}{comp.queue.length ? L(` (עוד ${comp.queue.length} בתור)`, ` (${comp.queue.length} more waiting)`) : ""}</p>}
          {comp.done.map((d) => (
            <div key={d.result.id} className="row wrap small">
              <span className="grow" dir="auto">✅ {d.result.name} · {L(`נחסכו ⁦${size(d.saved)}⁩`, `${size(d.saved)} saved`)}</span>
              <button type="button" onClick={() => void trashOriginal(d.original.id)}>{L("מקור לסל המיחזור", "Original to the bin")}</button>
            </div>
          ))}
          {comp.failed.map((f, i) => <p key={i} className="small muted" dir="auto">⚠️ {f.name}: {f.error}</p>)}
        </div>
      )}
      {scan && (
        <>
          <div className="storage-bar" role="img" aria-label={L("חלוקת המקום לפי סוג", "Space by kind")}>
            {KINDS.filter((k) => scan.kinds[k] > 0).map((k) => <span key={k} className={`seg ${k}`} style={{ flexGrow: scan.kinds[k] }} title={`${kindName(k)}: ${size(scan.kinds[k])}`} />)}
          </div>
          <ul className="storage-kinds">
            {KINDS.filter((k) => scan.kinds[k] > 0).map((k) => (
              <li key={k}>
                <button type="button" className="link-like" onClick={() => setOpen({ title: kindName(k), files: scan.top[k] })}>
                  <span className={`dot ${k}`} /> {kindName(k)} <span className="muted" dir="ltr">{size(scan.kinds[k])}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">{L(`בתיקיות שלכם: ⁦${size(total)}⁩${scan.partial ? "+ (הסריקה נעצרה מוקדם)" : ""}`, `In your folders: ${size(total)}${scan.partial ? "+ (the scan stopped early)" : ""}`)}</p>
          {scan.cards.length === 0 ? (
            <p className="muted">{L("אין הצעות לניקוי כרגע.", "Nothing to clean right now.")}</p>
          ) : (
            <div className="storage-cards">
              {scan.cards.map((c) => {
                const [title, detail] = cardText(c.id);
                return (
                  <button key={c.id} type="button" className="storage-card" onClick={() => setOpen({ title, files: c.files, compress: c.id === "compress-videos" })}>
                    <strong dir="auto">{title}</strong>
                    <span className="muted small" dir="auto">{detail}</span>
                    <span className="small">{L(`${c.files.length} קבצים · ⁦${size(c.bytes)}⁩`, `${c.files.length} files · ${size(c.bytes)}`)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
