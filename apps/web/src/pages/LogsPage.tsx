import { useEffect, useMemo, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { RichText } from "../RichText";
import { ago, LEVELS, linkedSource, logQuery, RANGES, sizeText, trendPath, type LogFilters, type LogLevel, type LogRange } from "../logs-view";
import type { ModelInfo, ModelListing } from "../api";
import "./logs-page.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A source as GET /api/logs/sources gives it (core: log-reader.ts). */
interface Source { id: string; name: string; nameHe: string; group: "kesher" | "agents" | "engines" | "unreal" | "unity" | "added"; size?: number; modified?: number; removable?: boolean }
interface Entry { n: number; t?: number; level: LogLevel; cat?: string; msg: string; extra?: string[] }
interface Hit { entry: Entry; before: Entry[]; after: Entry[] }
interface SearchResult { hits: Hit[]; matched: number; truncated: boolean; total: number; readTruncated: boolean; cats: string[] }
type Label = "bug" | "known" | "ignore";
interface Pattern { id: string; template: string; level: LogLevel; cat?: string; count: number; first?: number; last?: number; trend: number[]; rising: boolean; sample: string; label?: Label; isNew?: boolean }
interface Explained { text: string; model: string | null; hidden: number }

const GROUPS: Array<[Source["group"], string, string]> = [
  ["kesher", "KesherAI", "KesherAI"],
  ["agents", "סוכנים", "Agents"],
  ["engines", "מנועים", "Engines"],
  ["unreal", "Unreal", "Unreal"],
  ["unity", "Unity", "Unity"],
  ["added", "קבצים שהוספת", "Files you added"],
];
const LEVEL_TEXT: Record<LogLevel, [string, string]> = { error: ["שגיאות", "Errors"], warning: ["אזהרות", "Warnings"], info: ["מידע", "Info"], debug: ["דיבאג", "Debug"] };
const LABEL_TEXT: Record<Label, [string, string]> = { bug: ["🐞 באג", "🐞 Bug"], known: ["✔ ידוע", "✔ Known"], ignore: ["🙈 להתעלם", "🙈 Ignore"] };
const RANGE_TEXT: Record<LogRange, [string, string]> = { all: ["כל הזמן", "All time"], "15m": ["15 דקות", "15 min"], "1h": ["שעה", "1 hour"], "24h": ["24 שעות", "24 hours"], "7d": ["שבוע", "7 days"] };
const he = () => getLocale() === "he";
const nameOf = (s: Source) => (he() ? s.nameHe : s.name);
const timeText = (t?: number) => (t ? new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "medium" }) : "");

/** Matches file:line references in log messages (e.g. src/foo.ts:42, C:\bar.js:10:5). */
const FILE_LINE_RE = /(?:^|[\s(])([A-Za-z]:\\[^\s:)]+|\/[^\s:)]+|[a-zA-Z0-9._/-]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?(?=[)\s.,;:]|$)/g;

