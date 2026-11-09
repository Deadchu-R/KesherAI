import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Installed { id: string; name: string; version: string; folders: string[]; files: number; bytes: number; installedAt: string }
interface Entry { id: string; name: string; description: string; category: string; version: string; sizeMb: number; local: boolean; installed: Installed | null; installing: boolean; error: string | null }
interface ListResult { catalog: Entry[]; custom: Installed[] }

const CATEGORY: Record<string, [string, string]> = {
  engine: ["מנועי משחק", "Game engines"],
  language: ["שפות", "Languages"],
  web: ["ווב", "Web"],
  ai: ["AI", "AI"],
};

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes > 10 * 1048576 ? 0 : 1)} MB`;

/**
 * The library store: documentation and reference code downloaded once to this
 * computer, so the models work from it with no internet. Each library becomes
 * a knowledge base the chats search.
 */
export function LibrariesPage() {
  const [data, setData] = useState<ListResult | null>(null);
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("refs/heads/main");
  const [path, setPath] = useState("docs");
  const load = () => api<ListResult>("/api/libraries").then(setData, (e: Error) => toast(e.message));
  useEffect(() => {
    void load();
  }, []);
  // While something installs, look again every two seconds.
  const busy = data?.catalog.some((c) => c.installing) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [busy]);
  const install = async (body: Record<string, string>) => {
    try {
      await api("/api/libraries/install", { method: "POST", body });
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    await api(`/api/libraries/${encodeURIComponent(id)}`, { method: "DELETE" }).catch((e: Error) => toast(e.message));
    await load();
  };
  const groups = [...new Set((data?.catalog ?? []).map((c) => c.category))];
  return (
    <div className="page stack">
      <header className="stack">
        <h1>{L("חנות ספריות", "Library store")}</h1>
        <p className="muted">{L("תיעוד וקוד ייחוס שיורדים פעם אחת למחשב. אחרי זה המודלים מחפשים בהם בלי אינטרנט (כל ספרייה הופכת לבסיס ידע).", "Documentation and reference code downloaded once to this computer. After that the models search them with no internet (each library becomes a knowledge base).")}</p>
      </header>
      {!data && <p className="muted">…</p>}
      {groups.map((g) => (
        <section key={g} className="stack">
          <h2>{L(...(CATEGORY[g] ?? [g, g]))}</h2>
          <div className="lib-grid">
            {data!.catalog.filter((c) => c.category === g).map((c) => (
              <div key={c.id} className="card lib-card stack">
                <div className="row">
                  <strong className="grow" dir="ltr">{c.name}</strong>
                  <span className="pill">{c.version}</span>
                </div>
                <p className="small muted" dir="ltr">{c.description}</p>
                {c.installed ? (
                  <p className="small">✅ {L("מותקן", "Installed")} · {c.installed.files} {L("קבצים", "files")} · {mb(c.installed.bytes)}</p>
                ) : (
                  <p className="small muted">{c.local ? L("מהמנוע שמותקן אצלך, בלי הורדה", "From your installed engine, no download") : `≈ ${c.sizeMb} MB ${L("להורדה", "to download")}`}</p>
                )}
                {c.error && <p className="small bad" dir="auto">⚠ {c.error}</p>}
                <div className="row">
                  {c.installing ? (
                    <span className="small"><span className="spinner" aria-hidden /> {L("מוריד ומכין…", "Downloading and preparing…")}</span>
                  ) : c.installed ? (
                    <>
                      <button type="button" onClick={() => void install({ id: c.id })}>{L("עדכן", "Update")}</button>
                      <button type="button" onClick={() => void remove(c.id)}>{L("הסר", "Remove")}</button>
                    </>
                  ) : (
                    <button type="button" className="primary" onClick={() => void install({ id: c.id })}>{c.local ? L("הוסף", "Add") : L("הורד", "Download")}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="card stack">
        <h2>{L("ספרייה משלך מ-GitHub", "Your own library from GitHub")}</h2>
        <p className="small muted">{L("כל מאגר ציבורי: גרסה (branch או tag) ותיקיית התיעוד שבו.", "Any public repository: a version (branch or tag) and its documentation folder.")}</p>
        <div className="row wrap">
          <input dir="ltr" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repository" />
          <input dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="refs/tags/v1.0" />
          <input dir="ltr" value={path} onChange={(e) => setPath(e.target.value)} placeholder="docs" />
          <button type="button" className="primary" disabled={!/^[\w.-]+\/[\w.-]+$/.test(repo)} onClick={() => void install({ repo, ref, path, name: repo })}>{L("הורד", "Download")}</button>
        </div>
        {(data?.custom ?? []).map((c) => (
          <div key={c.id} className="row">
            <span className="grow" dir="ltr">{c.name} ({c.version}) · {c.files} {L("קבצים", "files")} · {mb(c.bytes)}</span>
            <button type="button" onClick={() => void remove(c.id)}>{L("הסר", "Remove")}</button>
          </div>
        ))}
      </section>
    </div>
  );
}
