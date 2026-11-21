import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Filter { safeSearch: "strict" | "moderate" | "off"; onion: boolean; blocked: string[] }

interface EngineCheck { backend: string; ok: boolean; count: number; relevant?: number; error?: string }
interface EngineState { engine: string; keys: { tavily: boolean; brave: boolean }; last: { at: number; results: EngineCheck[] } | null }

/** The engines in the choice list (keyed ones only appear when their key is set). */
const ENGINES: Array<{ id: string; name: string; keyed?: "tavily" | "brave" }> = [
  { id: "tavily", name: "Tavily", keyed: "tavily" },
  { id: "brave", name: "Brave Search API", keyed: "brave" },
  { id: "duckduckgo", name: "DuckDuckGo" },
  { id: "duckduckgo-lite", name: "DuckDuckGo Lite" },
  { id: "yahoo", name: "Yahoo" },
  { id: "startpage", name: "Startpage" },
  { id: "ecosia", name: "Ecosia" },
  { id: "mojeek", name: "Mojeek" },
  { id: "bing", name: "Bing" },
];

/**
 * Settings → Web: the default search engine. "Automatic" (default) tries the best that works; any other choice is
 * tried first, and the others are the fallback when it errors or answers unrelated results. Each engine shows whether
 * it worked on the last check; "Check now" runs the check (on the computer only; the phone reads the last result).
 */
