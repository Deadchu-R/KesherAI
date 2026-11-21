/**
 * Search and download models from Hugging Face: a query, a category (chat, image, voice…), the files of each
 * repository with their size and whether they fit this computer, and a download button that hands the file to
 * the core's DownloadManager.
 */
import { useEffect, useState } from "react";
import { BUILT_IN_CATEGORIES } from "@kesher/shared";
import { api } from "./api";
import { getLocale, t, type StringKey, he$ } from "./i18n";
import { RatingBadge, type Estimate } from "./Estimate";
import { DownloadBar, useDownloads } from "./Downloads";
import { Select } from "./ui/Select";

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
  /** The run mark for this computer, worked out by the server from the parameter count (see downloads/fit.ts). */
  fit?: ServerFit;
}
/** The server's run mark: fully on the graphics card, partly, too big, or unknown size. */
interface ServerFit { fit: "gpu" | "partial" | "too-big" | "unknown"; needGb: number; sizeGb?: number; gpuShare: number }
interface HubFile { path: string; size: number; estimate?: Estimate; fit?: ServerFit; quant?: string; kind?: "llm" | "mmproj" | "diffusion" | "audio" | "other" }

/** Task chips: a KesherAI category, and for vision the Hub task that marks chat models that see pictures. */
const TASKS: Array<{ id: string; category: string; pipelineTag?: string; he: string; en: string }> = [
  { id: "chat", category: "chat", pipelineTag: "text-generation", he: "צ'אט", en: "Chat" },
  { id: "vision", category: "chat", pipelineTag: "image-text-to-text", he: "רואה תמונות", en: "Vision" },
  { id: "image", category: "image", he: "תמונות", en: "Images" },
  { id: "video", category: "video", he: "וידאו", en: "Video" },
  { id: "stt", category: "speech-to-text", he: "דיבור לטקסט", en: "Speech to text" },
  { id: "tts", category: "text-to-speech", he: "קול", en: "Voice" },
];
/** Size chips, by the size of a 4-bit build (or the stored weights). */
const SIZES = [0, 4, 8, 16, 32];
/** Licences that allow free use, also commercial. */
const OPEN_LICENSE = /^(apache-2\.0|mit|bsd(-\d-clause)?|cc-by-4\.0|cc0-1\.0|openrail(\+\+|-m)?|creativeml-openrail-m|unlicense|gpl-3\.0|lgpl-3\.0|afl-3\.0)$/i;

type Sort = "downloads" | "likes" | "trending" | "created" | "modified";
const SORTS: Sort[] = ["trending", "downloads", "likes", "created", "modified"];
const FORMATS = ["", "gguf", "safetensors", "diffusers", "onnx"];
const WEIGHTS = /\.(gguf|safetensors|ckpt|bin|pt|pth|onnx)$/i;

