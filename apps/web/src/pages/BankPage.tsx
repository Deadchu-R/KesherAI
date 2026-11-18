import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { askConfirm } from "../ui/askText";
import { dHash, hamming } from "../image-hash";

const ModelViewer = lazy(() => import("../ModelViewer"));
const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One file in the bank (packages/core/src/asset-bank.ts). */
export interface BankItem { id: string; kind: Kind; name: string; size: number; createdAt: string; chat?: { id: string; title: string }; prompt?: string; model?: string }
type Kind = "image" | "video" | "audio" | "model";
interface Group { hash: string; items: string[]; bytes: number; looks?: boolean }

const KINDS: Array<[Kind, string, string, string]> = [["image", "🖼", "תמונות", "Pictures"], ["video", "🎬", "וידאו", "Video"], ["audio", "🎵", "סאונד", "Sound"], ["model", "🧊", "3D", "3D"]];
const icon = (k: Kind) => KINDS.find((x) => x[0] === k)![1];
/** The address of an item's file. */
export const bankFileUrl = (id: string) => withToken(`/api/bank/file?id=${encodeURIComponent(id)}`);
const size = (n: number) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const dayOf = (at: string) => {
  const d = new Date(at);
  const today = new Date();
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (diff === 0) return L("היום", "Today");
  if (diff === 1) return L("אתמול", "Yesterday");
  return d.toLocaleDateString(getLocale() === "he" ? "he-IL" : undefined, { day: "numeric", month: "long", year: "numeric" });
};

/** The editor page for a kind, opened on a chat's file (as "Edit in…" under a chat's file). */
const EDITOR: Record<Kind, string> = { image: "image-editor", video: "video-editor", audio: "sound-editor", model: "model-editor" };
const editorHref = (k: Kind, chatId: string, path: string) => `#/p/${EDITOR[k]}/editor?c=${encodeURIComponent(chatId)}&f=${encodeURIComponent(path)}`;
/** The path in its chat of a bank id `f.<chat>.<path in base64url>`. */
const chatPathOf = (id: string) => {
  const b = id.split(".").slice(2).join(".").replace(/-/g, "+").replace(/_/g, "/");
  try { return new TextDecoder().decode(Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0))); } catch { return ""; }
};

/** A card's picture: the image itself, a video's first frame, or the kind's icon. */
function Thumb({ it }: { it: BankItem }) {
  if (it.kind === "image") return <img src={bankFileUrl(it.id)} alt="" loading="lazy" />;
  if (it.kind === "video") return <video src={`${bankFileUrl(it.id)}#t=0.1`} preload="metadata" muted playsInline />;
  return <span aria-hidden="true">{icon(it.kind)}</span>;
}

/**
 * #/bank: everything the AI made, in every chat (RESEARCH_LOG "Adding files and objects to the editors, and one bank
 * of everything the AI made"). Filter, search, preview, take into a chat, delete, and find duplicates.
 */
