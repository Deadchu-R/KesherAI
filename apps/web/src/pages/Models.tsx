import { ComfyOnlyKind, ModelKindCard } from "../ModelKinds";
import { ComfySection } from "../ComfySection";
import { useEffect, useState } from "react";
import { BUILT_IN_CATEGORIES, pickSetup, type ResourceLevel } from "@kesher/shared";
import { api } from "../api";
import { getLocale, t } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
import { EstimateDetails, RatingBadge, type Estimate } from "../Estimate";
import { desktop, toast } from "../library";
import { HubBrowser } from "../HubBrowser";
import { DownloadBar, useDownloads } from "../Downloads";
import { Select } from "../ui/Select";

interface Recommended {
  id: string; name: string; repo: string; sizeGb: number; goodForCode: boolean; downloaded: boolean;
  /** Which app's folder the copy on this computer is in (LM Studio, Ollama…), when not KesherAI's. */
  foundIn?: string;
  note: Record<string, string> & { en: string }; estimate: Estimate;
}
interface EngineStatus {
  installed: boolean; version?: string; running: boolean; modelPath?: string; log: string[];
  job?: { phase: string; message: string };
  parallel?: number;
  runningParallel?: number;
  promptTps?: number;
}

/** A newer llama.cpp: shown with an Update button (it downloads only when pressed). */
function EngineUpdate({ onStarted }: { onStarted: (s: EngineStatus) => void }) {
  const [u, setU] = useState<{ installed: string | null; latest: string; newer: boolean } | null>(null);
  useEffect(() => {
    void api<{ installed: string | null; latest: string; newer: boolean }>("/api/engines/llamacpp/update").then(setU, () => undefined);
  }, []);
  if (!u?.newer) return null;
  return (
    <p className="muted small">
      {t("engineUpdate", { from: u.installed ?? "", to: u.latest })}{" "}
      <button type="button" className="as-link" onClick={() => void api<EngineStatus>("/api/engines/llamacpp/update", { method: "POST" }).then((s) => { onStarted(s); setU(null); })}>{t("engineUpdateNow")}</button>
    </p>
  );
}

