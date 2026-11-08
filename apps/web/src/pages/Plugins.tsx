import { useEffect, useState } from "react";
import { api } from "../api";
import { refreshPluginUi } from "../plugins";
import { getLocale, t } from "../i18n";

interface Installed {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  permissions: string[];
  uses?: string[];
  status: "active" | "disabled" | "error";
  error?: string;
  ui?: { pages: unknown[]; panels: unknown[]; styles: unknown[]; composerActions: unknown[] };
  programs?: Array<{ name: string }>;
  removable?: boolean;
}

interface CatalogItem {
  repo: string;
  description: string;
  stars: number;
  url: string;
}

/** Installed plugins and mods (on/off, remove), installing from Git, and the public catalog. */
export function PluginsPage() {
  const [list, setList] = useState<Installed[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = () => api<Installed[]>("/api/plugins").then(setList, () => undefined);
  useEffect(() => {
    void load();
    api<{ official: CatalogItem[]; community: CatalogItem[] }>("/api/plugins/catalog").then((c) => setCatalog([...c.official, ...c.community]), (e: Error) => setCatalogError(e.message));
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await load();
      await refreshPluginUi();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const install = (src: string) => run(`install:${src}`, () => api("/api/plugins/install", { method: "POST", body: { source: src } }));

  const adds = (p: Installed) =>
    [
      p.ui?.pages.length ? t("plAddsPages", { n: p.ui.pages.length }) : "",
      p.ui?.panels.length ? t("plAddsPanels", { n: p.ui.panels.length }) : "",
      p.ui?.styles.length ? t("plAddsStyles") : "",
      p.ui?.composerActions.length ? t("plAddsActions", { n: p.ui.composerActions.length }) : "",
      p.programs?.length ? t("plAddsPrograms", { list: p.programs.map((x) => x.name).join(", ") }) : "",
    ].filter(Boolean);

  const installedIds = new Set(list.map((p) => p.id));

  return (
    <div className="page plugins">
      <h1>{t("pluginsTitle")}</h1>
      <p className="muted">{t("pluginsIntro")}</p>

      <section className="card">
        <h2>{t("plInstallTitle")}</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (source.trim()) void install(source.trim()).then(() => setSource("")); }}>
          <input className="grow" dir="ltr" placeholder="owner/repo  ·  https://github.com/owner/repo" value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("plInstallTitle")} />
          <button type="submit" className="primary" disabled={!source.trim() || !!busy}>{busy.startsWith("install:") ? t("plInstalling") : t("plInstall")}</button>
        </form>
        <p className="muted small">{t("plInstallNote")}</p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h2>{t("plInstalled")}</h2>
        {list.length === 0 && <p className="muted">{t("plNone")}</p>}
        <ul className="plugin-list">
          {list.map((p) => (
            <li key={p.id} className={p.status}>
              <div className="pl-main">
                <strong>{p.name}</strong> <span className="muted small" dir="ltr">v{p.version}{p.author ? ` · ${p.author}` : ""}</span>
                {p.description && <p className="muted small" dir="auto">{p.description}</p>}
                {adds(p).length > 0 && <p className="small">{adds(p).join(" · ")}</p>}
                {p.permissions.length > 0 && (
                  <p className="small pl-perms">
                    {t("plPermissions")} {p.permissions.map((x) => <span key={x} className="pill bad">{t(x === "shell" ? "plPermShell" : x === "network" ? "plPermNetwork" : "plPermFiles")}</span>)}
                  </p>
                )}
                {(p.uses?.length ?? 0) > 0 && (
                  <p className="small">
                    {getLocale() === "he" ? "משתמש במודלים המקומיים:" : "Uses your local models:"} {p.uses!.map((x) => <span key={x} className="pill">{getLocale() === "he" ? ({ chat: "צ'אט", image: "תמונות", speech: "דיבור" } as Record<string, string>)[x] ?? x : x}</span>)}
                  </p>
                )}
                {p.status === "error" && <p className="error small">{p.error}</p>}
              </div>
              <div className="pl-actions">
                <label className="switch">
                  <input type="checkbox" checked={p.status !== "disabled"} disabled={!!busy} onChange={(e) => void run(`toggle:${p.id}`, () => api(`/api/plugins/${p.id}`, { method: "PUT", body: { enabled: e.target.checked } }))} />
                  <span>{p.status === "disabled" ? t("plOff") : t("plOn")}</span>
                </label>
                {p.removable && <button type="button" className="link-btn" disabled={!!busy} onClick={() => void run(`rm:${p.id}`, () => api(`/api/plugins/${p.id}`, { method: "DELETE" }))}>{t("remove")}</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>{t("plCatalog")}</h2>
        <p className="muted small">{t("plCatalogNote")}</p>
        {catalogError && <p className="muted">{catalogError}</p>}
        {catalog && catalog.length === 0 && <p className="muted">{t("plCatalogEmpty")}</p>}
        <ul className="plugin-list">
          {catalog?.map((c) => (
            <li key={c.repo}>
              <div className="pl-main">
                <a href={c.url} target="_blank" rel="noreferrer" dir="ltr"><strong>{c.repo}</strong></a> <span className="muted small">★ {c.stars}</span>
                {c.description && <p className="muted small" dir="auto">{c.description}</p>}
              </div>
              <div className="pl-actions">
                {installedIds.has(c.repo.split("/")[1] ?? "") ? (
                  <span className="muted small">{t("plInstalledTag")}</span>
                ) : (
                  <button type="button" disabled={!!busy} onClick={() => void install(c.repo)}>{busy === `install:${c.repo}` ? t("plInstalling") : t("plInstall")}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>{t("plMake")}</h2>
        <p className="muted" dir="auto">{t("plMakeText")}</p>
        <a href="https://github.com/Deadchu-R/KesherAI/blob/main/docs/PLUGINS.md" target="_blank" rel="noreferrer">{t("plGuide")}</a>
      </section>
    </div>
  );
}