const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const compact = (n: number) => new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

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
export function HubBrowser({ onDownloaded, fixedCategory, initialQuery }: { onDownloaded?: () => void; fixedCategory?: string; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [category, setCategory] = useState(fixedCategory ?? "chat");
  // The Hub task within the category (vision = chat models that see pictures); empty: the category's first.
  const [task, setTask] = useState("");
  const [maxGb, setMaxGb] = useState(0);
  const [openOnly, setOpenOnly] = useState(false);
  const [format, setFormat] = useState((fixedCategory ?? "chat") === "chat" ? "gguf" : "");
  const [sort, setSort] = useState<Sort>("trending");
  const [results, setResults] = useState<HubModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // What to show: everything, what runs here, or only what runs fast (fits the graphics card).
  const [fitFilter, setFitFilter] = useState<"all" | "runs" | "fast">(() => {
    try {
      const v = localStorage.getItem("kesher-fit-filter");
      if (v === "all" || v === "runs" || v === "fast") return v;
      return localStorage.getItem("kesher-only-runs") === "0" ? "all" : "runs";
    } catch {
      return "runs";
    }
  });
  const onlyRuns = fitFilter !== "all";
  const [hw, setHw] = useState<Hw | null>(null);
  useEffect(() => {
    void api<Hw>("/api/hardware").then(setHw).catch(() => undefined);
  }, []);
  const chooseFilter = (v: "all" | "runs" | "fast") => {
    setFitFilter(v);
    try {
      localStorage.setItem("kesher-fit-filter", v);
    } catch {
      // only a convenience
    }
  };
  const shown = results?.filter((m) => {
    if (hw && fitFilter !== "all") {
      const f = fitOf(m, hw, category).fit;
      if (fitFilter === "fast" ? f !== "fast" : f === "no") return false;
    }
    if (maxGb && !(m.fit?.sizeGb && m.fit.sizeGb <= maxGb)) return false;
    if (openOnly && !(m.license && OPEN_LICENSE.test(m.license))) return false;
    return true;
  }) ?? null;
  const tasks = TASKS.filter((x) => !fixedCategory || x.category === fixedCategory);
  // The chip that is on: the chosen task, else the category's first.
  const taskOn = task || tasks.find((k) => k.category === category)?.id;

  const label = (id: string) => {
    const c = BUILT_IN_CATEGORIES.find((x) => x.id === id);
    return c ? (c.label[getLocale()] ?? c.label.en) : id;
  };

  const search = async () => {
    setError("");
    setLoading(true);
    const tag = TASKS.find((x) => x.id === task)?.pipelineTag ?? BUILT_IN_CATEGORIES.find((c) => c.id === category)?.huggingFacePipelineTags?.[0];
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
  }, [category, task, format, sort]);
  const pickTask = (id: string) => {
    const x = TASKS.find((k) => k.id === id);
    setTask(id);
    if (x && x.category !== category) {
      setCategory(x.category);
      setFormat(x.category === "chat" ? "gguf" : "");
    }
  };

  return (
    <section className="card stack hub">
      <h2>{t("hubTitle")}</h2>
      <p className="muted small">{t("hubHint")}</p>
      <form className="hub-filters" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchHub")} aria-label={t("searchHub")} />
        <Select value={category} onChange={(e) => { setCategory(e.target.value); setTask(""); }} aria-label={t("category")}>
          <option value="">{t("anyCategory")}</option>
          {BUILT_IN_CATEGORIES.filter((c) => c.huggingFacePipelineTags?.length).map((c) => <option key={c.id} value={c.id}>{label(c.id)}</option>)}
        </Select>
        <Select value={format} onChange={(e) => setFormat(e.target.value)} aria-label={t("format")}>
          {FORMATS.map((f) => <option key={f} value={f}>{f ? f.toUpperCase() : t("anyFormat")}</option>)}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("sortBy")}>
          {SORTS.map((s) => <option key={s} value={s}>{t(`sort-${s}`)}</option>)}
        </Select>
        <button type="submit" className="primary">{t("search")}</button>
      </form>
      {tasks.length > 1 && (
        <div className="hub-chips" role="group" aria-label={L("משימה", "Task")}>
          {tasks.map((x) => (
            <button key={x.id} type="button" className={`chip-text ${taskOn === x.id ? "on" : ""}`} aria-pressed={taskOn === x.id} onClick={() => pickTask(x.id)}>{L(x.he, x.en)}</button>
          ))}
        </div>
      )}
      <div className="hub-chips" role="group" aria-label={L("גודל ורישיון", "Size and licence")}>
        {SIZES.map((g) => (
          <button key={g} type="button" className={`chip-text ${maxGb === g ? "on" : ""}`} aria-pressed={maxGb === g} onClick={() => setMaxGb(g)}>
            {g ? L(`עד ${g} GB`, `Up to ${g} GB`) : L("כל גודל", "Any size")}
          </button>
        ))}
        <button type="button" className={`chip-text ${openOnly ? "on" : ""}`} aria-pressed={openOnly} onClick={() => setOpenOnly(!openOnly)} title={L("Apache, MIT ודומים: מותר גם לשימוש מסחרי", "Apache, MIT and similar: free also for commercial use")}>
          {L("רישיון פתוח", "Open licence")}
        </button>
      </div>
      <div className="row hub-fit-filter" role="group" aria-label={L("לפי החומרה שלך", "By your hardware")}>
        <span className="muted small">{L("מה להראות:", "Show:")}</span>
        <div className="segmented">
          {(["fast", "runs", "all"] as const).map((v) => (
            <button key={v} type="button" className={fitFilter === v ? "on" : ""} aria-pressed={fitFilter === v} onClick={() => chooseFilter(v)}>
              {v === "fast" ? L("🟢 נכנס לכרטיס", "🟢 Fits my GPU") : v === "runs" ? L("🟡 ירוץ", "🟡 Runs") : L("הכול", "All")}
            </button>
          ))}
        </div>
        {hw && <span className="muted small grow" dir="auto">{L("זוהה", "Detected")}: {hw.gpus.length ? hw.gpus.map((g) => `${g.name ?? "GPU"} ${(g.vramTotal / 1024 ** 3).toFixed(0)} GB`).join(", ") : L("בלי כרטיס מסך", "no graphics card")} · RAM {(hw.ramTotal / 1024 ** 3).toFixed(0)} GB</span>}
      </div>
      {format === "gguf" && <p className="muted small">{t("ggufHint")}</p>}
      {error && <p className="error">{error}</p>}
      {loading && !results && <p className="muted">{t("loading")}</p>}
      {shown && shown.length === 0 && <p className="muted">{results?.length ? t("noneRunHere", { n: results.length }) : t("noResults")}</p>}
      <div className="hub-list">
        {shown?.map((m) => (
          <HubRow key={m.repo} m={m} fit={hw ? fitOf(m, hw, category) : undefined} open={open === m.repo} onlyRuns={onlyRuns} onToggle={() => setOpen(open === m.repo ? null : m.repo)} label={label} {...(onDownloaded ? { onDownloaded } : {})} />
        ))}
      </div>
    </section>
  );
}

