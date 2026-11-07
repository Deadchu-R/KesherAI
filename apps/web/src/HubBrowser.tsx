import { useEffect, useState } from "react";
import { BUILT_IN_CATEGORIES } from "@kesher/shared";
import { api } from "./api";
import { getLocale, t, type StringKey } from "./i18n";
import { RatingBadge, type Estimate } from "./Estimate";

interface HubModel {
  repo: string;
  author: string;
  category?: string;
  pipelineTag?: string;
  downloads: number;
  likes: number;
  gated: boolean | string;
  createdAt?: string;
  lastModified?: string;
  library?: string;
  license?: string;
  baseModel?: string;
  parameters?: string;
  tags: string[];
}
interface HubFile { path: string; size: number; estimate?: Estimate }

type Sort = "downloads" | "likes" | "trending" | "created" | "modified";
const SORTS: Sort[] = ["trending", "downloads", "likes", "created", "modified"];
const FORMATS = ["", "gguf", "safetensors", "diffusers", "onnx"];
const WEIGHTS = /\.(gguf|safetensors|ckpt|bin|pt|pth|onnx)$/i;

const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const compact = (n: number) => new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
function ago(iso?: string): string {
  if (!iso) return "";
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (days < 1) return rtf.format(0, "day");
  if (days < 30) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}

/**
 * Browse Hugging Face: search, filter by category and format, sort by
 * trending, downloads, likes, date added or last update. Each result is one
 * compact line with the key facts; opening it shows a short description from
 * the model card and the files to download, rated for this computer.
 *
 * @param props.onDownloaded - Called after a download starts.
 */