function SearchEngine() {
  const [st, setSt] = useState<EngineState | null>(null);
  const [busy, setBusy] = useState(false);
  const remote = isRemote();
  const load = () => void api<EngineState>("/api/web-engine").then(setSt, () => undefined);
  useEffect(load, []);
  if (!st) return null;
  const choose = (engine: string) => void api("/api/web-engine", { method: "PUT", body: { engine } }).then(() => { setSt({ ...st, engine }); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  const check = () => {
    setBusy(true);
    void api("/api/web/search-check").then(load, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const status = (id: string) => {
    const r = st.last?.results.find((x) => x.backend === id);
    if (!r) return <span className="muted">{L("לא נבדק", "not checked")}</span>;
    return r.ok ? <span>✓ {L(`עבד (${r.relevant ?? r.count} תוצאות)`, `worked (${r.relevant ?? r.count} results)`)}</span> : <span title={r.error}>✗ {L("לא עבד", "failed")}</span>;
  };
  const rows = [{ id: "auto", name: L("אוטומטי (הטוב שעובד)", "Automatic (best that works)") }, ...ENGINES.filter((e) => !e.keyed || st.keys[e.keyed])];
  return (
    <div className="stack">
      <h3>{L("מנוע חיפוש ברירת מחדל", "Default search engine")}</h3>
      <p className="muted small">{L("המנוע שנבחר נוסה ראשון; אם הוא נכשל או מחזיר תוצאות לא קשורות, עוברים לאחרים. התשובה של המודל מציינת מי ענה.", "The chosen engine is tried first; if it fails or gives unrelated results the others take over. The search result says which engine answered.")}</p>
      <fieldset className="stack small" disabled={remote}>
        {rows.map((e) => (
          <label key={e.id} className="check" style={{ flexWrap: "wrap", gap: 6 }}>
            <input type="radio" name="engine" checked={st.engine === e.id} onChange={() => choose(e.id)} />
            <span>{e.name}</span>
            {e.id !== "auto" && <span className="small" style={{ marginInlineStart: "auto" }}>{status(e.id)}</span>}
          </label>
        ))}
      </fieldset>
      <div className="row small" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {!remote && <button type="button" disabled={busy} onClick={check}>{busy ? L("בודק…", "Checking…") : L("בדוק עכשיו", "Check now")}</button>}
        <span className="muted">{st.last ? L(`הבדיקה האחרונה: ${new Date(st.last.at).toLocaleString("he-IL")}`, `Last check: ${new Date(st.last.at).toLocaleString()}`) : L("עוד לא נבדק מאז שהשרת עלה.", "Not checked since the server started.")}</span>
      </div>
      {remote && <p className="muted small">{L("הבדיקה והבחירה במחשב.", "Checking and choosing are done on the computer.")}</p>}
    </div>
  );
}

/**
 * Optional free search keys (Tavily, Brave Search): used first when set, so searches do not depend on engines that
 * block programs. The key is typed on the computer, kept encrypted, and never shown again (only "set").
 */
function SearchKeys() {
  const [set, setSet] = useState<{ tavily: boolean; brave: boolean } | null>(null);
  const [draft, setDraft] = useState({ tavily: "", brave: "" });
  const remote = isRemote();
  useEffect(() => {
    void api<{ tavily: boolean; brave: boolean }>("/api/web-keys").then(setSet, () => undefined);
  }, []);
  if (!set) return null;
  const save = (name: "tavily" | "brave", value: string | null) =>
    void api<{ tavily: boolean; brave: boolean }>("/api/web-keys", { method: "PUT", body: { [name]: value } }).then((x) => { setSet(x); setDraft((d) => ({ ...d, [name]: "" })); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  const rows = [
    { name: "tavily" as const, title: "Tavily", note: L("יש תוכנית חינמית", "Has a free plan") },
    { name: "brave" as const, title: "Brave Search API", note: L("יש תוכנית חינמית", "Has a free plan") },
  ];
  return (
    <div className="stack">
      <h3>{L("מפתח חיפוש חינמי (אופציונלי)", "Free search key (optional)")}</h3>
      <p className="muted small">{L("אם החיפוש הרגיל נחסם או מחזיר תוצאות לא קשורות, אפשר להזין מפתח חינמי. הוא נשמר מוצפן במחשב ומשמש קודם.", "If the usual search is blocked or gives unrelated results, you can enter a free key. It is kept encrypted on this computer and tried first.")}</p>
      {rows.map((r) => (
        <div key={r.name} className="stack small">
          <span>{r.title} · {set[r.name] ? L("מוגדר ✓", "set ✓") : L("לא מוגדר", "not set")} <span className="muted">({r.note})</span></span>
          {!remote && (
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <input dir="ltr" type="password" autoComplete="off" style={{ flex: "1 1 180px", minWidth: 0 }} value={draft[r.name]} onChange={(e) => setDraft({ ...draft, [r.name]: e.target.value })} placeholder={L("הדבק מפתח", "Paste a key")} />
              <button type="button" disabled={!draft[r.name].trim()} onClick={() => save(r.name, draft[r.name])}>{L("שמור", "Save")}</button>
              {set[r.name] && <button type="button" onClick={() => save(r.name, null)}>{L("הסר", "Remove")}</button>}
            </div>
          )}
        </div>
      ))}
      {remote && <p className="muted small">{L("משנים את זה במחשב.", "Changed on the computer.")}</p>}
    </div>
  );
}

/**
 * Settings → Web: the user's own filter for the model's web search in every chat: the search engine's safe search
 * (strict, moderate, off), dark web (.onion) sites through Tor (off by default), and sites never used. Changed on
 * the computer; the phone shows it.
 */
export function WebFilterSection() {
  const [f, setF] = useState<Filter | null>(null);
  const [blocked, setBlocked] = useState("");
  const [tor, setTor] = useState(false);
  useEffect(() => {
    void api<Filter>("/api/web-filter").then((x) => { setF(x); setBlocked(x.blocked.join("\n")); }, () => undefined);
    void api<{ installed: boolean }>("/api/tor").then((t) => setTor(t.installed), () => undefined);
  }, []);
  if (!f) return null;
  const remote = isRemote();
  const save = (next: Partial<Filter>) =>
    void api<Filter>("/api/web-filter", { method: "PUT", body: { ...f, ...next } }).then((x) => { setF(x); setBlocked(x.blocked.join("\n")); toast(L("נשמר.", "Saved.")); }, (e: Error) => toast(e.message));
  return (
    <section className="card stack">
      <h2>{L("חיפוש באינטרנט: סינון", "Web search: filtering")}</h2>
      <p className="muted">{L("חל על החיפוש והקריאה של המודל בכל הצ'אטים. לכל צ'אט יש גם הגדרות משלו (⚙ ליד הגלובוס).", "Applies to the model's web search and reading in every chat. Each chat has its own settings too (⚙ beside the globe).")}</p>
      <fieldset className="stack small" disabled={remote}>
        <legend>{L("חיפוש בטוח (של מנוע החיפוש)", "Safe search (the search engine's)")}</legend>
        {([["strict", L("מחמיר", "Strict")], ["moderate", L("רגיל (ברירת מחדל)", "Moderate (default)")], ["off", L("כבוי — בלי סינון של מנוע החיפוש", "Off: no filtering by the search engine")]] as const).map(([v, label]) => (
          <label key={v} className="check"><input type="radio" name="safe" checked={f.safeSearch === v} onChange={() => save({ safeSearch: v })} />{label}</label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={f.onion} disabled={remote} onChange={(e) => save({ onion: e.target.checked })} />
        {L("לאפשר אתרי .onion (Dark Web) דרך Tor", "Allow .onion (dark web) sites through Tor")}
      </label>
      {f.onion && !tor && <p className="muted small">{L("צריך להתקין Tor: בהגדרות החיפוש של צ'אט (⚙ ליד הגלובוס).", "Tor is needed: install it from a chat's web settings (⚙ beside the globe).")}</p>}
      {f.onion && <p className="muted small">{L("שימו לב: באתרים כאלה יש גם תוכן בלתי חוקי ומסוכן. המודל עדיין מסרב לדברים לא חוקיים, והאחריות על השימוש שלכם.", "Note: such sites also hold illegal and dangerous content. The model still refuses illegal things, and how it is used is up to you.")}</p>}
      <label className="stack small">
        {L("אתרים חסומים — אף צ'אט לא מחפש בהם ולא פותח אותם (שורה לכל אתר)", "Blocked sites: no chat searches or opens them (one per line)")}
        <textarea dir="ltr" rows={4} value={blocked} disabled={remote} onChange={(e) => setBlocked(e.target.value)} placeholder={"example.com\nreddit.com"} />
      </label>
      {!remote && <button type="button" style={{ alignSelf: "start" }} onClick={() => save({ blocked: blocked.split(/[\s,]+/).filter(Boolean) })}>{L("שמור את רשימת החסומים", "Save the blocked list")}</button>}
      {remote && <p className="muted small">{L("משנים את זה במחשב.", "Changed on the computer.")}</p>}
      <SearchEngine />
      <SearchKeys />
    </section>
  );
}
