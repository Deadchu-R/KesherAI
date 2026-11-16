import { useEffect, useState } from "react";
import { api, isRemote, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Pick { id: string; type: "movie" | "series"; name: string; poster?: string; year?: string; why?: string }
interface State { rated: number; letterboxd: number; mine: Array<{ title: string; rating?: number }>; picks: { movie: Pick[]; series: Pick[]; t?: number } }

/** Films and series for her taste: Letterboxd and ratings in, recommendations out, and a Stremio row of them. */
export function StremioPage() {
  const [st, setSt] = useState<State | null>(null);
  const [title, setTitle] = useState("");
  const [stars, setStars] = useState(4);
  const [busy, setBusy] = useState("");
  const [addon, setAddon] = useState("");
  const load = () => void api<State>("/api/stremio").then(setSt, (e: Error) => toast(e.message));
  useEffect(load, []);
  const run = async (what: string, p: Promise<unknown>) => {
    setBusy(what);
    try {
      await p;
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const makeAddon = async () => {
    // One of KesherAI's app keys, named Stremio (revocable in Settings → For developers).
    const r = await api<{ key: string }>("/api/api-keys", { method: "POST", body: { name: "Stremio" } });
    setAddon(`${location.protocol}//127.0.0.1:${location.port || "7420"}/stremio/${r.key}/manifest.json`);
  };
  if (!st) return <div className="page"><h1>{L("סרטים וסדרות בשבילך", "Films and series for you")}</h1><p className="muted">…</p></div>;
  const picks = [...st.picks.movie, ...st.picks.series];
  return (
    <div className="page stremio-page">
      <h1>{L("סרטים וסדרות בשבילך", "Films and series for you")}</h1>
      <section className="card">
        <strong>{L("הטעם שלך", "Your taste")}</strong>
        <p className="small">{L(`${st.letterboxd} מ-Letterboxd · ${st.rated - st.letterboxd} דירוגים ב-KesherAI`, `${st.letterboxd} from Letterboxd · ${st.rated - st.letterboxd} ratings in KesherAI`)}</p>
        <div className="row wrap">
          <label className="button">{L("ייבוא מ-Letterboxd (ratings.csv)", "Import from Letterboxd (ratings.csv)")}
            <input type="file" hidden accept=".csv,text/csv" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await run("import", api<{ added: number; total: number }>("/api/stremio/letterboxd", { method: "POST", body: { csv: await f.text() } }).then((r) => toast(L(`נוספו ${r.added}, סה״כ ${r.total}`, `${r.added} added, ${r.total} in all`))));
            }} />
          </label>
          <input className="grow" value={title} dir="auto" placeholder={L("לדרג שם של סרט או סדרה…", "Rate a film or series by name…")} aria-label={L("שם", "Title")} onChange={(e) => setTitle(e.target.value)} />
          <select value={stars} aria-label={L("כוכבים", "Stars")} onChange={(e) => setStars(Number(e.target.value))}>
            {[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5].map((n) => <option key={n} value={n}>{`${n}★`}</option>)}
          </select>
          <button type="button" disabled={!title.trim() || !!busy} onClick={() => void run("rate", api("/api/stremio/rate", { method: "POST", body: { title, rating: stars } }).then(() => setTitle("")))}>{L("דירוג", "Rate")}</button>
        </div>
        <p className="muted small">{L("ב-Letterboxd: הגדרות ← Import & Export ← Export your data, ובקובץ: ratings.csv.", "In Letterboxd: Settings → Import & Export → Export your data; the file ratings.csv.")}</p>
      </section>
      <section className="card">
        <div className="row">
          <strong className="grow">{L("ההמלצות", "Recommendations")}</strong>
          <button type="button" className="primary" disabled={!!busy || !st.rated} onClick={() => void run("refresh", api("/api/stremio/refresh", { method: "POST" }))}>{busy === "refresh" ? L("כותב המלצות…", "Writing recommendations…") : L("המלצות חדשות", "New recommendations")}</button>
          {!isRemote() && <button type="button" disabled={!!busy} onClick={() => void makeAddon().catch((e: Error) => toast(e.message))}>{L("להוסיף ל-Stremio", "Add to Stremio")}</button>}
        </div>
        {addon && (
          <div className="snippet">
            <pre dir="ltr">{addon}</pre>
            <div className="row">
              <a className="button primary" href={addon.replace(/^https?:/, "stremio:")}>{L("לפתוח ב-Stremio", "Open in Stremio")}</a>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(addon)}>{L("העתק", "Copy")}</button>
            </div>
            <p className="muted small">{L("ב-Stremio תופיע שורה \"KesherAI: for you\". הכתובת כוללת מפתח שאפשר לבטל בהגדרות ← למפתחים.", "Stremio shows a \"KesherAI: for you\" row. The address holds a key you can revoke in Settings → For developers.")}</p>
          </div>
        )}
        {picks.length ? (
          <div className="stremio-grid">
            {picks.map((p) => (
              <a key={p.id} className="stremio-pick" href={`https://www.imdb.com/title/${p.id}/`} target="_blank" rel="noreferrer">
                {p.poster ? <img src={withToken(`/api/stremio/poster/${p.id}`)} alt="" loading="lazy" /> : <div className="stremio-noposter" aria-hidden />}
                <strong dir="auto">{p.name}</strong>
                <span className="muted small" dir="auto">{[p.year, p.type === "series" ? L("סדרה", "series") : "", p.why].filter(Boolean).join(" · ")}</span>
              </a>
            ))}
          </div>
        ) : (
          <p className="muted small">{st.rated ? L("לחצו על \"המלצות חדשות\".", "Press \"New recommendations\".") : L("קודם ייבוא מ-Letterboxd או כמה דירוגים.", "First import from Letterboxd or rate a few titles.")}</p>
        )}
      </section>
    </div>
  );
}
