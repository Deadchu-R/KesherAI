import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, withToken } from "./api";
import { closePanel, openSurface } from "./ArtifactPanel";
import { ImageCanvas } from "./CanvasPanel";
import { MaskEditor, type StartImage } from "./MaskEditor";
import { getLocale, he$ } from "./i18n";
import { formatSize, regionFromDrag, regionMessage, resizeDims, toImagePoint, versionChain, type ImageInfo, type Region } from "./image-surface";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";
import { useModels } from "./useModels";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const asset = (id: string) => withToken(`/api/assets/${id}`);
const narrow = () => matchMedia("(max-width: 1099px)").matches;

/** The version in the picture's chain and what is being done to it. */
type Mode = "view" | "crop" | "size" | "mask" | "ask";

/** The server's record of a picture (`GET /api/images/:id/info`). */
const infoOf = (id: string) => api<ImageInfo>(`/api/images/${id}/info`);

/**
 * The card in the message: a thumbnail, the size, and the model and prompt when it was generated. Opens the panel.
 *
 * @param props.item - The picture (`id` = its asset id).
 */
export function ImageCard({ item }: SurfaceCardProps) {
  const [info, setInfo] = useState<ImageInfo>();
  useEffect(() => {
    void infoOf(item.id).then(setInfo).catch(() => undefined);
  }, [item.id]);
  const line = [info?.width && info.height ? `${info.width}×${info.height}` : "", info ? formatSize(info.bytes) : "", info?.model ?? ""].filter(Boolean).join(" · ");
  return (
    <button type="button" className="item-card image-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${L("תמונה", "Picture")}`}>
      <img className="image-card-thumb" src={asset(item.id)} alt="" loading="lazy" />
      <span className="item-card-text">
        <strong>{item.title || L("תמונה", "Picture")}{info && info.version > 1 ? ` · v${info.version}` : ""}</strong>
        {line && <small className="muted" dir="ltr">{line}</small>}
        {info?.prompt && <small className="muted image-card-prompt" dir="auto">{info.prompt}</small>}
      </span>
      <span className="item-card-open">{L("עריכה", "Edit")} ›</span>
    </button>
  );
}

/** Loads a picture into a canvas-ready element. */
function load(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("The picture did not load."));
    img.src = src;
  });
}

/** Draws `from` into a new canvas of the given size (a source rectangle, and a quarter turn when `turn`). */
function paint(img: HTMLImageElement, o: { w: number; h: number; src?: Region; turn?: boolean }): string {
  const c = document.createElement("canvas");
  c.width = o.w;
  c.height = o.h;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  if (o.turn) {
    g.translate(o.w, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(img, 0, 0);
  } else if (o.src) g.drawImage(img, o.src.x, o.src.y, o.src.w, o.src.h, 0, 0, o.w, o.h);
  else g.drawImage(img, 0, 0, o.w, o.h);
  return c.toDataURL("image/png");
}

/** The picture with a draggable rectangle over it (crop, "Ask about this area"). Works with a finger. */
function RegionBox({ src, size, region, onRegion }: { src: string; size: { w: number; h: number }; region: Region | undefined; onRegion: (r: Region | undefined) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const at = (e: ReactPointerEvent) => toImagePoint({ x: e.clientX, y: e.clientY }, img.current!.getBoundingClientRect(), size);
  return (
    <div
      className="img-region"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); from.current = at(e); onRegion(undefined); }}
      onPointerMove={(e) => { if (from.current) onRegion(regionFromDrag(from.current, at(e), size, 1)); }}
      onPointerUp={(e) => { const a = from.current; from.current = null; if (a) onRegion(regionFromDrag(a, at(e), size)); }}
      onPointerCancel={() => { from.current = null; }}
    >
      <img ref={img} src={src} alt={L("התמונה לסימון אזור", "The picture to mark an area on")} draggable={false} />
      {region && <span className="img-rect" style={{ left: `${(region.x / size.w) * 100}%`, top: `${(region.y / size.h) * 100}%`, width: `${(region.w / size.w) * 100}%`, height: `${(region.h / size.h) * 100}%` }} />}
    </div>
  );
}

/**
 * The image surface: zoom, pan and compare with the previous version (the side canvas's own view), crop, rotate, resize
 * (through `sharp` on the PC, else on this page's canvas), paint over an area and change only it, variations, and "Ask
 * about this area". Every change is saved as a NEW version on the server that remembers its parent; the original is never
 * touched. On the phone: view, compare, crop, paint with a finger and ask, in a full screen panel.
 *
 * @param props.item - The picture: an asset (`id`), or a chat file (`path`, brought in as the first version).
 */