export function BankPage() {
  const [items, setItems] = useState<BankItem[] | null>(null);
  const [kind, setKind] = useState<Kind | "">("");
  const [q, setQ] = useState("");
  // Newest first by day, or the biggest first (to free space: Premiere's and Windows' "sort by size").
  const [order, setOrder] = useState<"new" | "big">("new");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [view, setView] = useState<BankItem | null>(null);
  const [dups, setDups] = useState<Group[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [chats, setChats] = useState<Array<{ id: string; title: string; kind: string }>>([]);
  const load = () => void api<{ items: BankItem[] }>("/api/bank").then((r) => setItems(r.items), (e: Error) => toast(e.message));
  useEffect(load, []);
  useEffect(() => void api<Array<{ id: string; title: string; kind: string }>>("/api/conversations").then((r) => setChats(r.filter((c) => c.kind !== "code").slice(0, 40)), () => undefined), []);

  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    const list = (items ?? []).filter((i) => (!kind || i.kind === kind) && (!words || `${i.name} ${i.prompt ?? ""} ${i.chat?.title ?? ""}`.toLowerCase().includes(words)));
    return order === "big" ? [...list].sort((a, b) => b.size - a.size) : list;
  }, [items, kind, q, order]);
  const days = useMemo(() => {
    const out: Array<[string, BankItem[]]> = [];
    if (order === "big") return shown.length ? [[L("הכי גדולים קודם", "Biggest first"), shown] as [string, BankItem[]]] : [];
    for (const it of shown) {
      const d = dayOf(it.createdAt);
      if (out.at(-1)?.[0] === d) out.at(-1)![1].push(it);
      else out.push([d, [it]]);
    }
    return out;
  }, [shown, order]);
  const total = (items ?? []).reduce((t, i) => t + i.size, 0);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    const names = ids.slice(0, 12).map((id) => `• ${byId.get(id)?.name ?? id}`).join("\n");
    const more = ids.length > 12 ? `\n${L(`ועוד ${ids.length - 12}`, `and ${ids.length - 12} more`)}` : "";
    if (!(await askConfirm(`${L(`למחוק ${ids.length} קבצים לתמיד? הם ייעלמו גם מהצ׳אטים שמראים אותם.`, `Delete ${ids.length} files for good? They also disappear from the chats that show them.`)}\n\n${names}${more}`, { yes: L("מחק", "Delete"), danger: true }))) return;
    const r = await api<{ deleted: number }>("/api/bank/delete", { method: "POST", body: { ids } }).catch((e: Error) => (toast(e.message), undefined));
    if (!r) return;
    toast(L(`נמחקו ${r.deleted} קבצים`, `Deleted ${r.deleted} files`));
    setSel(new Set());
    setDups((g) => g && g.map((x) => ({ ...x, items: x.items.filter((i) => !ids.includes(i)) })).filter((x) => x.items.length > 1));
    load();
  };

  const toChat = async (chatId: string) => {
    if (!chatId || !sel.size) return;
    const r = await api<{ paths: string[] }>("/api/bank/copy", { method: "POST", body: { ids: [...sel], conversationId: chatId } }).catch((e: Error) => (toast(e.message), undefined));
    if (!r) return;
    toast(L(`נוספו ${r.paths.length} קבצים לצ׳אט (בתיקייה shared)`, `Added ${r.paths.length} files to the chat (in shared)`));
    setSel(new Set());
  };

  // Duplicates: the same bytes from the computer, and pictures that look the same (a 64-bit picture hash, here).
  const findDups = async () => {
    setFinding(true);
    try {
      const same = (await api<{ groups: Group[] }>("/api/bank/duplicates")).groups;
      const inSame = new Set(same.flatMap((g) => g.items.slice(1)));
      const pics = (items ?? []).filter((i) => i.kind === "image" && !inSame.has(i.id)).slice(0, 400).reverse();
      const hashes: Array<[BankItem, bigint]> = [];
      for (const p of pics) {
        const h = await dHash(bankFileUrl(p.id)).catch(() => undefined);
        if (h !== undefined) hashes.push([p, h]);
      }
      const used = new Set<string>();
      const looks: Group[] = [];
      for (let i = 0; i < hashes.length; i++) {
        if (used.has(hashes[i]![0].id)) continue;
        const g = [hashes[i]![0]];
        for (let j = i + 1; j < hashes.length; j++) if (!used.has(hashes[j]![0].id) && hamming(hashes[i]![1], hashes[j]![1]) <= 5) g.push(hashes[j]![0]);
        if (g.length > 1) {
          g.forEach((x) => used.add(x.id));
          looks.push({ hash: `looks-${i}`, items: g.map((x) => x.id), bytes: g.slice(1).reduce((t, x) => t + x.size, 0), looks: true });
        }
      }
      setDups([...same, ...looks]);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setFinding(false);
    }
  };

  /** A generated file (not in any chat) opens in its editor after it is copied into the chosen chat. */
  const editIn = async (it: BankItem, chatId: string) => {
    if (!chatId) return;
    const r = await api<{ paths: string[] }>("/api/bank/copy", { method: "POST", body: { ids: [it.id], conversationId: chatId } }).catch((e: Error) => (toast(e.message), undefined));
    if (r?.paths[0]) location.hash = editorHref(it.kind, chatId, r.paths[0]);
  };
  const card = (it: BankItem, note?: string) => (
    <div key={it.id} className={`bank-card${sel.has(it.id) ? " sel" : ""}`}>
      <button type="button" className="bank-thumb" onClick={() => setView(it)} aria-label={L(`תצוגה של ${it.name}`, `Preview ${it.name}`)}><Thumb it={it} /></button>
      <label className="bank-check"><input type="checkbox" checked={sel.has(it.id)} onChange={() => toggle(it.id)} aria-label={L("בחר", "Select")} /></label>
      <div className="bank-cap">
        <b dir="auto" title={it.prompt ?? it.name}>{it.name}</b>
        <small className="muted" dir="auto">{note ?? `${icon(it.kind)} ${size(it.size)}${it.chat ? ` · ${it.chat.title}` : it.model ? ` · ${it.model.split("/").pop()}` : ""}`}</small>
      </div>
    </div>
  );

  return (
    <div className="bank">
      <header className="bank-head">
        <h2>🗂 {L("בנק היצירות", "Everything made")}</h2>
        {items && <span className="muted">{L(`${items.length} קבצים · ${size(total)}`, `${items.length} files · ${size(total)}`)}</span>}
        <span className="grow" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש לפי שם, תיאור או צ׳אט", "Search by name, words or chat")} aria-label={L("חיפוש", "Search")} />
        <button type="button" onClick={() => (dups ? setDups(null) : void findDups())} disabled={finding}>{finding ? L("מחפש…", "Finding…") : dups ? L("חזרה לכל הקבצים", "Back to all") : L("⧉ מצא כפילויות", "⧉ Find duplicates")}</button>
      </header>
      {!dups && (
        <div className="bank-filters" role="group" aria-label={L("סוג", "Kind")}>
          <button type="button" className={`chip-text${kind === "" ? " on" : ""}`} onClick={() => setKind("")}>{L("הכל", "All")}</button>
          {KINDS.map(([k, ic, he, en]) => <button key={k} type="button" className={`chip-text${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{ic} {L(he, en)} {(items ?? []).filter((i) => i.kind === k).length}</button>)}
          <span className="grow" />
          <select value={order} onChange={(e) => setOrder(e.target.value as "new" | "big")} aria-label={L("סדר", "Order")}>
            <option value="new">{L("חדש קודם", "Newest first")}</option>
            <option value="big">{L("גדול קודם (לפנות מקום)", "Biggest first (free space)")}</option>
          </select>
        </div>
      )}
      {!items && <p className="muted">{L("טוען…", "Loading…")}</p>}
      {items && !items.length && <p className="muted">{L("עוד אין כאן כלום. תמונות, סרטונים, שירים ומודלים שהבינה יוצרת בצ׳אטים יופיעו כאן.", "Nothing here yet. Pictures, videos, songs and models the AI makes in chats appear here.")}</p>}
      {dups && (
        <div className="stack">
          {!dups.length && <p className="muted">{L("לא נמצאו כפילויות 🎉", "No duplicates found 🎉")}</p>}
          {dups.length > 0 && (
            <div className="row">
              <span className="muted">{L(`${dups.length} קבוצות · אפשר לפנות ${size(dups.reduce((t, g) => t + g.bytes, 0))}`, `${dups.length} groups · ${size(dups.reduce((t, g) => t + g.bytes, 0))} to free`)}</span>
              <span className="grow" />
              <button type="button" className="danger" onClick={() => void remove(dups.flatMap((g) => g.items.slice(1)))}>{L("🗑 מחק את כל העותקים (הישן בכל קבוצה נשמר)", "🗑 Delete all copies (the oldest in each group stays)")}</button>
            </div>
          )}
          {dups.map((g) => (
            <section key={g.hash} className="card bank-group">
              <b>{g.looks ? L("נראות אותו דבר", "Look the same") : L("אותו קובץ בדיוק", "The same file")}</b> <span className="muted">· {g.items.length} · {size(g.bytes)}</span>
              <div className="bank-grid">{g.items.map((id, i) => { const it = byId.get(id); return it ? card(it, i === 0 ? L("✔ נשמר (הכי ישן)", "✔ Kept (oldest)") : L("עותק", "Copy")) : null; })}</div>
            </section>
          ))}
        </div>
      )}
      {!dups && days.map(([d, list]) => (
        <section key={d}>
          <h3 className="bank-day">{d}</h3>
          <div className="bank-grid">{list.map((it) => card(it))}</div>
        </section>
      ))}
      {sel.size > 0 && (
        <div className="bank-bar" role="toolbar">
          <b>{L(`${sel.size} נבחרו`, `${sel.size} selected`)}</b>
          <select value="" onChange={(e) => void toChat(e.target.value)} aria-label={L("הוסף לצ׳אט", "Add to a chat")}>
            <option value="">{L("➕ הוסף לצ׳אט…", "➕ Add to a chat…")}</option>
            {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          {sel.size === 1 && <a className="button" href={bankFileUrl([...sel][0]!)} download>{L("⬇ הורד", "⬇ Download")}</a>}
          <button type="button" className="danger" onClick={() => void remove([...sel])}>{L("🗑 מחק", "🗑 Delete")}</button>
          <button type="button" onClick={() => setSel(new Set())}>{L("ביטול", "Clear")}</button>
        </div>
      )}
      {view && (
        <div className="bank-view" role="dialog" aria-modal="true" aria-label={view.name} onClick={() => setView(null)}>
          <div className="card stack" onClick={(e) => e.stopPropagation()}>
            <div className="row"><b dir="auto">{view.name}</b><span className="grow" /><button type="button" onClick={() => setView(null)} aria-label={L("סגור", "Close")}>✕</button></div>
            {view.kind === "image" && <img src={bankFileUrl(view.id)} alt={view.prompt ?? view.name} />}
            {view.kind === "video" && <video src={bankFileUrl(view.id)} controls autoPlay playsInline />}
            {view.kind === "audio" && <audio src={bankFileUrl(view.id)} controls autoPlay />}
            {view.kind === "model" && (/\.(glb|gltf)$/i.test(view.name) || view.id.startsWith("a.")
              ? <Suspense fallback={<p className="muted">{L("טוען…", "Loading…")}</p>}><ModelViewer src={bankFileUrl(view.id)} name={view.name} /></Suspense>
              : <p className="muted">{L("מודל 3D. הוסף אותו לצ׳אט ופתח בעורך התלת, או הורד.", "A 3D model. Add it to a chat and open it in the 3D editor, or download it.")}</p>)}
            {view.prompt && <p dir="auto" className="muted">“{view.prompt}”</p>}
            <small className="muted">{size(view.size)} · {new Date(view.createdAt).toLocaleString(getLocale() === "he" ? "he-IL" : undefined)}{view.chat ? ` · ${view.chat.title}` : ""}</small>
            <div className="row">
              {view.chat && <a className="button" href={`#/c/${view.chat.id}`}>{L("פתח את הצ׳אט", "Open the chat")}</a>}
              {view.chat
                ? <a className="button" href={editorHref(view.kind, view.chat.id, chatPathOf(view.id))}>✎ {L("ערוך בעורך", "Edit in the editor")}</a>
                : <select value="" onChange={(e) => void editIn(view, e.target.value)} aria-label={L("ערוך בעורך, בצ׳אט…", "Edit in the editor, in a chat…")}>
                  <option value="">✎ {L("ערוך בעורך, בצ׳אט…", "Edit in the editor, in a chat…")}</option>
                  {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>}
              <a className="button" href={bankFileUrl(view.id)} download>{L("⬇ הורד", "⬇ Download")}</a>
              <span className="grow" />
              <button type="button" className="danger" onClick={() => { const id = view.id; setView(null); void remove([id]); }}>{L("🗑 מחק", "🗑 Delete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
