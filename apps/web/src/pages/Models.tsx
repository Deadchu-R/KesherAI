import { GpuCheck } from "../GpuCheck";
import { ComfyOnlyKind, ModelKindCard } from "../ModelKinds";
import { ComfySection } from "../ComfySection";
import { useEffect, useState } from "react";
import { BUILT_IN_CATEGORIES, pickSetup, type ResourceLevel } from "@kesher/shared";
import { api } from "../api";
import { getLocale, t } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
import { EstimateDetails, RatingBadge, type Estimate } from "../Estimate";
import { toast } from "../library";
import { HubBrowser } from "../HubBrowser";
import { DownloadBar, useDownloads } from "../Downloads";
import { Select } from "../ui/Select";
import { ChatsAtOnce } from "../ChatsAtOnce";
import { CalibrateButton, FitButton } from "../FitPreview";
import { ModelFolders } from "../ModelFolders";

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
  slotTokens?: number;
  mtpDraft?: number;
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
        {engine?.installed && <ChatsAtOnce />}
        {engine?.installed && (
          <label className="row parallel-pick" title={L("מודלים עם ראש MTP (כמו Qwen3.8) מנחשים כמה מילים קדימה, והמודל בודק אותן: כותב מהר יותר, אבל לוקח קצת זיכרון מהשיחה. פחות ניחושים = פחות זיכרון.", "Models with an MTP head (like Qwen3.8) guess a few words ahead and the model checks them: it writes faster, but takes some memory from the chat. Fewer guesses = less memory.")}>
            <span className="muted small">{L("ניחוש קדימה (MTP)", "Guess ahead (MTP)")}</span>
            <Select
              value={engine.mtpDraft === undefined ? "auto" : String(engine.mtpDraft)}
              onChange={(e) => void api<EngineStatus>("/api/engines/llamacpp/settings", { method: "PUT", body: { mtpDraft: e.target.value === "auto" ? null : Number(e.target.value) } }).then(setEngine, (err: Error) => setError(err.message))}
            >
              <option value="auto">{L("אוטומטי (2)", "Automatic (2)")}</option>
              {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              <option value="0">{L("כבוי", "Off")}</option>
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

interface LocalFile { path: string; name: string; size: number; source?: string; gguf?: boolean; estimate?: Estimate; measured?: { tps: number; n: number }; /** A model in several files: how many of them are here. */ parts?: { have: number; of: number } }
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
  /** Vision for a model: its repository's mmproj, downloaded beside it after a yes (the engine loads it with the model). */
  const addVision = async (f: { path: string; name: string }) => {
    try {
      const v = await api<{ has: boolean; offer?: { name: string; size: number } }>(`/api/models/vision?path=${encodeURIComponent(f.path)}`);
      if (v.has) return toast(L("למודל הזה כבר יש ראייה: הוא רואה תמונות כשהוא טעון.", "This model already has vision: it sees pictures when loaded."));
      if (!v.offer) return toast(L("למאגר של המודל הזה אין קובץ ראייה (mmproj): הוא לא יכול לראות תמונות.", "This model's repository has no vision file (mmproj): it cannot see pictures."));
      if (!confirm(L(`להוריד ${v.offer.name} (${gb(v.offer.size)}) כדי שהמודל יראה תמונות? אחרי ההורדה טענו את המודל מחדש.`, `Download ${v.offer.name} (${gb(v.offer.size)}) so the model sees pictures? Load the model again after the download.`))) return;
      await api("/api/models/vision", { method: "POST", body: { path: f.path } });
      toast(L("ההורדה התחילה (בעיגול ההורדות).", "The download started (in the downloads circle)."));
    } catch (e) {
      toast((e as Error).message);
    }
  };
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
        {hw && <GpuCheck />}
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
                    {f.parts && f.parts.have < f.parts.of && <span className="pill warn" title={getLocale() === "he" ? "ההורדה לא הסתיימה. מצאו את המודל למטה ולחצו שוב על הורדה: היא ממשיכה מאיפה שנעצרה." : "The download did not finish. Find the model below and press Download again: it continues where it stopped."}>{getLocale() === "he" ? `חסרים חלקים (${f.parts.have}/${f.parts.of})` : `Parts missing (${f.parts.have}/${f.parts.of})`}</span>}
                    {tab === "chat" && f.gguf && !(f.parts && f.parts.have < f.parts.of) && <FitButton path={f.path} name={f.name.split(/[\\/]/).pop() ?? f.name} />}
                    {tab === "chat" && f.gguf && !(f.parts && f.parts.have < f.parts.of) && <CalibrateButton path={f.path} name={f.name.split(/[\\/]/).pop() ?? f.name} />}
                    {tab === "chat" && f.gguf && !(f.parts && f.parts.have < f.parts.of) && loadButton(f)}
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
                {f.gguf && (!f.source || f.source === "KesherAI") && /[\\/]chat[\\/]/.test(f.path) && (
                  <button type="button" className="icon-btn" title={L("ראייה: שהמודל יראה תמונות (מוריד את קובץ ה-mmproj של המודל)", "Vision: let the model see pictures (downloads its mmproj file)")} aria-label={L(`ראייה ל-${f.name}`, `Vision for ${f.name}`)} onClick={() => void addVision(f)}>👁</button>
                )}
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
    void api<RecImage[]>("/api/models/recommended-images").then(setList).catch((e: Error) => toast(e.message));
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