export function HubBrowser({ onDownloaded, fixedCategory }: { onDownloaded?: () => void; fixedCategory?: string }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(fixedCategory ?? "chat");
  const [format, setFormat] = useState((fixedCategory ?? "chat") === "chat" ? "gguf" : "");
  const [sort, setSort] = useState<Sort>("trending");
  const [results, setResults] = useState<HubModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const label = (id: string) => {
    const c = BUILT_IN_CATEGORIES.find((x) => x.id === id);
    return c ? (c.label[getLocale()] ?? c.label.en) : id;
  };

  const search = async () => {
    setError("");
    setLoading(true);
    const tag = BUILT_IN_CATEGORIES.find((c) => c.id === category)?.huggingFacePipelineTags?.[0];
    const params = new URLSearchParams({ sort, ...(query ? { q: query } : {}), ...(tag ? { pipelineTag: tag } : {}), ...(format ? { filter: format } : {}) });
    try {
      setResults(await api<HubModel[]>(`/api/hub/search?${params}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  // Show something useful straight away, and search again when a filter changes.
  useEffect(() => {
    void search();
  }, [category, format, sort]);

  return (
    <section className="card stack hub">
      <h2>{t("hubTitle")}</h2>
      <p className="muted small">{t("hubHint")}</p>
      <form className="hub-filters" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchHub")} aria-label={t("searchHub")} />
        {!fixedCategory && (
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t("category")}>
            <option value="">{t("anyCategory")}</option>
            {BUILT_IN_CATEGORIES.filter((c) => c.huggingFacePipelineTags?.length).map((c) => <option key={c.id} value={c.id}>{label(c.id)}</option>)}
          </select>
        )}
        <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label={t("format")}>
          {FORMATS.map((f) => <option key={f} value={f}>{f ? f.toUpperCase() : t("anyFormat")}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("sortBy")}>
          {SORTS.map((s) => <option key={s} value={s}>{t(`sort-${s}`)}</option>)}
        </select>
        <button type="submit" className="primary">{t("search")}</button>
      </form>
      {format === "gguf" && <p className="muted small">{t("ggufHint")}</p>}
      {error && <p className="error">{error}</p>}
      {loading && !results && <p className="muted">{t("loading")}</p>}
      {results && results.length === 0 && <p className="muted">{t("noResults")}</p>}
      <div className="hub-list">
        {results?.map((m) => (
          <HubRow key={m.repo} m={m} open={open === m.repo} onToggle={() => setOpen(open === m.repo ? null : m.repo)} label={label} {...(onDownloaded ? { onDownloaded } : {})} />
        ))}
      </div>
    </section>
  );
}

function HubRow({ m, open, onToggle, label, onDownloaded }: { m: HubModel; open: boolean; onToggle: () => void; label: (id: string) => string; onDownloaded?: () => void }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [files, setFiles] = useState<HubFile[] | null>(null);
  const [error, setError] = useState("");
  const [started, setStarted] = useState<string[]>([]);
  useEffect(() => {
    if (!open || files) return;
    void api<{ summary: string }>(`/api/hub/summary?repo=${encodeURIComponent(m.repo)}`).then((r) => setSummary(r.summary)).catch(() => setSummary(""));
    void api<HubFile[]>(`/api/hub/files?repo=${encodeURIComponent(m.repo)}`)
      .then((f) => setFiles(f.filter((x) => WEIGHTS.test(x.path)).sort((a, b) => a.size - b.size)))
      .catch((e: Error) => setError(e.message));
  }, [open]);
  const [plan, setPlan] = useState<{ file: HubFile; data?: Plan } | null>(null);
  const askDownload = async (f: HubFile) => {
    setError("");
    setPlan({ file: f });
    try {
      const params = new URLSearchParams({ repo: m.repo, path: f.path, category: m.category ?? "other", size: String(f.size) });
      setPlan({ file: f, data: await api<Plan>(`/api/downloads/plan?${params}`) });
    } catch (e) {
      setPlan(null);
      setError((e as Error).message);
    }
  };
  const download = async (f: HubFile) => {
    setError("");
    try {
      await api("/api/downloads", { method: "POST", body: { repo: m.repo, path: f.path, category: m.category ?? "other" } });
      setStarted((s) => [...s, f.path]);
      setPlan(null);
      onDownloaded?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [author, name] = m.repo.includes("/") ? m.repo.split("/") : ["", m.repo];
  const facts = [m.parameters, m.category ? label(m.category) : m.pipelineTag, m.library, m.license].filter(Boolean);

  return (
    <div className={`hub-row ${open ? "open" : ""}`}>
      <button type="button" className="hub-head" onClick={onToggle} aria-expanded={open}>
        <span className="hub-name" dir="ltr"><strong>{name}</strong> <span className="muted">{author}</span></span>
        <span className="hub-stats muted" dir="ltr">
          <span title={t("sort-likes")}>♥ {compact(m.likes)}</span>
          <span title={t("sort-downloads")}>↓ {compact(m.downloads)}</span>
          {m.lastModified && <span title={t("sort-modified")}>{ago(m.lastModified)}</span>}
        </span>
        <span className="hub-facts muted">
          {facts.join(" · ")}
          {m.gated ? <span className="pill warn">{t("gated")}</span> : null}
        </span>
      </button>
      {open && (
        <div className="hub-body stack">
          {summary === null ? <p className="muted">{t("loading")}</p> : summary ? <p className="hub-summary" dir="auto">{summary}</p> : <p className="muted">{t("noDescription")}</p>}
          <div className="row muted small">
            {m.createdAt && <span>{t("added")}: {new Date(m.createdAt).toLocaleDateString(getLocale())}</span>}
            {m.baseModel && <span dir="ltr">· {t("basedOn")} {m.baseModel}</span>}
            <span className="grow" />
            <a href={`https://huggingface.co/${m.repo}`} target="_blank" rel="noreferrer">{t("openOnHub")}</a>
          </div>
          {m.gated ? <p className="muted small">{t("gatedHint")}</p> : null}
          {error && <p className="error">{error}</p>}
          {files === null && !error && <p className="muted">{t("loading")}</p>}
          {files?.length === 0 && <p className="muted">{t("noWeightFiles")}</p>}
          <div className="list">
            {files?.map((f) => (
              <div key={f.path} className="row hub-file">
                <span className="mono grow" dir="ltr">{f.path}</span>
                <span className="muted mono" dir="ltr">{gb(f.size)}</span>
                {f.estimate && <RatingBadge e={f.estimate} />}
                {/\.(ckpt|bin|pt|pth)$/i.test(f.path) && <span className="pill bad" title={t("pickleWarning")}>pickle</span>}
                {/(^|[-_./ ])mlx([-_./ ]|$)/i.test(`${m.repo}/${f.path}`) && <span className="pill bad" title={t("planMlx")}>{t("macOnly")}</span>}
                <button type="button" className={started.includes(f.path) ? "" : "primary"} disabled={started.includes(f.path)} onClick={() => void askDownload(f)}>
                  {started.includes(f.path) ? t("dl-queued") : t("download")}
                </button>
              </div>
            ))}
            {plan && <PlanBox plan={plan.data} onCancel={() => setPlan(null)} onConfirm={() => void download(plan.file)} />}
          </div>
        </div>
      )}
    </div>
  );
}

interface Plan {
  items: Array<{ name: string; sizeGb: number; have: boolean; why: "model" | "extra" | "engine" }>;
  totalGb: number;
  /** `mlx`: the file runs only on Mac computers. */
  warning?: "mlx";
  freeGb?: number;
  fitsDisk: boolean;
  estimate?: Estimate;
}

/**
 * What a download really involves, before it starts: the file, the extra
 * files and engine needed to run it, the total, and the free disk space.
 */
function PlanBox({ plan, onCancel, onConfirm }: { plan?: Plan; onCancel: () => void; onConfirm: () => void }) {
  if (!plan) return <div className="plan card"><p className="muted">{t("loading")}</p></div>;
  const size = (g: number) => (g >= 1 ? `${g.toFixed(1)} GB` : `${Math.round(g * 1024)} MB`);
  return (
    <div className="plan card stack" role="dialog" aria-label={t("planTitle")}>
      <strong>{t("planTitle")}</strong>
      <ul className="plan-items">
        {plan.items.map((i) => (
          <li key={i.name} className={i.have ? "have" : ""}>
            <span className="grow" dir="auto">{t(`plan-${i.why}` as StringKey)}: <span className="mono" dir="ltr">{i.name}</span></span>
            <span className="mono" dir="ltr">{i.have ? t("planHave") : size(i.sizeGb)}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <strong className="grow">{t("planTotal", { size: size(plan.totalGb) })}</strong>
        {plan.freeGb !== undefined && <span className={plan.fitsDisk ? "muted" : "error"}>{t("diskFree", { gb: plan.freeGb.toFixed(0) })}</span>}
      </div>
      {plan.warning === "mlx" && <p className="error">{t("planMlx")}</p>}
      {plan.estimate && plan.estimate.rating === "too-big" && <p className="error">{t("planTooBig")}</p>}
      {!plan.fitsDisk && <p className="error">{t("planNoSpace")}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={!plan.fitsDisk} onClick={onConfirm}>{t("planDownload", { size: size(plan.totalGb) })}</button>
        <button type="button" onClick={onCancel}>{t("cancel")}</button>
      </div>
    </div>
  );
}
