import { useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";
import { api, withToken } from "../api";
import { t } from "../i18n";

/** How many images one batch takes. */
const MAX = 50;
/** Images are scaled down to this longest side before upscaling (4× gives up to 4096 px). */
const UPSCALE_INPUT = 1024;

type Action = "remove-bg" | "upscale" | "both";
interface Item { id: string; name: string; src: string; status: "waiting" | "working" | "done" | "failed"; out?: Blob; outUrl?: string; error?: string }

/** Loads a file into an image element. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Not an image"));
    img.src = src;
  });
}

/** Draws an image (or a URL) to a PNG, at most `maxSide` pixels on its longest side. */
async function toPng(src: string, maxSide = Infinity): Promise<Blob> {
  const img = await loadImage(src);
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode PNG"))), "image/png"));
}

type Segmenter = (image: string) => Promise<{ toBlob(type?: string): Promise<Blob> }>;
let segmenter: Promise<Segmenter> | undefined;

/**
 * The background remover: ormbg (Apache-2.0) through Transformers.js, run in
 * this window. The model (about 175 MB) downloads from Hugging Face the
 * first time and is kept by the browser.
 */
function backgroundRemover(onProgress: (pct: number) => void): Promise<Segmenter> {
  segmenter ??= (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const seg = await pipeline("background-removal", "onnx-community/ormbg-ONNX", {
      progress_callback: (p: { status?: string; progress?: number }) => {
        if (p.status === "progress" && typeof p.progress === "number") onProgress(p.progress);
      },
    });
    return seg as unknown as Segmenter;
  })();
  segmenter.catch(() => (segmenter = undefined));
  return segmenter;
}

/**
 * Batch image tools: up to 50 images at once, remove the background, make
 * them four times larger, or both, then download each or all as a ZIP.
 */
export function BatchImagesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [action, setAction] = useState<Action>("remove-bg");
  const [running, setRunning] = useState(false);
  const [modelPct, setModelPct] = useState<number | null>(null);
  const [upscaler, setUpscaler] = useState<{ ready: boolean; modelMb: number; busy: boolean } | null>(null);
  const [error, setError] = useState("");
  const stop = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshUpscaler = () => void api<{ ready: boolean; modelMb: number; busy: boolean }>("/api/images/upscale").then(setUpscaler).catch(() => undefined);
  useEffect(refreshUpscaler, []);
  useEffect(() => {
    if (!upscaler?.busy) return;
    const id = setInterval(refreshUpscaler, 3000);
    return () => clearInterval(id);
  }, [upscaler?.busy]);

  const add = (files: FileList | null) => {
    if (!files) return;
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    setItems((prev) => {
      const room = MAX - prev.length;
      if (images.length > room) setError(t("batchTooMany", { n: MAX }));
      return [...prev, ...images.slice(0, Math.max(0, room)).map((f) => ({ id: crypto.randomUUID(), name: f.name, src: URL.createObjectURL(f), status: "waiting" as const }))];
    });
  };
  const update = (id: string, patch: Partial<Item>) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const needsUpscaler = action !== "remove-bg";

  const run = async () => {
    setError("");
    setRunning(true);
    stop.current = false;
    try {
      const remover = action !== "upscale" ? await backgroundRemover(setModelPct) : undefined;
      setModelPct(null);
      for (const item of items) {
        if (stop.current) break;
        if (item.status === "done") continue;
        update(item.id, { status: "working" });
        try {
          let src = item.src;
          let made: string | undefined;
          if (needsUpscaler) {
            const res = await fetch(withToken("/api/images/upscale"), { method: "POST", headers: { "content-type": "image/png" }, body: await toPng(src, UPSCALE_INPUT) });
            if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
            made = URL.createObjectURL(await res.blob());
            src = made;
          }
          let out: Blob;
          if (remover) out = await (await remover(src)).toBlob("image/png");
          else out = await (await fetch(src)).blob();
          if (made) URL.revokeObjectURL(made);
          update(item.id, { status: "done", out, outUrl: URL.createObjectURL(out) });
        } catch (e) {
          update(item.id, { status: "failed", error: (e as Error).message });
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setModelPct(null);
      setRunning(false);
    }
  };

  const outName = (name: string) => `${name.replace(/\.[^.]+$/, "")}-${action}.png`;
  const downloadAll = async () => {
    const files: Record<string, Uint8Array> = {};
    for (const i of items) if (i.out) files[outName(i.name)] = new Uint8Array(await i.out.arrayBuffer());
    const url = URL.createObjectURL(new Blob([zipSync(files, { level: 0 })], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "kesher-images.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const done = items.filter((i) => i.status === "done").length;
  const blocked = needsUpscaler && upscaler !== null && !upscaler.ready;

  return (
    <div className="page">
      <h1>{t("batchTitle")}</h1>
      <p className="muted">{t("batchIntro", { n: MAX })}</p>
      <div className="card stack">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={running || items.length >= MAX}>{t("batchAdd")}</button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          <select value={action} onChange={(e) => setAction(e.target.value as Action)} disabled={running} aria-label={t("batchAction")}>
            <option value="remove-bg">{t("batchRemoveBg")}</option>
            <option value="upscale">{t("batchUpscale")}</option>
            <option value="both">{t("batchBoth")}</option>
          </select>
          <span className="grow muted small">{items.length}/{MAX}</span>
          {running ? (
            <button type="button" onClick={() => (stop.current = true)}>{t("batchStop")}</button>
          ) : (
            <button type="button" className="primary" disabled={!items.length || blocked || items.every((i) => i.status === "done")} onClick={() => void run()}>{t("batchRun")}</button>
          )}
          {done > 0 && !running && <button type="button" onClick={() => void downloadAll()}>{t("batchZip", { n: done })}</button>}
          {items.length > 0 && !running && <button type="button" className="as-link" onClick={() => setItems([])}>{t("batchClear")}</button>}
        </div>
        {blocked && (
          <p className="row small">
            <span className="grow muted">{upscaler!.busy ? t("batchUpscalerPreparing") : t("batchUpscalerNeeded", { mb: upscaler!.modelMb })}</span>
            {!upscaler!.busy && <button type="button" className="primary" onClick={() => void api("/api/images/upscale/setup", { method: "POST" }).then(() => setUpscaler({ ...upscaler!, busy: true }))}>{t("micDownload")}</button>}
          </p>
        )}
        {action !== "upscale" && <p className="muted small">{modelPct !== null ? t("batchModelLoading", { pct: Math.round(modelPct) }) : t("batchBgNote")}</p>}
      </div>
      {error && <p className="error">{error}</p>}
      <div
        className="batch-grid"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (!running) add(e.dataTransfer.files); }}
      >
        {items.length === 0 && <p className="muted batch-drop">{t("batchDrop")}</p>}
        {items.map((i) => (
          <figure key={i.id} className={`batch-item ${i.status}`}>
            <img src={i.outUrl ?? i.src} alt={i.name} />
            <figcaption className="row small">
              <span className="grow batch-name" dir="ltr" title={i.error ?? i.name}>{i.status === "failed" ? `⚠ ${i.error}` : i.name}</span>
              {i.status === "working" && <span className="spinner" aria-hidden />}
              {i.outUrl && <a href={i.outUrl} download={outName(i.name)} aria-label={t("batchSave")} title={t("batchSave")}>⬇</a>}
              {!running && <button type="button" className="as-link" aria-label={t("remove")} onClick={() => setItems((prev) => prev.filter((x) => x.id !== i.id))}>✕</button>}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