/** Splits a message on file:line matches and renders them as clickable links. */
function MsgWithLinks({ text }: { text: string }) {
  const parts: Array<{ kind: "text" | "link"; value: string; file?: string; line?: number }> = [];
  let last = 0;
  for (const m of text.matchAll(FILE_LINE_RE)) {
    if (m.index! > last) parts.push({ kind: "text", value: text.slice(last, m.index!) });
    const file = m[1];
    const line = Number(m[2]);
    const full = m[0];
    const leading = full.startsWith(" ") || full.startsWith("(") ? full[0] : "";
    if (leading) {
            const lastPart = parts.length ? parts[parts.length - 1] : undefined;
            if (lastPart && lastPart.kind === "text") lastPart.value += leading;
            else parts.push({ kind: "text", value: leading });
          }
    parts.push({ kind: "link", value: `${file}:${line}`, file, line });
    last = m.index! + full.length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  if (!parts.some((p) => p.kind === "link")) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "link" ? (
          <a key={i} className="log-file-link" href={`vscode://file/${p.file}:${p.line}`} title={L(`פתח ב-VS Code`, `Open in VS Code`)}>{p.value ?? ""}</a>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}

/** One entry: its level, time, category and message, and its stack trace folded. */
function EntryLine({ e, dim }: { e: Entry; dim?: boolean }) {
  return (
    <div className={`log-line lvl-${e.level}${dim ? " dim" : ""}`}>
      <span className="log-meta" dir="ltr">{e.t ? new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : `#${e.n}`}{e.cat ? ` ${e.cat}` : ""}</span>
      <span className="log-msg" dir="auto"><MsgWithLinks text={e.msg} /></span>
      {!!e.extra?.length && (
        <details className="log-extra">
          <summary>{L(`${e.extra.length} שורות נוספות`, `${e.extra.length} more lines`)}</summary>
          <pre dir="ltr">{e.extra.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

/** A pattern's small trend (bars over the time read). */
function Trend({ trend, rising }: { trend: number[]; rising: boolean }) {
  const d = trendPath(trend);
  if (!d) return null;
  return (
    <svg className={`log-trend${rising ? " rising" : ""}`} width="72" height="18" viewBox="0 0 72 18" role="img" aria-label={rising ? L("במגמת עלייה", "Rising") : L("מגמה", "Trend")}>
      <path d={d} />
    </svg>
  );
}

/**
 * Logs (Roee, 2026-11-24; research: RESEARCH_LOG "Smart log reader"): every log KesherAI knows about in one place,
 * searched with text or a pattern and filtered by level, category and time; lines grouped into patterns with counts,
 * first/last seen and a trend; labels (bug / known / ignore) kept for next time; "new since last look"; and "Explain"
 * / "Summarize the last hour's errors" with the local model. Works from the phone (adding a file only on the PC).
 */
export function LogsPage() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [source, setSource] = useState<string>("");
  const [tab, setTab] = useState<"patterns" | "lines">("patterns");
  const [f, setF] = useState<LogFilters>({ q: "", regex: false, levels: ["error", "warning"], cat: "", range: "all" });
  const [typed, setTyped] = useState("");
  const [patterns, setPatterns] = useState<{ patterns: Pattern[]; total: number; readTruncated: boolean } | null>(null);
  const [found, setFound] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [open, setOpen] = useState<Record<string, Entry[] | "loading">>({});
  const [explained, setExplained] = useState<Record<string, Explained | "loading">>({});
  const [summary, setSummary] = useState<Explained | "loading" | null>(null);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [addPath, setAddPath] = useState("");
  /** Merge mode: when true, `source` holds comma-separated ids and lines are time-sorted across them. */
  const [merge, setMerge] = useState(false);

  /** Splits the current source value into the active ids (merge mode) or a single id. */
  const activeIds = useMemo(() => (merge && source ? source.split(",").filter(Boolean) : source ? [source] : []), [merge, source]);

  const loadSources = () =>
    void api<{ sources: Source[] }>("/api/logs/sources").then((r) => {
      setSources(r.sources);
      setSource((cur) => {
        if (merge) return cur && cur.split(",").every((id) => r.sources.some((s) => s.id === id)) ? cur : "";
        return cur && r.sources.some((s) => s.id === cur) ? cur : (linkedSource(location.hash, r.sources) ?? r.sources[0]?.id ?? "");
      });
    }, (e: Error) => toast(e.message));
  useEffect(loadSources, []);

  // The search box waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setF((x) => (x.q === typed ? x : { ...x, q: typed })), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const load = () => {
        if (!source) return;
        setBusy(true);
        const done = () => setBusy(false);
        if (tab === "patterns") {
          // Patterns view does not support merge mode yet; use first source only.
          const patternSource = merge ? source.split(",")[0] : source;
          if (!patternSource) { done(); return; }
          void api<{ patterns: Pattern[]; total: number; readTruncated: boolean }>(`/api/logs/patterns?${logQuery(patternSource, { levels: f.levels, range: f.range })}`).then(setPatterns, (e: Error) => toast(e.message)).finally(done);
        } else if (merge && source.includes(",")) {
          // Merge mode: fetch each source separately and combine client-side.
          const ids = source.split(",").filter(Boolean);
          if (!ids.length) { done(); return; }
          const queries = ids.map((id) => api<SearchResult>(`/api/logs/search?${logQuery(id, f, Date.now(), { context: 2, limit: 200 })}`));
          void Promise.all(queries).then((results) => {
            const mergedHits = results.flatMap((r) => r.hits).sort((a, b) => (b.entry.t ?? 0) - (a.entry.t ?? 0));
             const readTruncated = results.some((r) => r.readTruncated);
             setFound({ hits: mergedHits, readTruncated, matched: mergedHits.length, truncated: readTruncated, total: mergedHits.length, cats: [] });
          }, (e: Error) => toast(e.message)).finally(done);
        } else {
          void api<SearchResult>(`/api/logs/search?${logQuery(source, f, Date.now(), { context: 2, limit: 200 })}`).then(setFound, (e: Error) => toast(e.message)).finally(done);
        }
      };
  useEffect(load, [source, tab, f]);
  useEffect(() => {
    setOpen({});
    setExplained({});
  }, [source]);

  const current = sources?.find((s) => s.id === source);
  const shown = useMemo(() => {
    const list = patterns?.patterns ?? [];
    const q = f.q.trim().toLowerCase();
    return list.filter((p) => (showIgnored || p.label !== "ignore") && (!f.cat || p.cat === f.cat) && (!q || p.template.toLowerCase().includes(q) || p.sample.toLowerCase().includes(q)));
  }, [patterns, showIgnored, f.q, f.cat]);
  const ignored = (patterns?.patterns ?? []).filter((p) => p.label === "ignore").length;
  const cats = useMemo(() => [...new Set([...(found?.cats ?? []), ...(patterns?.patterns ?? []).map((p) => p.cat).filter((c): c is string => !!c)])].sort(), [found, patterns]);

  const toggleLevel = (l: LogLevel) => setF((x) => ({ ...x, levels: x.levels.includes(l) ? x.levels.filter((y) => y !== l) : [...x.levels, l] }));
  const showLines = (p: Pattern) => {
    if (open[p.id]) return setOpen(({ [p.id]: _, ...rest }) => rest);
    setOpen((o) => ({ ...o, [p.id]: "loading" }));
    void api<{ entries: Entry[] }>(`/api/logs/patterns/${p.id}/lines?source=${encodeURIComponent(source)}&limit=30`).then(
      (r) => setOpen((o) => ({ ...o, [p.id]: r.entries })),
      (e: Error) => {
        toast(e.message);
        setOpen(({ [p.id]: _, ...rest }) => rest);
      },
    );
  };
  const setLabel = (p: Pattern, label: Label | null) =>
    void api(`/api/logs/patterns/${p.id}/label`, { method: "PUT", body: { source, label } }).then(() => setPatterns((x) => x && { ...x, patterns: x.patterns.map((y) => (y.id === p.id ? { ...y, ...(label ? { label } : { label: undefined }) } : y)) }), (e: Error) => toast(e.message));
  const explain = (p: Pattern) => {
    setExplained((x) => ({ ...x, [p.id]: "loading" }));
    void api<Explained>("/api/logs/explain", { method: "POST", body: { kind: "pattern", source, patternId: p.id, lang: getLocale(), ...(model ? { modelId: model } : {}) } }).then(
      (r) => setExplained((x) => ({ ...x, [p.id]: r })),
      (e: Error) => {
        toast(e.message);
        setExplained(({ [p.id]: _, ...rest }) => rest);
      },
    );
  };
  const summarize = () => {
    setSummary("loading");
    void api<Explained>("/api/logs/explain", { method: "POST", body: { kind: "hour", lang: getLocale(), ...(model ? { modelId: model } : {}) } }).then(setSummary, (e: Error) => {
      toast(e.message);
      setSummary(null);
    });
  };
  const loadModels = () => {
    if (models) return;
    void api<ModelListing>("/api/models").then((l) => setModels(l.models.filter((m) => m.category === "chat")), () => setModels([]));
  };
  const addFile = () =>
    void api<{ source: Source }>("/api/logs/files", { method: "POST", body: { path: addPath } }).then((r) => {
      setAddPath("");
      loadSources();
      setSource(r.source.id);
    }, (e: Error) => toast(e.message));
  const removeFile = (s: Source) =>
    void api(`/api/logs/files/${s.id}`, { method: "DELETE" }).then(() => {
      if (source === s.id) setSource("");
      loadSources();
    }, (e: Error) => toast(e.message));

  const explainNote = (r: Explained) => (r.model ? L(`הוסבר על ידי ${r.model}${r.hidden ? ` · ${r.hidden} פרטים רגישים הוסתרו לפני השליחה` : ""}`, `Explained by ${r.model}${r.hidden ? ` · ${r.hidden} sensitive details hidden before sending` : ""}`) : "");

  return (
    <div className="page logs-page">
      <div className="row logs-head">
        <h1 className="grow">{L("יומנים", "Logs")}</h1>
        <button type="button" className="primary" disabled={summary === "loading"} onClick={summarize}>{summary === "loading" ? L("מסכם…", "Summarizing…") : L("✨ סכם את השגיאות של השעה האחרונה", "✨ Summarize the last hour's errors")}</button>
        <button type="button" disabled={busy} onClick={() => { loadSources(); load(); }}>{L("רענן", "Refresh")}</button>
      </div>
      <p className="muted small">{L("כל היומנים של KesherAI, המנועים, הסוכנים ו-Unreal/Unity במקום אחד: חיפוש, קיבוץ לתבניות והסבר עם המודל המקומי. רק קריאה; שום יומן לא נשלח לענן אלא אם בחרת מודל ענן.", "Every log of KesherAI, the engines, the agents and Unreal/Unity in one place: search, grouping into patterns, and Explain with the local model. Read only; no log goes to the cloud unless you pick a cloud model.")}</p>

      {summary && summary !== "loading" && (
        <section className="card stack logs-explain">
          <div className="row"><strong className="grow">{L("השגיאות של השעה האחרונה", "The last hour's errors")}</strong><button type="button" className="chip" aria-label={L("סגור", "Close")} onClick={() => setSummary(null)}>✕</button></div>
          <RichText text={summary.text} />
          {summary.model && <span className="muted small">{explainNote(summary)}</span>}
        </section>
      )}

      <div className="logs-body">
        <aside className="logs-sources card" aria-label={L("מקורות", "Sources")}>
                    <label className="row logs-merge-toggle">
                      <input type="checkbox" checked={merge} onChange={(e) => { setMerge(e.target.checked); if (!e.target.checked && source.includes(",")) setSource(source.split(",")[0] ?? ""); }} />
                      <span>{L("איחוד יומנים", "Merge logs")}</span>
                    </label>
                    {GROUPS.map(([g, gHe, gEn]) => {
                      const list = (sources ?? []).filter((s) => s.group === g);
                      if (!list.length) return null;
                      const selectedIds = merge ? source.split(",").filter(Boolean) : [];
                      return (
                        <div key={g} className="logs-group">
                          <div className="muted small logs-group-title">{L(gHe, gEn)}</div>
                          {list.map((s) => {
                            const isSelected = merge ? selectedIds.includes(s.id) : s.id === source;
                            return (
                              <div key={s.id} className={`logs-source${isSelected ? " on" : ""}`}>
                                <button type="button" className="logs-source-pick" aria-pressed={isSelected} onClick={() => {
                                  if (merge) {
                                    const ids = source.split(",").filter(Boolean);
                                    const next = ids.includes(s.id) ? ids.filter((id) => id !== s.id) : [...ids, s.id];
                                    setSource(next.join(","));
                                  } else {
                                    setSource(s.id);
                                  }
                                }}>
                                  <span className="grow" dir="auto">{nameOf(s)}</span>
                                  <span className="muted small" dir="ltr">{[sizeText(s.size), s.modified ? ago(s.modified, he()) : ""].filter(Boolean).join(" · ")}</span>
                                </button>
                                {s.removable && !isRemote() && <button type="button" className="chip" aria-label={L("הסר מהרשימה", "Remove from the list")} onClick={() => removeFile(s)}>✕</button>}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
          {sources && !sources.length && <p className="muted small">{L("אין עדיין יומנים.", "No logs yet.")}</p>}
          {!isRemote() && (
            <div className="logs-add stack">
              <input dir="ltr" value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder={L("נתיב מלא לקובץ יומן", "Full path of a log file")} aria-label={L("הוסף קובץ יומן", "Add a log file")} />
              <button type="button" disabled={!addPath.trim()} onClick={addFile}>{L("＋ הוסף קובץ", "＋ Add a file")}</button>
              <span className="muted small">{L("רק קבצים בתיקיית הבית, לא קבצי מפתחות או סיסמאות.", "Only files in your home folder, never key or password files.")}</span>
            </div>
          )}
        </aside>

        <section className="logs-main stack">
                    <div className="row logs-source-row">
                      <select className="logs-source-select grow" value={source} onChange={(e) => setSource(e.target.value)} aria-label={L("יומן", "Log")} disabled={merge}>
                        {GROUPS.map(([g, gHe, gEn]) => {
                          const list = (sources ?? []).filter((s) => s.group === g);
                          return list.length ? <optgroup key={g} label={L(gHe, gEn)}>{list.map((s) => <option key={s.id} value={s.id}>{nameOf(s)}</option>)}</optgroup> : null;
                        })}
                      </select>
                      <button type="button" className={`chip-text logs-merge-toggle${merge ? " on" : ""}`} aria-pressed={merge} title={L("איחוד יומנים", "Merge logs")} onClick={() => setMerge((m) => !m)}>{L("איחוד", "Merge")}</button>
                    </div>
          <div className="row logs-tabs">
            <div className="seg-pills" role="tablist" aria-label={L("תצוגה", "View")}>
              <button type="button" role="tab" aria-selected={tab === "patterns"} className={tab === "patterns" ? "on" : ""} onClick={() => setTab("patterns")}>{L("תבניות", "Patterns")}</button>
              <button type="button" role="tab" aria-selected={tab === "lines"} className={tab === "lines" ? "on" : ""} onClick={() => setTab("lines")}>{L("שורות", "Lines")}</button>
            </div>
            {current && <span className="muted small grow" dir="auto">{nameOf(current)}{current.modified ? ` · ${L("נכתב", "written")} ${ago(current.modified, he())}` : ""}</span>}
          </div>

          <div className="logs-filters">
            <div className="row logs-search">
              <input className="grow" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={f.regex ? L("ביטוי רגולרי", "Regular expression") : L("חיפוש ביומן", "Search the log")} aria-label={L("חיפוש", "Search")} dir="auto" />
              <button type="button" className={`chip-text${f.regex ? " on" : ""}`} aria-pressed={f.regex} title={L("ביטוי רגולרי", "Regular expression")} onClick={() => setF((x) => ({ ...x, regex: !x.regex }))}>.*</button>
            </div>
            <div className="row logs-chips">
              {LEVELS.map((l) => (
                <button key={l} type="button" className={`chip-text lvl-chip lvl-${l}${f.levels.includes(l) ? " on" : ""}`} aria-pressed={f.levels.includes(l)} onClick={() => toggleLevel(l)}>{L(...LEVEL_TEXT[l])}</button>
              ))}
              <select value={f.range} onChange={(e) => setF((x) => ({ ...x, range: e.target.value as LogRange }))} aria-label={L("זמן", "Time")}>
                {(Object.keys(RANGES) as LogRange[]).map((r) => <option key={r} value={r}>{L(...RANGE_TEXT[r])}</option>)}
              </select>
              {cats.length > 0 && (
                <select value={f.cat} onChange={(e) => setF((x) => ({ ...x, cat: e.target.value }))} aria-label={L("קטגוריה", "Category")}>
                  <option value="">{L("כל הקטגוריות", "All categories")}</option>
                  {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <details className="logs-model" onToggle={(e) => (e.currentTarget.open ? loadModels() : undefined)}>
                <summary className="muted small">{model ? L(`הסבר עם: ${model}`, `Explain with: ${model}`) : L("הסבר עם: מודל מקומי", "Explain with: local model")}</summary>
                <select value={model} onChange={(e) => setModel(e.target.value)} aria-label={L("מודל להסבר", "Model for Explain")}>
                  <option value="">{L("מקומי (אוטומטי: הקטן שליד, אחרת הטעון)", "Local (auto: the small one beside, else the loaded one)")}</option>
                  {(models ?? []).map((m) => <option key={m.id} value={m.id}>{`${m.name}${m.location === "cloud" ? L(" · ענן", " · cloud") : ""}`}</option>)}
                </select>
                {models?.find((m) => m.id === model)?.location === "cloud" && <span className="small logs-cloud-note">{L("⚠ שורות היומן יישלחו לשירות ענן; מפתחות, סיסמאות, מיילים ונתיבים אישיים יוסתרו קודם.", "⚠ The log lines will go to a cloud service; keys, passwords, emails and personal paths are hidden first.")}</span>}
              </details>
            </div>
          </div>

          {busy && !patterns && !found && <p className="muted">{L("קורא…", "Reading…")}</p>}

          {tab === "patterns" && patterns && (
            <>
              <p className="muted small">
                {L(`${shown.length} תבניות מתוך ${patterns.total} שורות`, `${shown.length} patterns from ${patterns.total} lines`)}
                {patterns.readTruncated ? L(" · נקראו רק 16 MB האחרונים", " · only the last 16 MB were read") : ""}
                {ignored > 0 && (
                  <>
                    {" · "}
                    <button type="button" className="link-btn" onClick={() => setShowIgnored((x) => !x)}>{showIgnored ? L(`הסתר ${ignored} שסומנו להתעלם`, `Hide ${ignored} ignored`) : L(`הצג ${ignored} שסומנו להתעלם`, `Show ${ignored} ignored`)}</button>
                  </>
                )}
              </p>
              {!shown.length && <p className="muted">{L("אין שורות שמתאימות לסינון.", "No lines match the filters.")}</p>}
              <ul className="logs-patterns">
                {shown.map((p) => {
                  const lines = open[p.id];
                  const ex = explained[p.id];
                  return (
                    <li key={p.id} className={`card log-pattern lvl-${p.level}${p.isNew ? " is-new" : ""}${p.label === "ignore" ? " dim" : ""}`}>
                      <div className="row log-pattern-head">
                        <span className={`log-count lvl-${p.level}`} dir="ltr">×{p.count}</span>
                        {p.isNew && <span className="pill log-new">{L("חדש", "New")}</span>}
                        {p.rising && <span className="pill log-rising">{L("↗ עולה", "↗ Rising")}</span>}
                        {p.cat && <span className="muted small" dir="ltr">{p.cat}</span>}
                        <span className="grow" />
                        <Trend trend={p.trend} rising={p.rising} />
                      </div>
                      <code className="log-template" dir="ltr">{p.template}</code>
                      <div className="muted small" dir="auto">{p.first ? L(`ראשונה ${ago(p.first, true)} · אחרונה ${ago(p.last, true)}`, `First ${ago(p.first, false)} · last ${ago(p.last, false)}`) : ""}{p.last ? <span className="log-when" dir="ltr"> ({timeText(p.last)})</span> : null}</div>
                      <div className="row log-actions">
                        <button type="button" className="chip-text" aria-expanded={!!lines} onClick={() => showLines(p)}>{lines ? L("הסתר שורות", "Hide lines") : L("השורות", "Lines")}</button>
                        <button type="button" className="chip-text" disabled={ex === "loading"} onClick={() => explain(p)}>{ex === "loading" ? L("מסביר…", "Explaining…") : L("✨ הסבר", "✨ Explain")}</button>
                        <select className="log-label" value={p.label ?? ""} onChange={(e) => setLabel(p, (e.target.value || null) as Label | null)} aria-label={L("תווית", "Label")}>
                          <option value="">{L("בלי תווית", "No label")}</option>
                          {(Object.keys(LABEL_TEXT) as Label[]).map((k) => <option key={k} value={k}>{L(...LABEL_TEXT[k])}</option>)}
                        </select>
                      </div>
                      {ex && ex !== "loading" && (
                        <div className="logs-explain stack">
                          <RichText text={ex.text} />
                          {ex.model && <span className="muted small">{explainNote(ex)}</span>}
                        </div>
                      )}
                      {lines === "loading" && <p className="muted small">{L("קורא…", "Reading…")}</p>}
                      {Array.isArray(lines) && <div className="log-lines">{lines.map((e) => <EntryLine key={e.n} e={e} />)}</div>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {tab === "lines" && found && (
            <>
              <p className="muted small">
                {L(`${found.matched} שורות מתאימות מתוך ${found.total}`, `${found.matched} matching lines of ${found.total}`)}
                {found.truncated ? L(` · מוצגות ${found.hits.length} האחרונות`, ` · showing the last ${found.hits.length}`) : ""}
                {found.readTruncated ? L(" · נקראו רק 16 MB האחרונים", " · only the last 16 MB were read") : ""}
              </p>
              <div className="log-lines card">
                {found.hits.map((h) => (
                  <div key={h.entry.n} className="log-hit">
                    {h.before.map((e) => <EntryLine key={`b${e.n}`} e={e} dim />)}
                    <EntryLine e={h.entry} />
                    {h.after.map((e) => <EntryLine key={`a${e.n}`} e={e} dim />)}
                  </div>
                ))}
                {!found.hits.length && <p className="muted">{L("לא נמצא.", "Nothing found.")}</p>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