function HubRow({ m, fit, open, onToggle, label, onDownloaded, onlyRuns }: { m: HubModel; fit?: Fit; open: boolean; onToggle: () => void; label: (id: string) => string; onDownloaded?: () => void; onlyRuns: boolean }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [files, setFiles] = useState<HubFile[] | null>(null);
  const [error, setError] = useState("");
  const [started, setStarted] = useState<string[]>([]);
  useEffect(() => {
    if (!open || files) return;
    void api<{ summary: string }>(`/api/hub/summary?repo=${encodeURIComponent(m.repo)}`).then((r) => setSummary(r.summary)).catch(() => setSummary(""));
    void api<HubFile[]>(`/api/hub/files?repo=${encodeURIComponent(m.repo)}${m.pipelineTag ? `&pipelineTag=${encodeURIComponent(m.pipelineTag)}` : ""}`)
      .then((f) => setFiles(f.filter((x) => WEIGHTS.test(x.path)).sort((a, b) => a.size - b.size)))
      .catch((e: Error) => setError(e.message));
  }, [open]);
  const [plan, setPlan] = useState<{ file: HubFile; data?: Plan } | null>(null);
  const askDownload = async (f: HubFile, drive?: string) => {
    setError("");
    setPlan((p) => (p && p.file.path === f.path && drive ? p : { file: f }));
    try {
      const params = new URLSearchParams({ repo: m.repo, path: f.path, category: m.category ?? "other", size: String(f.size), ...(drive ? { drive } : {}) });
      setPlan({ file: f, data: await api<Plan>(`/api/downloads/plan?${params}`) });
    } catch (e) {
      setPlan(null);
      setError((e as Error).message);
    }
  };
  const download = async (f: HubFile, drive?: string) => {
    setError("");
    try {
      await api("/api/downloads", { method: "POST", body: { repo: m.repo, path: f.path, category: m.category ?? "other", ...(drive ? { drive } : {}) } });
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
      <button type="button" className="hub-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="hub-row-name" dir="ltr"><strong>{name}</strong> <span className="muted">{author}</span></span>
        <span className="hub-row-stats muted" dir="ltr">
          <span title={t("sort-likes")}>♥ {compact(m.likes)}</span>
          <span title={t("sort-downloads")}>↓ {compact(m.downloads)}</span>
          {m.lastModified && <span title={t("sort-modified")}>{ago(m.lastModified)}</span>}
        </span>
        <span className="hub-row-facts muted">
          {fit && <FitBadge fit={fit} />}
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
            {onlyRuns && files && files.some((f) => !fileRuns(m, f)) && (
              <p className="muted small">{t("hiddenFiles", { n: files.filter((f) => !fileRuns(m, f)).length })}</p>
            )}
            {files?.filter((f) => !onlyRuns || fileRuns(m, f)).map((f) => (
              <div key={f.path} className="row hub-file">
                <span className="mono grow" dir="ltr">{f.path}</span>
                <span className="muted mono" dir="ltr">{gb(f.size)}</span>
                {f.quant && <span className="pill mono" dir="ltr">{f.quant}</span>}
                {f.kind === "mmproj" && <span className="pill" title={L("קובץ נלווה שנותן למודל הצ'אט לראות תמונות", "An add-on file that lets the chat model see pictures")}>{L("תוסף ראייה", "Vision add-on")}</span>}
                {f.fit && <FitMark fit={f.fit} />}
                {f.estimate && f.fit?.fit !== "too-big" && <RatingBadge e={f.estimate} />}
                {/\.(ckpt|bin|pt|pth)$/i.test(f.path) && <span className="pill bad" title={t("pickleWarning")}>pickle</span>}
                {/(^|[-_./ ])mlx([-_./ ]|$)/i.test(`${m.repo}/${f.path}`) && <span className="pill bad" title={t("planMlx")}>{t("macOnly")}</span>}
                <button type="button" className={started.includes(f.path) ? "" : "primary"} disabled={started.includes(f.path)} onClick={() => void askDownload(f)}>
                  {started.includes(f.path) ? t("dl-queued") : t("download")}
                </button>
                <DownloadBar repo={m.repo} file={f.path} />
                {f.kind === "llm" && !/-0000[2-9]-of-|-000[1-9]\d-of-/i.test(f.path) && <UseInChat repo={m.repo} file={f.path} />}
              </div>
            ))}
            {plan && <PlanBox plan={plan.data} onDrive={(d) => void askDownload(plan.file, d)} onCancel={() => setPlan(null)} onConfirm={() => void download(plan.file, plan.data?.drive)} />}
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
  /** Where the file can go (the download folder, and the heavy-data drive for chat models), and the one chosen. */
  drives?: Array<{ id: "models" | "heavy"; dir: string; freeGb?: number; default: boolean }>;
  drive?: string;
}

/**
 * What a download really involves, before it starts: the file, the extra
 * files and engine needed to run it, the total, and the free disk space.
 */
function PlanBox({ plan, onDrive, onCancel, onConfirm }: { plan?: Plan; onDrive: (id: string) => void; onCancel: () => void; onConfirm: () => void }) {
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
      {plan.drives && plan.drives.length > 1 && (
        <div className="stack hub-drives" role="radiogroup" aria-label={L("לאיזה כונן", "Which drive")}>
          <span className="muted small">{L("לאיזה כונן להוריד", "Download to which drive")}</span>
          {plan.drives.map((d) => (
            <label key={d.id} className="row hub-drive">
              <input type="radio" name="hub-drive" checked={plan.drive === d.id} onChange={() => onDrive(d.id)} />
              <span className="grow">{d.id === "heavy" ? L("כונן הנתונים הכבדים", "Heavy-data drive") : L("תיקיית ההורדות", "Download folder")}
                <span className="muted small mono hub-drive-dir" dir="ltr">{d.dir}</span>
              </span>
              {d.freeGb !== undefined && <span className="muted small">{t("diskFree", { gb: d.freeGb.toFixed(0) })}</span>}
            </label>
          ))}
        </div>
      )}
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

interface Hw { platform: string; ramTotal: number; gpus: Array<{ name?: string; vramTotal: number }>; unifiedMemory: boolean }

const MLX = /(^|[-_./ ])mlx([-_./ ]|$)/i;

/** How a model fits this computer: fast (in the graphics card), runs (slower, partly in system memory), no, or unknown size. */
type Fit = { fit: "fast" | "ok" | "no" | "unknown"; why: string };

/**
 * Whether a Hugging Face model runs on this computer, and how well, judged
 * from its size (parameters, or the "7B" in its name) and the memory here:
 * a 4-bit file is about 0.6 GB per billion parameters, plus room to work.
 * Not an Apple-only MLX build elsewhere, and a format the engines run.
 */
function fitOf(m: HubModel, hw: Hw, category: string): Fit {
  const mac = hw.platform === "darwin";
  if (!mac && (MLX.test(m.repo) || m.library === "mlx" || m.tags.includes("mlx"))) return { fit: "no", why: L("גרסת MLX: רק למק", "An MLX build: Mac only") };
  if (category === "chat" && !m.tags.includes("gguf") && m.library !== "gguf") return { fit: "no", why: L("לא בפורמט GGUF שהמנוע מריץ", "Not GGUF, which the engine runs") };
  // The server's mark (parameter count from the Hub, context and working memory included) when it has one.
  if (m.fit && m.fit.fit !== "unknown") {
    const need = `~${m.fit.needGb.toFixed(1)} GB`;
    const why = L(`צריך ${need} (בגרסת 4 ביט, עם הקשר)`, `Needs ${need} (4-bit build, with context)`);
    return { fit: m.fit.fit === "gpu" ? "fast" : m.fit.fit === "partial" ? "ok" : "no", why };
  }
  const p = /^(\d+(?:\.\d+)?)([BM])$/.exec(m.parameters ?? "") ?? /(?:^|[-_ /])(\d+(?:\.\d+)?)([BM])(?:[-_ ]|$)/i.exec(m.repo.replace(/-A\d+(?:\.\d+)?B/i, ""));
  if (!p) return { fit: "unknown", why: L("הגודל לא ידוע: פתח כדי לראות כל קובץ", "Size unknown: open it to see each file") };
  const billions = Number(p[1]) / (p[2]!.toUpperCase() === "M" ? 1000 : 1);
  const needGb = billions * 0.6 + 0.8;
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramTotal)) / 1024 ** 3;
  const ram = hw.ramTotal / 1024 ** 3;
  const need = `~${needGb.toFixed(1)} GB`;
  if (hw.unifiedMemory) {
    if (needGb <= ram * 0.6) return { fit: "fast", why: L(`צריך ${need}; נכנס בזיכרון`, `Needs ${need}; fits in memory`) };
    if (needGb <= ram * 0.75) return { fit: "ok", why: L(`צריך ${need}; צפוף בזיכרון`, `Needs ${need}; tight in memory`) };
    return { fit: "no", why: L(`צריך ${need}; יותר מהזיכרון`, `Needs ${need}; more than the memory`) };
  }
  if (vram && needGb <= vram * 0.92) return { fit: "fast", why: L(`צריך ${need}; נכנס בכרטיס המסך (${vram.toFixed(0)} GB)`, `Needs ${need}; fits the graphics card (${vram.toFixed(0)} GB)`) };
  // The engines can spill from the graphics card into system memory, more slowly.
  if (needGb <= vram + ram * 0.6) return { fit: "ok", why: L(`צריך ${need}; חלק בזיכרון הרגיל, איטי יותר`, `Needs ${need}; partly in system memory, slower`) };
  return { fit: "no", why: L(`צריך ${need}; יותר ממה שיש במחשב`, `Needs ${need}; more than this computer has`) };
}

/** 🟢 / 🟡 / 🔴 on a search result, with the reason. */
function FitBadge({ fit }: { fit: Fit }) {
  const [icon, text, cls] =
    fit.fit === "fast" ? ["🟢", L("כולו על כרטיס המסך", "Runs fully on GPU"), "good"] : fit.fit === "ok" ? ["🟡", L("חלקית על הכרטיס (איטי יותר)", "Partly on GPU (slower)"), "warn"] : fit.fit === "no" ? ["🔴", L("גדול מדי", "Too big"), "bad"] : ["⚪", L("גודל לא ידוע", "Size unknown"), ""];
  return <span className={`pill ${cls} hub-fit`} title={fit.why}>{icon} {text}</span>;
}

/** The run mark on one file: fully on the graphics card, partly, or too big, with the memory it needs in the tip. */
function FitMark({ fit }: { fit: ServerFit }) {
  if (fit.fit === "unknown") return null;
  const [icon, text, cls] =
    fit.fit === "gpu" ? ["🟢", L("כולו על כרטיס המסך", "Runs fully on GPU"), "good"] : fit.fit === "partial" ? ["🟡", L("חלקית על הכרטיס (איטי יותר)", "Partly on GPU (slower)"), "warn"] : ["🔴", L("גדול מדי", "Too big"), "bad"];
  const tip = fit.fit === "partial"
    ? L(`צריך ~${fit.needGb} GB; ${Math.round(fit.gpuShare * 100)}% בכרטיס, השאר בזיכרון הרגיל`, `Needs ~${fit.needGb} GB; ${Math.round(fit.gpuShare * 100)}% on the GPU, the rest in system memory`)
    : L(`צריך ~${fit.needGb} GB כולל הקשר`, `Needs ~${fit.needGb} GB with context`);
  return <span className={`pill ${cls} hub-fit`} title={tip}>{icon} {text}</span>;
}

/**
 * "Use in chat" once a chat model's download is done: loads the file in the chat engine on the PC and opens the chat
 * (also from the phone, which only asks the PC to load it).
 */
function UseInChat({ repo, file }: { repo: string; file: string }) {
  const done = useDownloads().find((j) => j.status === "done" && j.dest && j.url?.includes(`/${repo}/resolve/`) && decodeURIComponent(j.url).endsWith(`/${file}`));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!done?.dest) return null;
  const use = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/engines/llamacpp/load", { method: "POST", body: { modelPath: done.dest } });
      location.hash = "#/";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="primary" disabled={busy} onClick={() => void use()}>{busy ? t("loading") : L("להשתמש בצ'אט", "Use in chat")}</button>
      {error && <span className="error small">{error}</span>}
    </>
  );
}

/** Whether one file of a model runs here: not too big, not MLX, not a pickle-only format. */
function fileRuns(m: HubModel, f: HubFile): boolean {
  if (MLX.test(`${m.repo}/${f.path}`)) return false;
  if (f.fit ? f.fit.fit === "too-big" : f.estimate?.rating === "too-big") return false;
  return /\.(gguf|safetensors)$/i.test(f.path);
}