export function ImagePanel({ item, full, onFull }: SurfacePanelProps) {
  const conv = item.convId ?? "";
  const { models } = useModels("image");
  const [chain, setChain] = useState<string[]>(item.path ? [] : [item.id]);
  const [info, setInfo] = useState<ImageInfo>();
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [region, setRegion] = useState<Region>();
  const [ask, setAsk] = useState("");
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [lock, setLock] = useState(true);
  const [start, setStart] = useState<StartImage>();
  const [change, setChange] = useState("");
  const head = chain[chain.length - 1];
  const size = { w: info?.width ?? 0, h: info?.height ?? 0 };

  // A chat file comes in as the first version (an asset), so every edit has a parent to remember.
  useEffect(() => {
    if (!item.path) return;
    void (async () => {
      try {
        const blob = await (await fetch(withToken(`/api/conversations/${encodeURIComponent(conv)}/files/download?path=${encodeURIComponent(item.path!)}`))).blob();
        const image = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); });
        const { asset: a } = await api<{ asset: { id: string } }>("/api/images/version", { method: "POST", body: { op: "import", image } });
        setChain([a.id]);
      } catch (e) {
        setMsg((e as Error).message);
      }
    })();
  }, [item.path]);

  // The newest picture's record, and the chain of its parents (the versions to compare).
  useEffect(() => {
    if (!head) return;
    let gone = false;
    void (async () => {
      const seen = new Map<string, ImageInfo>();
      try {
        for (let at: string | undefined = head; at && !seen.has(at) && seen.size < 20; at = seen.get(at)?.parent) seen.set(at, await infoOf(at));
      } catch {
        // A missing older version just ends the chain.
      }
      if (gone) return;
      const now = seen.get(head);
      if (now) { setInfo(now); setDims({ w: now.width ?? 0, h: now.height ?? 0 }); }
      setChain((c) => (c.length > 1 ? c : versionChain(seen, head)));
    })();
    return () => { gone = true; };
  }, [head]);

  /** Saves a picture (a data address) as the next version and shows it. */
  const save = async (image: string, op: string) => {
    const { asset: a } = await api<{ asset: { id: string } }>("/api/images/version", { method: "POST", body: { parent: head, op, image } });
    setChain((c) => [...c, a.id]);
    setMode("view");
    setRegion(undefined);
    setMsg(L(`נשמר כגרסה ${chain.length + 1}`, `Saved as version ${chain.length + 1}`));
  };
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    setMsg("");
    try { await f(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };
  const rotate = () => run("rotate", async () => {
    const img = await load(asset(head!));
    await save(paint(img, { w: img.naturalHeight, h: img.naturalWidth, turn: true }), "rotate");
  });
  const crop = () => run("crop", async () => {
    if (!region) return;
    await save(paint(await load(asset(head!)), { w: region.w, h: region.h, src: region }), "crop");
  });
  const resize = () => run("resize", async () => {
    const r = await api<{ via: string; asset?: { id: string } }>("/api/images/resize", { method: "POST", body: { id: head, width: dims.w, height: dims.h } });
    if (r.asset) {
      setChain((c) => [...c, r.asset!.id]);
      setMode("view");
      setMsg(L("הגודל שונה", "Resized"));
    } else await save(paint(await load(asset(head!)), { w: dims.w, h: dims.h }), "resize");
  });
  /** One image-to-image run (the same engine as the Pictures page); its result is saved as a version of this picture. */
  const redraw = async (s: StartImage, prompt: string, op: string) => {
    const modelId = models[0]?.id;
    if (!modelId) throw new Error(L("אין מודל תמונות. בחרו אחד במודלים.", "No picture model. Pick one under Models."));
    const { assets } = await api<{ assets: Array<{ id: string }> }>("/api/images", { method: "POST", body: { modelId, prompt, steps: 20, width: s.width, height: s.height, initImage: s.image, strength: s.strength, ...(s.mask ? { mask: s.mask } : {}) } });
    const blob = await (await fetch(asset(assets[0]!.id))).blob();
    const image = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); });
    await save(image, op);
  };
  const inpaint = () => run("inpaint", async () => {
    if (start && change.trim()) await redraw(start, change.trim(), "inpaint");
  });
  const variations = () => run("variations", async () => {
    const img = await load(asset(head!));
    const k = 1024 / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.max(64, Math.round((img.naturalWidth * k) / 64) * 64);
    const h = Math.max(64, Math.round((img.naturalHeight * k) / 64) * 64);
    const s: StartImage = { image: paint(img, { w, h }).split(",")[1]!, width: w, height: h, strength: 0.55 };
    for (let i = 0; i < 2; i++) await redraw(s, info?.prompt ?? "a variation of this picture", "variation");
  });
  const sendAsk = (changeOnly: boolean) => run("ask", async () => {
    if (!region || !ask.trim()) return;
    const text = regionMessage({ id: head!, title: item.title || L("תמונה", "Picture"), size, region, instruction: ask, change: changeOnly, he: getLocale() === "he" });
    await api(`/api/conversations/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { text } });
    setAsk("");
    setRegion(undefined);
    setMsg(L("נשלח לצ'אט", "Sent to the chat"));
    if (narrow()) closePanel();
  });

  const pick = (m: Mode) => { setMode(mode === m ? "view" : m); setRegion(undefined); setMsg(""); };
  const tool = (m: Mode, icon: string, he: string, en: string) => (
    <button type="button" className={`chip-text${mode === m ? " on" : ""}`} aria-pressed={mode === m} disabled={!head || !!busy} onClick={() => pick(m)}>{icon} {L(he, en)}</button>
  );
  return (
    <div className="img-sf">
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={closePanel}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <strong className="grow" dir="auto">{item.title || item.path?.split("/").pop() || L("תמונה", "Picture")}{chain.length > 1 ? ` · v${chain.length}` : ""}</strong>
        <button type="button" className="ghost" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={closePanel}>✕</button>
      </div>
      <div className="img-sf-tools" role="toolbar" aria-label={L("כלי התמונה", "Picture tools")}>
        {tool("crop", "✂", "חיתוך", "Crop")}
        <button type="button" className="chip-text" disabled={!head || !!busy} onClick={() => void rotate()}>⟳ {L("סיבוב", "Rotate")}</button>
        {tool("size", "⤢", "גודל", "Resize")}
        {tool("mask", "🖌", "שינוי אזור", "Change area")}
        {tool("ask", "💬", "שאלה על אזור", "Ask about an area")}
        <button type="button" className="chip-text" disabled={!head || !!busy} onClick={() => void variations()}>⧉ {L("וריאציות", "Variations")}</button>
        {item.path && <button type="button" className="chip-text" onClick={() => openSurface({ ...item, surface: "image-editor" })}>◧ {L("העורך המלא", "Full editor")}</button>}
      </div>
      <div className="img-sf-main">
        {!head ? <p className="muted small" role="status">{msg || "…"}</p> : mode === "view" || !info ? (
          <ImageCanvas key={chain.join(",")} item={{ kind: "image", assetId: head, history: chain, convId: conv }} />
        ) : mode === "crop" || mode === "ask" ? (
          <div className="img-sf-edit">
            <RegionBox src={asset(head)} size={size} region={region} onRegion={setRegion} />
            {mode === "crop" ? (
              <div className="row wrap">
                <span className="muted small grow" dir="ltr">{region ? `${region.w}×${region.h}` : L("גררו על התמונה לסימון החיתוך", "Drag on the picture to mark the crop")}</span>
                <button type="button" className="primary" disabled={!region || !!busy} onClick={() => void crop()}>{busy === "crop" ? "…" : L("חיתוך ושמירה כגרסה", "Crop and save as a version")}</button>
              </div>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <span className="muted small">{region ? <span dir="ltr">{`${region.w}×${region.h} @ ${region.x},${region.y}`}</span> : L("גררו על התמונה לסימון האזור", "Drag on the picture to mark the area")}</span>
                <input dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={L("מה לשאול או לשנות באזור הזה?", "What to ask or change in this area?")} aria-label={L("הבקשה על האזור", "Your request about the area")} />
                <div className="row wrap">
                  <button type="button" className="ghost" disabled={!region || !ask.trim() || !!busy} onClick={() => void sendAsk(false)}>💬 {L("לשאול על זה", "Ask about this")}</button>
                  <button type="button" className="primary" disabled={!region || !ask.trim() || !!busy} onClick={() => void sendAsk(true)}>✎ {L("לשנות רק את זה", "Change only this")}</button>
                </div>
              </div>
            )}
          </div>
        ) : mode === "size" ? (
          <div className="img-sf-edit stack" style={{ gap: 8 }}>
            <div className="row wrap" dir="ltr">
              <label className="row">{L("רוחב", "W")} <input type="number" inputMode="numeric" min={1} max={8192} value={dims.w} onChange={(e) => setDims(resizeDims(size, { side: "w", value: Number(e.target.value) }, lock))} /></label>
              <label className="row">{L("גובה", "H")} <input type="number" inputMode="numeric" min={1} max={8192} value={dims.h} onChange={(e) => setDims(resizeDims(size, { side: "h", value: Number(e.target.value) }, lock))} /></label>
              <label className="row small"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> {L("שמירת יחס", "Keep ratio")}</label>
            </div>
            <span className="muted small" dir="ltr">{size.w}×{size.h} → {dims.w}×{dims.h}</span>
            <button type="button" className="primary" disabled={!!busy || !dims.w || !dims.h || (dims.w === size.w && dims.h === size.h)} onClick={() => void resize()}>{busy === "resize" ? "…" : L("שינוי גודל ושמירה כגרסה", "Resize and save as a version")}</button>
          </div>
        ) : (
          <div className="img-sf-edit stack" style={{ gap: 8 }}>
            <MaskEditor from={asset(head)} max={1024} onChange={setStart} />
            <input dir="auto" value={change} onChange={(e) => setChange(e.target.value)} placeholder={L("מה לצייר באזור שסימנתם?", "What to paint in the marked area?")} aria-label={L("מה לצייר באזור", "What to paint in the area")} />
            <button type="button" className="primary" disabled={!start?.mask || !change.trim() || !!busy} onClick={() => void inpaint()}>{busy === "inpaint" ? "…" : L("שינוי האזור ושמירה כגרסה", "Change the area and save as a version")}</button>
          </div>
        )}
        {busy && busy !== "ask" && <p className="muted small" role="status">{L("עובד…", "Working…")}</p>}
        {msg && head && <p className="muted small" role="status">{msg}</p>}
      </div>
    </div>
  );
}
