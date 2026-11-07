import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { refreshPluginUi } from "../plugins";
import { getLocale, t, type StringKey } from "../i18n";
import { LibraryStore } from "./LibraryStore";

/** One store item (a GitHub repository with a kesher-plugin.json). */
export interface StoreItem {
  repo: string;
  description: string;
  stars: number;
  url: string;
  updatedAt: string;
  topics: string[];
  author: string;
  official: boolean;
}

const CATEGORIES = ["all", "theme", "mod", "tool", "model", "integration", "program"] as const;
type Category = (typeof CATEGORIES)[number];

const categoryOf = (it: StoreItem): Category[] => it.topics.flatMap((x) => (/^kesherai-(theme|mod|tool|model|integration|program)s?$/.exec(x)?.[1] as Category | undefined) ?? []);

/** The community store: official items (checked by KesherAI) and community items (anyone's, unchecked), with a warning. */
export function CommunityPage() {
  const he = getLocale() === "he";
  const [kind, setKind] = useState<"plugins" | "prompts" | "skills">("plugins");
  const kinds = (
    <div className="store-kinds row seg" role="tablist">
      {([["plugins", he ? "תוספים ומודים" : "Plugins and mods"], ["prompts", he ? "פרומפטים ופרסונות" : "Prompts and personas"], ["skills", he ? "מיומנויות" : "Skills"]] as const).map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{label}</button>
      ))}
    </div>
  );
  if (kind !== "plugins") {
    return (
      <div className="page store">
        <header className="store-hero">
          <h1>{t("stTitle")}</h1>
        </header>
        {kinds}
        <LibraryStore kind={kind} />
      </div>
    );
  }
  return <PluginStore kinds={kinds} />;
}

function PluginStore({ kinds }: { kinds: React.ReactNode }) {
  const [tab, setTab] = useState<"official" | "community">("official");
  const [data, setData] = useState<{ official: StoreItem[]; community: StoreItem[] } | null>(null);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>("all");
  const [confirm, setConfirm] = useState<StoreItem | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const loadInstalled = () => api<Array<{ id: string }>>("/api/plugins").then((l) => setInstalled(new Set(l.map((p) => p.id))), () => undefined);
  useEffect(() => {
    api<{ official: StoreItem[]; community: StoreItem[] }>("/api/plugins/catalog").then(setData, (e: Error) => setError(e.message));
    void loadInstalled();
  }, []);

  const list = useMemo(() => {
    const items = data?.[tab] ?? [];
    const needle = q.trim().toLowerCase();
    return items.filter((it) => (cat === "all" || categoryOf(it).includes(cat)) && (!needle || `${it.repo} ${it.description} ${it.topics.join(" ")}`.toLowerCase().includes(needle)));
  }, [data, tab, q, cat]);

  const install = async (it: StoreItem) => {
    setBusy(it.repo);
    setMsg("");
    try {
      const r = await api<{ id: string }>("/api/plugins/install", { method: "POST", body: { source: it.repo } });
      await loadInstalled();
      await refreshPluginUi();
      setMsg(t("stInstalledMsg", { name: r.id }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy("");
      setConfirm(null);
      setUnderstood(false);
    }
  };
  const isInstalled = (it: StoreItem) => installed.has(it.repo.split("/")[1]?.toLowerCase() ?? "") || installed.has(it.repo.split("/")[1] ?? "");

  return (
    <div className="page store">
      <header className="store-hero">
        <h1>{t("stTitle")}</h1>
        <p className="muted">{t("stIntro")}</p>
      </header>
      {kinds}

      <div className="store-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "official"} className={tab === "official" ? "on" : ""} onClick={() => setTab("official")}>
          <span className="seal" aria-hidden>✓</span> {t("stOfficial")} {data ? <span className="count">{data.official.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "community"} className={tab === "community" ? "on" : ""} onClick={() => setTab("community")}>
          {t("stCommunity")} {data ? <span className="count">{data.community.length}</span> : null}
        </button>
      </div>

      {tab === "community" && (
        <div className="store-warning" role="note">
          <strong>{t("stWarnTitle")}</strong>
          <p>{t("stWarnText")}</p>
        </div>
      )}

      <div className="store-tools">
        <input className="grow" placeholder={t("stSearch")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("stSearch")} />
        <div className="store-cats" role="group" aria-label={t("stCategory")}>
          {CATEGORIES.map((c) => (
            <button key={c} type="button" className={cat === c ? "on" : ""} onClick={() => setCat(c)}>{t(`stCat_${c}` as StringKey)}</button>
          ))}
        </div>
      </div>

      {msg && <p className="store-msg" role="status">{msg}</p>}
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">{t("barChecking")}</p>}

      {data && list.length === 0 && (
        <div className="store-empty">
          {tab === "official" && data.official.length === 0 ? (
            <>
              <strong>{t("stOfficialEmpty")}</strong>
              <p className="muted">{t("stOfficialEmptyText")}</p>
            </>
          ) : tab === "community" && data.community.length === 0 ? (
            <>
              <strong>{t("stCommunityEmpty")}</strong>
              <p className="muted">{t("stPublishHint")}</p>
            </>
          ) : (
            <p className="muted">{t("noModelsMatch")}</p>
          )}
        </div>
      )}

      <div className="store-grid">
        {list.map((it) => (
          <article key={it.repo} className={`store-card ${it.official ? "official" : ""}`}>
            <div className="store-card-top">
              <span className="store-avatar" aria-hidden>{it.repo.split("/")[1]?.[0]?.toUpperCase()}</span>
              <div className="store-card-name">
                <strong dir="ltr">{it.repo.split("/")[1]}</strong>
                <span className="muted small" dir="ltr">{it.author}{it.official ? "" : ""}</span>
              </div>
              {it.official ? <span className="pill good">✓ {t("stOfficialTag")}</span> : <span className="pill">{t("stCommunityTag")}</span>}
            </div>
            <p className="store-desc" dir="auto">{it.description || t("stNoDesc")}</p>
            <div className="store-meta small muted">
              <span>★ {it.stars}</span>
              <span>{t("stUpdated", { date: it.updatedAt.slice(0, 10) })}</span>
              {categoryOf(it).map((c) => <span key={c} className="pill">{t(`stCat_${c}` as StringKey)}</span>)}
            </div>
            <div className="store-actions">
              {isInstalled(it) ? (
                <span className="muted small">✓ {t("plInstalledTag")}</span>
              ) : (
                <button type="button" className="primary" disabled={!!busy} onClick={() => (it.official ? void install(it) : setConfirm(it))}>
                  {busy === it.repo ? t("plInstalling") : t("plInstall")}
                </button>
              )}
              <a href={it.url} target="_blank" rel="noreferrer">{t("stViewCode")}</a>
            </div>
          </article>
        ))}
      </div>

      <p className="muted small store-foot">{t("stPublishHint")} · <a href="#/plugins">{t("pluginsNav")}</a></p>

      {confirm && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirm(null)}>
          <div className="dialog card store-confirm" role="alertdialog" aria-modal="true" aria-label={t("stConfirmTitle")} onClick={(e) => e.stopPropagation()}>
            <strong>{t("stConfirmTitle")}</strong>
            <p dir="ltr" className="mono small">{confirm.repo}</p>
            <p>{t("stConfirmText")}</p>
            <a href={confirm.url} target="_blank" rel="noreferrer">{t("stViewCode")}</a>
            <label className="row stc-check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>{t("stUnderstand")}</span>
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setConfirm(null)}>{t("cancel")}</button>
              <button type="button" className="primary" disabled={!understood || !!busy} onClick={() => void install(confirm)}>{t("stInstallAnyway")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
