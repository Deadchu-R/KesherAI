import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strToU8, zipSync } from "fflate";
import { addr, colName, computeSheet, parseRef, sheetCsv, showValue, xlsxFiles, type Sheet } from "@kesher/shared";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { ImportFile } from "../ImportFile";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const safeName = (t: string) => t.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || "sheet";

/** Zips Office files and saves them (Word or Excel, optional: KesherAI keeps its own format). */
function saveOffice(files: Record<string, string>, name: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * KesherAI's own spreadsheets (#/sheets and #/sheets/<id>, design SheetEditor): the list (new, or open a CSV), and the
 * grid: click a cell, type (a formula starts with =), Enter goes down and Tab right, arrows move, Delete clears; the
 * formula bar shows what the cell holds. The model's edits from the chat appear live. CSV out.
 */
export function SheetsPage({ id }: { id?: string }) {
  if (!id) return <SheetList />;
  return <SheetEditor key={id} id={id} />;
}

function SheetList() {
  const [sheets, setSheets] = useState<Array<{ id: string; title: string; cells: number; updatedAt: string }> | null>(null);
  useEffect(() => void api<{ sheets: NonNullable<typeof sheets> }>("/api/sheets").then((r) => setSheets(r.sheets), (e: Error) => toast(e.message)), []);
  const create = async (body: Record<string, unknown>) => {
    const s = await api<Sheet>("/api/sheets", { method: "POST", body });
    location.hash = `#/sheets/${s.id}`;
  };
  return (
    <main className="page slides-page">
      <header className="page-head row">
        <h1>📊 {L("גיליונות", "Sheets")}</h1>
        <span className="grow" />
        <ImportFile accept=".xlsx,.csv" label={L("ייבוא Excel / CSV", "Import Excel / CSV")} />
        <button type="button" className="primary" onClick={() => void create({ title: L("גיליון חדש", "New sheet") })}>＋ {L("גיליון חדש", "New sheet")}</button>
      </header>
      <p className="muted">{L("טבלאות עם נוסחאות שנשמרות ב-KesherAI, בלי Excel: תקציב, ציונים, מעקב. אפשר גם לבקש מהצ'אט \"תבנה לי טבלה של…\".", "Tables with formulas kept in KesherAI, no Excel needed: a budget, grades, a tracker. You can also ask a chat to \"make a table of…\".")}</p>
      {!sheets ? <p className="muted">…</p> : !sheets.length ? <p className="muted">{L("עוד אין גיליונות.", "No sheets yet.")}</p> : (
        <ul className="slides-list">{sheets.map((d) => <li key={d.id}><a href={`#/sheets/${d.id}`} className="card"><b dir="auto">{d.title}</b><span className="muted small">{L(`${d.cells} תאים`, `${d.cells} cells`)} · {new Date(d.updatedAt).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB")}</span></a></li>)}</ul>
      )}
    </main>
  );
}

function SheetEditor({ id }: { id: string }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [sel, setSel] = useState({ c: 0, r: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState<"" | "saving" | "saved">("");
  const [ask, setAsk] = useState("");
  const pending = useRef<Record<string, string>>({});
  const meta = useRef<{ title?: string; cols?: number; rows?: number }>({});
  const rev = useRef(-1);
  const timer = useRef(0);
  const grid = useRef<HTMLDivElement>(null);
  rev.current = sheet?.rev ?? -1;
  const load = useCallback(() => void api<Sheet>(`/api/sheets/${id}`).then((s) => { if (!Object.keys(pending.current).length) setSheet(s); }, (e: Error) => toast(e.message)), [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const es = new EventSource(withToken(`/api/sheets/${id}/events`));
    es.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { rev?: number };
      if (typeof m.rev === "number" && m.rev !== rev.current && !Object.keys(pending.current).length) load();
    };
    return () => es.close();
  }, [id, load]);
  const values = useMemo(() => (sheet ? computeSheet(sheet.cells) : {}), [sheet]);
  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const changes = pending.current;
      const m = meta.current;
      pending.current = {};
      meta.current = {};
      try {
        const saved = await api<Sheet>(`/api/sheets/${id}`, { method: "PUT", body: { changes, ...m, rev: rev.current } });
        setSheet((cur) => (cur ? { ...cur, rev: saved.rev, versions: saved.versions, cols: saved.cols, rows: saved.rows } : saved));
        setSaving("saved");
      } catch {
        toast(L("הגיליון השתנה בינתיים (למשל מהצ'אט). טוען את החדש.", "The sheet changed meanwhile (from the chat, say). Loading the new one."));
        load();
      }
    }, 600);
  };
  if (!sheet) return <main className="page"><p className="muted">…</p></main>;
  const set = (a: string, v: string) => {
    const cells = { ...sheet.cells };
    if (v === "") delete cells[a];
    else cells[a] = v;
    const p = parseRef(a)!;
    setSheet({ ...sheet, cells, cols: Math.max(sheet.cols, p.c + 1), rows: Math.max(sheet.rows, p.r + 1) });
    pending.current[a] = v;
    setSaving("saving");
    flush();
  };
  const grow = (k: "cols" | "rows") => {
    const n = sheet[k] + (k === "cols" ? 1 : 10);
    setSheet({ ...sheet, [k]: n });
    meta.current[k] = n;
    flush();
  };
  const cur = addr(sel.c, sel.r);
  const move = (dc: number, dr: number) => setSel((s) => ({ c: Math.max(0, Math.min(sheet.cols - 1, s.c + dc)), r: Math.max(0, Math.min(sheet.rows - 1, s.r + dr)) }));
  const rtl = getLocale() === "he";
  const onKey = (e: React.KeyboardEvent) => {
    if (editing !== null) return;
    const k = e.key;
    if (k === "ArrowDown") move(0, 1);
    else if (k === "ArrowUp") move(0, -1);
    else if (k === "ArrowRight") move(rtl ? -1 : 1, 0);
    else if (k === "ArrowLeft") move(rtl ? 1 : -1, 0);
    else if (k === "Enter" || k === "F2") setEditing(sheet.cells[cur] ?? "");
    else if (k === "Tab") move(e.shiftKey ? -1 : 1, 0);
    else if (k === "Delete" || k === "Backspace") set(cur, "");
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey) setEditing(k);
    else return;
    e.preventDefault();
  };
  const commit = (v: string, dc = 0, dr = 1) => {
    if (v !== (sheet.cells[cur] ?? "")) set(cur, v);
    setEditing(null);
    move(dc, dr);
    grid.current?.focus();
  };
  const askAi = async () => {
    if (!ask.trim()) return;
    try {
      const conv = sheet.convId ?? (await api<{ id: string }>("/api/conversations", { method: "POST", body: { kind: "chat" } })).id;
      await api(`/api/conversations/${conv}/messages`, { method: "POST", body: { text: `${L("בגיליון", "In the sheet")} "${sheet.title}" (#/sheets/${sheet.id}): ${ask.trim()}\n${L("השתמש בכלי sheet עם", "Use the sheet tool with")} id "${sheet.id}" (${L("קודם read", "read first")}).` } });
      setAsk("");
      toast(L("נשלח לצ'אט. השינוי יופיע כאן כשיסתיים.", "Sent to the chat. The change appears here when it is done."));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`${String.fromCharCode(0xfeff)}${sheetCsv(sheet)}`], { type: "text/csv;charset=utf-8" }));
    a.download = `${safeName(sheet.title)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const raw = sheet.cells[cur] ?? "";
  return (
    <main className="page docs-editor sheets-editor">
      <div className="slides-bar">
        <a href="#/sheets" className="link">‹</a>
        <input className="docs-title" dir="auto" value={sheet.title} onChange={(e) => { setSheet({ ...sheet, title: e.target.value }); meta.current.title = e.target.value; flush(); }} aria-label={L("שם הגיליון", "Sheet name")} />
        <span className="muted small">{saving === "saving" ? L("שומר…", "Saving…") : saving === "saved" ? L("נשמר", "Saved") : ""}</span>
        {!!sheet.versions?.length && (
          <select aria-label={L("גרסאות", "Versions")} value="" onChange={(e) => e.target.value && void api<Sheet>(`/api/sheets/${id}/restore`, { method: "POST", body: { rev: Number(e.target.value) } }).then(setSheet, (er: Error) => toast(er.message))}>
            <option value="">{L(`גרסה ${sheet.rev}`, `Version ${sheet.rev}`)} ▾</option>
            {[...sheet.versions].reverse().map((v) => <option key={v.rev} value={v.rev}>{L("לחזור לגרסה", "Back to version")} {v.rev} · {new Date(v.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</option>)}
          </select>
        )}
        <span className="grow" />
        <button type="button" onClick={download}>⬇ CSV</button>
        <button type="button" onClick={() => saveOffice(xlsxFiles(sheet), `${safeName(sheet.title)}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}>Excel</button>
      </div>
      <div className="row sheets-fx">
        <span className="chip" dir="ltr">{cur}</span>
        <input dir="auto" value={editing ?? raw} onFocus={() => editing === null && setEditing(raw)} onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commit(editing ?? raw); else if (e.key === "Escape") setEditing(null); }} aria-label={L("תוכן התא", "Cell content")} placeholder={L("טקסט, מספר או נוסחה (=SUM(A1:A5))", "Text, a number or a formula (=SUM(A1:A5))")} />
      </div>
      <div className="sheets-grid" ref={grid} tabIndex={0} onKeyDown={onKey} dir={rtl ? "rtl" : "ltr"}>
        <table>
          <thead><tr><th />{Array.from({ length: sheet.cols }, (_, c) => <th key={c} className={c === sel.c ? "on" : ""}>{colName(c)}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: sheet.rows }, (_, r) => (
              <tr key={r}>
                <th className={r === sel.r ? "on" : ""}>{r + 1}</th>
                {Array.from({ length: sheet.cols }, (_, c) => {
                  const a = addr(c, r);
                  const v = values[a];
                  const here = c === sel.c && r === sel.r;
                  return (
                    <td key={c} className={`${here ? "sel" : ""}${typeof v === "number" ? " num" : ""}${typeof v === "string" && /^#/.test(v) && sheet.cells[a]?.startsWith("=") ? " err" : ""}`} onMouseDown={() => { if (editing !== null && !here) commit(editing, 0, 0); else if (here && editing === null) setEditing(sheet.cells[a] ?? ""); setSel({ c, r }); }} onDoubleClick={() => setEditing(sheet.cells[a] ?? "")}>
                      {here && editing !== null ? (
                        <input autoFocus dir="auto" value={editing} onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(editing); } else if (e.key === "Tab") { e.preventDefault(); commit(editing, e.shiftKey ? -1 : 1, 0); } else if (e.key === "Escape") { setEditing(null); grid.current?.focus(); } }} aria-label={a} />
                      ) : <span dir="auto">{showValue(v)}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small sheets-tip">{L("לחיצה על תא בוחרת אותו, ולחיצה נוספת (או הקלדה) פותחת אותו לעריכה. נוסחה מתחילה ב-=.", "Tap a cell to pick it; tap again (or type) to edit. A formula starts with =.")}</p>
      <div className="row sheets-more">
        <button type="button" className="ghost small" onClick={() => grow("rows")}>＋ {L("10 שורות", "10 rows")}</button>
        <button type="button" className="ghost small" onClick={() => grow("cols")}>＋ {L("עמודה", "Column")}</button>
      </div>
      <form className="slides-ask row" onSubmit={(e) => { e.preventDefault(); void askAi(); }}>
        <input dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`✨ ${L("לבקש מהמודל: \"תוסיף עמודה של ציון מבוקש\", \"תמיין לפי ציון\"", "Ask the model: \"add a column for the grade I need\", \"sort by grade\"")}`} />
        <button type="submit" disabled={!ask.trim()}>{L("שליחה", "Send")}</button>
      </form>
    </main>
  );
}