/** "Start here": the built-in engine and one-click models. */
function StartHere({ onChange }: { onChange: () => void }) {
  const [models, setModels] = useState<Recommended[]>([]);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    void api<Recommended[]>("/api/models/recommended").then(setModels).catch(() => undefined);
    void api<EngineStatus>("/api/engines/llamacpp").then(setEngine).catch(() => undefined);
  };
  useEffect(load, []);
  const busy = !!engine?.job && engine.job.phase !== "error";
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void api<EngineStatus>("/api/engines/llamacpp").then((s) => {
        setEngine(s);
        if (!s.job || s.job.phase === "error") {
          load();
          onChange();
        }
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const run = async (id: string) => {
    setError("");
    try {
      setEngine(await api<EngineStatus>(`/api/models/recommended/${id}/run`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const modelName = engine?.modelPath?.split(/[\\/]/).pop();

  return (
    <>
    <SetUpForMe models={models} busy={busy} onStarted={(s) => { setEngine(s); setError(""); }} onError={setError} />
    <section className="card stack">
      <h2>{t("startHere")}</h2>
      <div className="row engine-row">
        <strong>{t("engine")}</strong>
        <span className="muted">{engine?.installed ? t("engineInstalled", { version: engine.version ?? "" }) : t("engineNotInstalled")}</span>
        {engine?.running && modelName && <span className="pill good">{t("running", { model: modelName })}</span>}
        {engine?.running && (
          <button type="button" onClick={() => void api<EngineStatus>("/api/engines/llamacpp/stop", { method: "POST" }).then(setEngine)}>{t("stopEngine")}</button>
        )}
        {!engine?.installed && !busy && (
          <button type="button" onClick={() => void api<EngineStatus>("/api/engines/llamacpp/install", { method: "POST" }).then(setEngine)}>{t("installEngine")}</button>
        )}
        {engine?.installed && (
          <label className="row parallel-pick" title={t("parallelHint")}>
            <span className="muted small">{t("parallelLabel")}</span>
            <Select
              value={engine.parallel ?? 2}
              onChange={(e) => void api<EngineStatus>("/api/engines/llamacpp/settings", { method: "PUT", body: { parallel: Number(e.target.value) } }).then(setEngine, (err: Error) => setError(err.message))}
            >
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </label>
        )}
      </div>
      {engine?.installed && <EngineUpdate onStarted={setEngine} />}
      {engine?.running && engine.promptTps !== undefined && engine.promptTps < 100 && <p className="error small">{t("engineSlowPrompt", { tps: engine.promptTps })}</p>}
      {engine?.running && engine.runningParallel !== undefined && engine.parallel !== undefined && engine.runningParallel < engine.parallel && <p className="muted small">{t("parallelFellBack")}</p>}
      {engine?.job && (
        <p className={engine.job.phase === "error" ? "error" : "muted"}>
          {engine.job.message}
          {engine.job.phase === "downloading-model" && /^Downloading/.test(engine.job.message) && (
            <> <button type="button" className="as-link" onClick={() => void api<EngineStatus>("/api/models/setup/skip", { method: "POST" }).then(setEngine, (e: Error) => setError(e.message))}>{t("skipForNow")}</button></>
          )}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="rec-grid">
        {models.map((m) => (
          <div key={m.id} className="card rec">
            <div className="row">
              <strong className="grow">{m.name}</strong>
              <span className="muted mono" dir="ltr">{m.sizeGb} GB</span>
            </div>
            <p className="muted">{m.note[getLocale()] ?? m.note.en}</p>
            <div className="row">{m.goodForCode && <span className="pill">{t("goodForCode")}</span>}</div>
            <EstimateDetails e={m.estimate} />
            <button type="button" className={m.estimate.rating === "too-big" ? "" : "primary"} disabled={busy} onClick={() => void run(m.id)}>
              {m.downloaded ? t("run") : t("downloadAndRun")}
            </button>
            {!m.downloaded && <DownloadBar repo={m.repo} />}
          </div>
        ))}
      </div>
      <p className="muted">{t("estimateNote")}</p>
    </section>
    </>
  );
}

/** "Measure speed": how fast this model writes on this computer, kept and shown next to it. */
function BenchButton({ path, onDone }: { path: string; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  return (
    <button
      type="button"
      disabled={state === "busy"}
      title={t("benchHint")}
      onClick={() => {
        setState("busy");
        void api<{ tps: number }>("/api/models/benchmark", { method: "POST", body: { modelPath: path } }).then(
          (r) => { setState(t("benchResult", { tps: r.tps })); onDone(); },
          (e: Error) => { setState("idle"); toast(e.message); },
        );
      }}
    >
      {state === "busy" ? t("benchRunning") : state === "idle" ? t("bench") : state}
    </button>
  );
}

const LEVELS: ResourceLevel[] = ["conservative", "balanced", "extreme"];

/**
 * "Set it up for me": pick how much of the computer to use, and KesherAI
 * chooses the models, downloads them and loads the chat one.
 */
function SetUpForMe(props: { models: Recommended[]; busy: boolean; onStarted: (s: EngineStatus) => void; onError: (m: string) => void }) {
  const [level, setLevel] = useState<ResourceLevel>("balanced");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<{ speech: boolean; meaning: boolean; image: boolean; video: boolean }>({ speech: false, meaning: false, image: false, video: false });
  const rated = props.models.map((m) => ({ ...m, rating: m.estimate.rating }));
  const picks = pickSetup(rated, level);
  useEffect(() => {
    setChecked(new Set([picks.chat, picks.code].filter((x): x is string => !!x)));
  }, [level, props.models.length]);
  if (!props.models.length) return null;
  const roles = new Map<string, string>([
    ...(picks.chat ? [[picks.chat, t("roleChat")] as [string, string]] : []),
    ...(picks.code ? [[picks.code, t("roleCode")] as [string, string]] : []),
  ]);
  const shown = props.models.filter((m) => roles.has(m.id) || checked.has(m.id));
  const total = props.models.filter((m) => checked.has(m.id) && !m.downloaded).reduce((n, m) => n + m.sizeGb, 0);
  const order = [picks.chat, picks.code, ...checked].filter((x, i, a): x is string => !!x && checked.has(x) && a.indexOf(x) === i);
  const start = async () => {
    try {
      // Speech to text and search by meaning download in the background too (see the downloads circle).
      if (extras.speech) await api("/api/speech/stt/setup", { method: "POST" });
      if (extras.meaning) await api("/api/knowledge/semantic/setup", { method: "POST" });
      // Pictures and video: the model that fits this computer, with its extra files.
      for (const kind of ["image", "video"] as const) {
        if (!extras[kind]) continue;
        const r = await api<{ ready: boolean; message?: string }>(`/api/models/setup/media/${kind}`, { method: "POST" });
        toast(r.ready ? t(kind === "image" ? "setupImageReady" : "setupVideoReady") : t(kind === "image" ? "setupImageStarted" : "setupVideoStarted"));
      }
      if (order.length) props.onStarted(await api<EngineStatus>("/api/models/setup", { method: "POST", body: { ids: order } }));
    } catch (e) {
      props.onError((e as Error).message);
    }
  };
  return (
    <section className="card stack setup">
      <div className="row">
        <div className="grow">
          <h2>{t("setupTitle")}</h2>
          <p className="muted">{t("setupHint")}</p>
        </div>
        <button type="button" className="primary" disabled={props.busy || (!order.length && !extras.speech && !extras.meaning && !extras.image && !extras.video)} onClick={() => void start()}>{t("setupStart")}</button>
      </div>
      <div className="row">
        <strong className="grow">{t("resourceUse")}</strong>
        <div className="segmented" role="radiogroup" aria-label={t("resourceUse")}>
          {LEVELS.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={level === l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>
              {t(`level-${l}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">{t(`levelHint-${level}`)}</p>
      <div className="list">
        {shown.map((m) => (
          <label key={m.id} className="row check">
            <input type="checkbox" checked={checked.has(m.id)} onChange={(e) => {
              const next = new Set(checked);
              if (e.target.checked) next.add(m.id); else next.delete(m.id);
              setChecked(next);
            }} />
            <span className="grow"><strong>{m.name}</strong> <span className="muted">· {roles.get(m.id) ?? ""}</span></span>
            <RatingBadge e={m.estimate} />
            <span className="muted mono" dir="ltr">{m.downloaded ? (m.foundIn && m.foundIn !== "KesherAI" ? t("foundIn", { app: m.foundIn }) : t("downloaded")) : `${m.sizeGb} GB`}</span>
          </label>
        ))}
        {!shown.length && <p className="muted">{t("setupNothingFits")}</p>}
        <label className="row check">
          <input type="checkbox" checked={extras.speech} onChange={(e) => setExtras({ ...extras, speech: e.target.checked })} />
          <span className="grow"><strong>{t("setupSpeech")}</strong> <span className="muted">· {t("setupSpeechHint")}</span></span>
        </label>
        <label className="row check">
          <input type="checkbox" checked={extras.meaning} onChange={(e) => setExtras({ ...extras, meaning: e.target.checked })} />
          <span className="grow"><strong>{t("setupMeaning")}</strong> <span className="muted">· {t("setupMeaningHint")}</span></span>
          <span className="muted mono" dir="ltr">0.64 GB</span>
        </label>
        <label className="row check">
          <input type="checkbox" checked={extras.image} onChange={(e) => setExtras({ ...extras, image: e.target.checked })} />
          <span className="grow"><strong>{t("setupImage")}</strong> <span className="muted">· {t("setupImageHint")}</span></span>
          <span className="muted mono" dir="ltr">7–20 GB</span>
        </label>
        <label className="row check">
          <input type="checkbox" checked={extras.video} onChange={(e) => setExtras({ ...extras, video: e.target.checked })} />
          <span className="grow"><strong>{t("setupVideo")}</strong> <span className="muted">· {t("setupVideoHint")}</span></span>
          <span className="muted mono" dir="ltr">~10 GB</span>
        </label>
      </div>
      <p className="muted" dir="auto">{t("setupTotal", { gb: total.toFixed(1) })}</p>
      <p className="muted">{t("setupLater")}</p>
    </section>
  );
}

interface LocalFile { path: string; name: string; size: number; source?: string; gguf?: boolean; estimate?: Estimate; measured?: { tps: number; n: number } }
interface Hardware { ramTotal: number; gpus: Array<{ name: string; vramTotal: number }>; unifiedMemory: boolean }

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** Search Hugging Face, download any file, and load downloaded GGUF files. */
export function ModelsPage() {
  const [local, setLocal] = useState<LocalFile[]>([]);
  const downloads = useDownloads();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [error, setError] = useState("");

  const refreshLocal = () => void api<LocalFile[]>("/api/models/local").then(setLocal).catch(() => undefined);
  const [disk, setDisk] = useState<{ freeGb?: number; totalGb?: number } | null>(null);
  const refreshDisk = () => void api<{ freeGb?: number; totalGb?: number }>("/api/disk").then(setDisk, () => setDisk(null));
  const removeModel = async (f: LocalFile) => {
    if (!confirm(L(`למחוק את ${f.name} (${gb(f.size)})? הקובץ יימחק מהדיסק לצמיתות.`, `Delete ${f.name} (${gb(f.size)})? The file is removed from the disk for good.`))) return;
    try {
      await api("/api/models/delete", { method: "POST", body: { path: f.path } });
      toast(L(`נמחק. התפנו ${gb(f.size)}.`, `Deleted. ${gb(f.size)} freed.`));
      refreshLocal();
      refreshDisk();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  useEffect(() => {
    refreshLocal();
    api<Hardware>("/api/hardware").then(setHw).catch(() => undefined);
  }, []);
  // Refresh the local list when a download finishes.
  const doneCount = downloads.filter((j) => j.status === "done").length;
  useEffect(refreshLocal, [doneCount]);

  // Loading a big model takes a minute or two: the button says so, and a note says when it is ready or what went wrong.
  const [loadingPath, setLoadingPath] = useState("");
  async function loadInLlama(path: string, name?: string) {
    try {
      setError("");
      setLoadingPath(path);
      const r = await api<{ modelId?: string }>("/api/engines/llamacpp/load", { method: "POST", body: { modelPath: path, ...(name ? { name } : {}) } });
      toast(t("modelLoaded", { model: r.modelId ?? name ?? path.split(/[\\/]/).pop() ?? "" }));
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message);
    } finally {
      setLoadingPath("");
    }
  }
  const loadButton = (f: LocalFile) => (
    <button type="button" disabled={!!loadingPath} onClick={() => void loadInLlama(f.path, f.source === "Ollama" ? f.name : undefined)}>{loadingPath === f.path ? t("loading") : t("load")}</button>
  );

  const [tab, setTabState] = useState<string>(() => {
    try {
      return localStorage.getItem("kesher-models-tab") ?? "chat";
    } catch {
      return "chat";
    }
  });
  const setTab = (id: string) => {
    setTabState(id);
    try {
      localStorage.setItem("kesher-models-tab", id);
    } catch {
      // remembered tab is only a convenience
    }
  };
  useEffect(refreshDisk, [doneCount]);
  const tabs: Array<{ id: string; label: string; engine?: string }> = [
    { id: "chat", label: categoryLabel("chat") },
    { id: "image", label: categoryLabel("image") },
    { id: "video", label: categoryLabel("video") },
    { id: "speech-to-text", label: categoryLabel("speech-to-text") },
    { id: "text-to-speech", label: categoryLabel("text-to-speech") },
    { id: "embedding", label: categoryLabel("embedding") },
    { id: "music", label: categoryLabel("music") },
    { id: "3d", label: categoryLabel("3d") },
    { id: "storage", label: t("storage") },
  ];
  const current = tabs.find((x) => x.id === tab) ?? tabs[0]!;
  const IMAGE_NAME = /qwen[-_ ]?image|flux|sdxl|sd[-_]?xl|stable[-_]?diffusion|z[-_]?image/i;
  const ofTab = (f: LocalFile): boolean => {
    const p = f.path.replace(/\\/g, "/");
    if (tab === "image") return p.includes("/image/") || (p.includes("/other/") && IMAGE_NAME.test(p));
    if (tab === "chat") return !!f.gguf && !p.includes("/image/") && !IMAGE_NAME.test(p);
    return p.includes(`/${tab}/`);
  };

  return (
    <div className="page models-page">
      <header className="page-head">
        <h1>{t("models")}</h1>
        {hw && (
          <p className="muted hw-line" dir="auto">
            {hw.gpus.map((g) => `${g.name} · ${gb(g.vramTotal)} VRAM`).join(", ") || t("noGpu")} · {gb(hw.ramTotal)} RAM
            {disk?.freeGb !== undefined && ` · ${t("diskFree", { gb: disk.freeGb.toFixed(0) })}`}
          </p>
        )}
      </header>

      <nav className="tabs" role="tablist" aria-label={t("models")}>
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={tab === x.id ? "on" : ""} onClick={() => setTab(x.id)}>
            {x.label}
            {x.id === "storage" && local.length > 0 && <span className="tab-count">{local.length}</span>}
          </button>
        ))}
      </nav>

      {error && <p className="error">{error}</p>}

      {tab === "chat" && <StartHere onChange={refreshLocal} />}
      {tab === "image" && <ImageStartHere />}
      {tab === "image" && <ComfySection />}
      {(tab === "video" || tab === "speech-to-text" || tab === "text-to-speech" || tab === "embedding") && <ModelKindCard kind={tab} />}
      {(tab === "music" || tab === "3d") && <ComfyOnlyKind kind={tab} />}
      {(tab === "video" || tab === "music" || tab === "3d") && <ComfySection />}
      {current.engine === "soon" && <p className="card muted">{t("engineSoon", { category: current.label })}</p>}

      {tab !== "storage" && (
        <>
          {local.filter(ofTab).length > 0 && (
            <section className="card stack">
              <h2>{t("onThisComputer")}</h2>
              <div className="list">
                {local.filter(ofTab).map((f) => (
                  <div key={f.path} className="row">
                    <span className="mono grow" dir="ltr">{f.name}</span>
                    {f.source && f.source !== "KesherAI" && <span className="pill">{f.source}</span>}
                    <span className="muted mono" dir="ltr">{gb(f.size)}</span>
                    {f.estimate && f.gguf && <RatingBadge e={f.estimate} measured={f.measured} />}
                    {tab === "chat" && f.gguf && <BenchButton path={f.path} onDone={refreshLocal} />}
                    {tab === "chat" && f.gguf && loadButton(f)}
                  </div>
                ))}
              </div>
            </section>
          )}
          <HubBrowser key={tab} fixedCategory={tab} onDownloaded={refreshLocal} />
        </>
      )}

      {tab === "storage" && (
        <section className="card stack">
          <h2>{t("localFiles")}</h2>
          {disk?.freeGb !== undefined && <p className={`small ${disk.freeGb < 10 ? "error" : "muted"}`}>{L(`פנוי בכונן של המודלים: ${disk.freeGb.toFixed(0)} GB מתוך ${disk.totalGb?.toFixed(0) ?? "?"} GB`, `Free on the models drive: ${disk.freeGb.toFixed(0)} GB of ${disk.totalGb?.toFixed(0) ?? "?"} GB`)}</p>}
          <ModelFolders onChange={refreshLocal} />
          <div className="list">
            {local.map((f) => (
              <div key={f.path} className="row">
                <span className="mono grow" dir="ltr">{f.name}</span>
                {f.source && f.source !== "KesherAI" && <span className="pill">{f.source}</span>}
                <span className="muted mono" dir="ltr">{gb(f.size)}</span>
                {f.estimate && f.gguf && <RatingBadge e={f.estimate} measured={f.measured} />}
                {f.gguf && loadButton(f)}
                {(!f.source || f.source === "KesherAI") && (
                  <button type="button" className="icon-btn" title={L("מחיקת הקובץ מהדיסק", "Delete the file from the disk")} aria-label={L(`מחיקת ${f.name}`, `Delete ${f.name}`)} onClick={() => void removeModel(f)}>🗑</button>
                )}
              </div>
            ))}
            {!local.length && <p className="muted">{t("noLocalModels")}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function categoryLabel(id: string): string {
  const c = BUILT_IN_CATEGORIES.find((x) => x.id === id);
  return c ? (c.label[getLocale()] ?? c.label.en) : id;
}

interface Folder { folder: string; source: string }
interface ScanResult extends Folder { added: boolean; totalSize: number; models: Array<{ path: string; name: string; size: number; format: string }> }

/**
 * Where models are downloaded, the other folders KesherAI reads models
 * from, and "Scan this computer" to find models other apps downloaded.
 */
function ModelFolders({ onChange }: { onChange: () => void }) {
  const [info, setInfo] = useState<{ modelsDir: string; defaultDir: string; folders: Folder[] } | null>(null);
  const [dir, setDir] = useState("");
  const [extra, setExtra] = useState("");
  const [scan, setScan] = useState<ScanResult[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<typeof info>("/api/models/folders").then((i) => { setInfo(i); setDir(i?.modelsDir ?? ""); }).catch(() => undefined);
  }, []);
  if (!info) return null;
  const save = async (body: { modelsDir?: string | null; folders?: Folder[] }) => {
    setError("");
    try {
      const next = await api<NonNullable<typeof info>>("/api/models/folders", { method: "PUT", body });
      setInfo(next);
      setDir(next.modelsDir);
      onChange();
      return next;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  };
  const runScan = async () => {
    setScanning(true);
    setError("");
    try { setScan(await api<ScanResult[]>("/api/models/scan", { method: "POST" })); } catch (e) { setError((e as Error).message); }
    setScanning(false);
  };
  const add = async (f: Folder) => {
    const next = await save({ folders: [...info.folders, f] });
    if (next && scan) setScan(scan.map((r) => (r.folder === f.folder ? { ...r, added: true } : r)));
  };
  const pick = (set: (v: string) => void) => desktop() && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && set(f))}>{t("browse")}</button>;
  return (
    <div className="stack folders">
      <label className="stack">
        <strong>{t("modelsFolder")}</strong>
        <span className="muted">{t("modelsFolderHint")}</span>
        <div className="row">
          <input className="grow mono" dir="ltr" value={dir} onChange={(e) => setDir(e.target.value)} />
          {pick(setDir)}
          <button type="button" className="primary" disabled={dir === info.modelsDir} onClick={() => void save({ modelsDir: dir })}>{t("save")}</button>
          {info.modelsDir !== info.defaultDir && <button type="button" onClick={() => void save({ modelsDir: null })}>{t("useDefault")}</button>}
        </div>
      </label>

      <div className="stack">
        <strong>{t("otherFolders")}</strong>
        <span className="muted">{t("otherFoldersHint")}</span>
        {info.folders.map((f) => (
          <div key={f.folder} className="row">
            <span className="pill">{f.source}</span>
            <span className="mono grow" dir="ltr">{f.folder}</span>
            <button type="button" onClick={() => void save({ folders: info.folders.filter((x) => x.folder !== f.folder) })}>{t("remove")}</button>
          </div>
        ))}
        <div className="row">
          <input className="grow mono" dir="ltr" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="D:\AI\models" aria-label={t("otherFolders")} />
          {pick(setExtra)}
          <button type="button" disabled={!extra} onClick={() => void add({ folder: extra, source: "Folder" }).then(() => setExtra(""))}>{t("addFolder")}</button>
          <button type="button" className="primary" disabled={scanning} onClick={() => void runScan()}>{scanning ? t("scanning") : t("scanComputer")}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {scan && (
        <div className="card stack">
          <strong>{scan.length ? t("scanFound", { n: scan.reduce((n, r) => n + r.models.length, 0) }) : t("scanNothing")}</strong>
          {scan.map((r) => (
            <details key={r.folder}>
              <summary className="row">
                <span className="pill">{r.source}</span>
                <span className="mono grow" dir="ltr">{r.folder}</span>
                <span className="muted" dir="ltr">{r.models.length} · {gb(r.totalSize)}</span>
                {r.added ? <span className="pill good">{t("added")}</span> : (
                  <button type="button" className="primary" onClick={(e) => { e.preventDefault(); void add({ folder: r.folder, source: r.source }); }}>{t("useThese")}</button>
                )}
              </summary>
              <div className="list">
                {r.models.map((m) => (
                  <div key={m.path} className="row muted">
                    <span className="mono grow" dir="ltr">{m.name}</span>
                    <span className="mono" dir="ltr">{m.format}</span>
                    <span className="mono" dir="ltr">{gb(m.size)}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
          <span className="muted">{t("scanNote")}</span>
        </div>
      )}
    </div>
  );
}

interface RecImage {
  id: string; name: string; repo: string; file: string; note: { en: string; he?: string };
  downloaded: boolean; engineInstalled: boolean; vramGb: number;
  extras: Array<{ name: string; sizeGb: number; have: boolean }>;
}

/** Image models that run in the built-in engine on this computer: download, then use from any chat. */
function ImageStartHere() {
  const [list, setList] = useState<RecImage[]>([]);
  const [active, setActive] = useState("");
  const [msg, setMsg] = useState("");
  const downloads = useDownloads();
  const done = downloads.filter((j) => j.status === "done").length;
  useEffect(() => {
    void api<RecImage[]>("/api/models/recommended-images").then(setList).catch(() => undefined);
    void api<{ activeModels: Record<string, string> }>("/api/settings").then((s) => setActive(s.activeModels.image ?? "")).catch(() => undefined);
  }, [done]);
  const idOf = (m: RecImage) => `sdcpp/${m.repo}/${m.file}`;
  const download = async (m: RecImage) => {
    setMsg("");
    try {
      await api("/api/downloads", { method: "POST", body: { repo: m.repo, path: m.file, category: "image" } });
      setMsg(t("imageDownloading"));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const use = async (m: RecImage) => {
    const s = await api<{ activeModels: Record<string, string> }>("/api/settings");
    await api("/api/settings", { method: "PUT", body: { activeModels: { ...s.activeModels, image: idOf(m) } } });
    setActive(idOf(m));
  };
  if (!list.length) return null;
  return (
    <section className="card stack">
      <h2>{t("imageStartHere")}</h2>
      <p className="muted">{t("imageStartHint")}</p>
      <div className="rec-grid">
        {list.map((m) => {
          const missing = m.extras.filter((e) => !e.have);
          return (
            <div key={m.id} className="card rec">
              <strong>{m.name}</strong>
              <p className="muted">{m.note[getLocale() as "he"] ?? m.note.en}</p>
              {missing.length > 0 && <p className="muted small">{t("imageExtras", { gb: missing.reduce((n, e) => n + e.sizeGb, 0).toFixed(1) })}</p>}
              {m.downloaded ? (
                active === idOf(m) ? <span className="pill good" style={{ alignSelf: "flex-start" }}>{t("imageActive")}</span> : <button type="button" className="primary" onClick={() => void use(m)}>{t("imageUse")}</button>
              ) : (
                <button type="button" className="primary" onClick={() => void download(m)}>{t("download")}</button>
              )}
              {!m.downloaded && <DownloadBar repo={m.repo} file={m.file} />}
            </div>
          );
        })}
      </div>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}
