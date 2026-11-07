import { useEffect, useState } from "react";
import { BUILT_IN_CATEGORIES } from "@kesher/shared";
import { api, withToken } from "../api";
import { getLocale, t } from "../i18n";

interface HubModel { repo: string; category?: string; downloads: number; likes: number; gated: boolean | string }
interface HubFile { path: string; size: number; sha256?: string }
interface Job { id: string; label: string; status: string; received: number; total?: number; speed: number; error?: string }
interface LocalFile { path: string; name: string; size: number }
interface Hardware { ramTotal: number; gpus: Array<{ name: string; vramTotal: number }>; unifiedMemory: boolean }

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const WEIGHTS = /\.(gguf|safetensors|ckpt|bin|pt|pth|onnx)$/i;

/** Search Hugging Face, download any file, and load downloaded GGUF files. */
export function ModelsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<HubModel[]>([]);
  const [open, setOpen] = useState<{ repo: string; category?: string; files: HubFile[] } | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [local, setLocal] = useState<LocalFile[]>([]);
  const [hw, setHw] = useState<Hardware | null>(null);
  const [error, setError] = useState("");

  const refreshLocal = () => void api<LocalFile[]>("/api/models/local").then(setLocal).catch(() => undefined);

  useEffect(() => {
    refreshLocal();
    api<Hardware>("/api/hardware").then(setHw).catch(() => undefined);
    const es = new EventSource(withToken("/api/downloads/events"));
    es.onmessage = (e) => {
      const job = JSON.parse(e.data as string) as Job;
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      if (job.status === "done") refreshLocal();
    };
    return () => es.close();
  }, []);

  async function search() {
    setError("");
    const tag = BUILT_IN_CATEGORIES.find((c) => c.id === category)?.huggingFacePipelineTags?.[0];
    const params = new URLSearchParams({ q: query, ...(tag ? { pipelineTag: tag } : {}) });
    try {
      setResults(await api<HubModel[]>(`/api/hub/search?${params}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function showFiles(m: HubModel) {
    const files = await api<HubFile[]>(`/api/hub/files?repo=${encodeURIComponent(m.repo)}`);
    setOpen({ repo: m.repo, ...(m.category ? { category: m.category } : {}), files: files.filter((f) => WEIGHTS.test(f.path)) });
  }

  async function download(file: HubFile) {
    if (!open) return;
    try {
      await api("/api/downloads", { method: "POST", body: { repo: open.repo, path: file.path, category: open.category ?? "other" } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadInLlama(path: string) {
    try {
      await api("/api/engines/llamacpp/load", { method: "POST", body: { modelPath: path } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const label = (id: string) => {
    const c = BUILT_IN_CATEGORIES.find((x) => x.id === id);
    return c ? (c.label[getLocale()] ?? c.label.en) : id;
  };

  return (
    <div className="page">
      <h1>{t("models")}</h1>
      {hw && (
        <div className="card row muted">
          <strong style={{ color: "var(--text)" }}>{t("yourHardware")}</strong>
          {hw.gpus.map((g) => <span key={g.name} className="mono">{g.name} · {gb(g.vramTotal)} VRAM</span>)}
          <span className="mono">{gb(hw.ramTotal)} RAM{hw.unifiedMemory ? " (unified)" : ""}</span>
        </div>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchHub")} aria-label={t("searchHub")} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">—</option>
          {BUILT_IN_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{label(c.id)}</option>)}
        </select>
        <button type="submit" className="primary">{t("search")}</button>
      </form>
      {error && <p className="error">{error}</p>}

      <div className="card list">
        {results.map((m) => (
          <div key={m.repo} className="row">
            <span className="mono grow" dir="ltr" style={{ textAlign: "start" }}>{m.repo}</span>
            {m.category && <span className="pill">{label(m.category)}</span>}
            {m.gated ? <span className="pill bad">gated</span> : null}
            <span className="muted">↓ {m.downloads.toLocaleString()}</span>
            <button type="button" onClick={() => void showFiles(m)}>{t("files")}</button>
          </div>
        ))}
      </div>

      {open && (
        <section className="card">
          <h2 className="mono" dir="ltr">{open.repo}</h2>
          <div className="list">
            {open.files.map((f) => (
              <div key={f.path} className="row">
                <span className="mono grow" dir="ltr">{f.path}</span>
                <span className="muted mono">{gb(f.size)}</span>
                {/\.(ckpt|bin|pt|pth)$/i.test(f.path) && <span className="pill bad" title="Pickle format can run code">pickle</span>}
                <button type="button" onClick={() => void download(f)}>{t("download")}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>{t("downloads")}</h2>
        <div className="list">
          {Object.values(jobs).reverse().map((j) => (
            <div key={j.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="row"><span className="grow mono" dir="ltr">{j.label}</span><span className="pill">{j.status}</span></div>
              {j.total ? <div className="bar"><div style={{ width: `${(100 * j.received) / j.total}%` }} /></div> : null}
              <span className="muted mono">{gb(j.received)}{j.total ? ` / ${gb(j.total)}` : ""}{j.speed ? ` · ${(j.speed / 1024 ** 2).toFixed(1)} MB/s` : ""}</span>
              {j.error && <span className="error">{j.error}</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{t("localFiles")}</h2>
        <div className="list">
          {local.map((f) => (
            <div key={f.path} className="row">
              <span className="mono grow" dir="ltr">{f.name}</span>
              <span className="muted mono">{gb(f.size)}</span>
              {f.name.endsWith(".gguf") && <button type="button" onClick={() => void loadInLlama(f.path)}>{t("loadInLlama")}</button>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
