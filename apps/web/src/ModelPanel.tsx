import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { closePanel, openSurface } from "./ArtifactPanel";
import { useSurfaces } from "./chat/surface-ui";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { LIGHT_PRESETS, chooseView, detectGpu, partAskMessage, partsFromGlb, partsFromGltf, partsFromObj, type LightId, type ModelParts, type ViewPref } from "./model-surface";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
/** three.js is big: the viewer loads only when a model is shown live. */
const ModelViewer = lazy(() => import("./ModelViewer"));

const base = (p: string) => p.split("/").pop() ?? p;
const PREF_KEY = "kesher-model-view";
const downloadOf = (conv: string, path: string) => withToken(`/api/conversations/${encodeURIComponent(conv)}/files/download?path=${encodeURIComponent(path)}`);

/** The view the user chose last (a convenience, not state). */
function savedPref(): ViewPref {
  try { const v = localStorage.getItem(PREF_KEY); return v === "live" || v === "static" ? v : "auto"; } catch { return "auto"; }
}

/** A still picture stands in when nothing can be drawn: the file's name and type on a plain tile (no GPU needed). */
function PosterTile({ name, parts }: { name: string; parts?: ModelParts | undefined }) {
  const ext = (/\.(\w+)$/.exec(name)?.[1] ?? "3D").toUpperCase();
  return (
    <div className="model-poster-tile" role="img" aria-label={L(`תמונה סטטית של ${name}`, `Static picture of ${name}`)}>
      <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 56 19v26L32 58 8 45V19z M8 19l24 13 24-13 M32 32v26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
      <b dir="ltr">{ext}</b>
      {parts && <small className="muted">{L(`${parts.meshes.length} חלקים · ${parts.materials.length} חומרים`, `${parts.meshes.length} parts · ${parts.materials.length} materials`)}</small>}
    </div>
  );
}

/**
 * The card of a 3D model in the message: its poster (drawn once when the card is on screen, only where the machine
 * has a GPU), the name and Open. Without WebGL2 the poster is a plain tile.
 *
 * @param props - `item`: the model file.
 */
export function ModelCard({ item }: SurfaceCardProps) {
  const path = item.path ?? item.id;
  const box = useRef<HTMLButtonElement>(null);
  const [img, setImg] = useState("");
  useEffect(() => {
    const el = box.current;
    if (!el || chooseView(detectGpu(), "auto") !== "live") return;
    let alive = true;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void import("./model-load").then((m) => m.renderPoster(path, downloadOf(item.convId ?? "", path), base(path), 320)).then((u) => alive && setImg(u), () => undefined);
    });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [path, item.convId]);
  return (
    <button ref={box} type="button" className="item-card model-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${base(path)}`}>
      {img ? <img className="model-card-poster" src={img} alt="" /> : <span className="model-card-poster"><PosterTile name={base(path)} /></span>}
      <span className="item-card-text">
        <strong dir="ltr">{base(path)}</strong>
        <small className="muted">{L("מודל תלת ממד", "3D model")}</small>
      </span>
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * The 3D surface: the model turning in the panel (orbit by mouse or touch), a turntable, wireframe, light presets, the
 * list of materials and parts, and "Ask about this part" on the one tapped. On a machine without a GPU, or when the
 * user picks "Static", a still poster replaces the live view. The 3D editor opens from here when it is installed.
 *
 * @param props - `item`: the model file; `full` and `onFull`: the panel's full-screen state.
 */
export function ModelPanel({ item }: SurfacePanelProps) {
  const conv = item.convId ?? "";
  const path = item.path ?? item.id;
  const name = base(path);
  const src = downloadOf(conv, path);
  const gpu = detectGpu();
  const [pref, setPref] = useState<ViewPref>(savedPref);
  const view = chooseView(gpu, pref);
  const [turn, setTurn] = useState(true);
  const [wire, setWire] = useState(false);
  const [light, setLight] = useState<LightId>("studio");
  const [parts, setParts] = useState<ModelParts | undefined>();
  const [tris, setTris] = useState(0);
  const [pick, setPick] = useState<{ part: string; material?: string } | null>(null);
  const [ask, setAsk] = useState("");
  const [poster, setPoster] = useState("");
  const editor = useSurfaces().find((s) => s.id === "model-editor");

  // Without the live viewer the parts come from the file's own list (a glb's JSON, a gltf, an obj), no drawing.
  useEffect(() => {
    if (view === "live" || parts) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(src);
        const found = /\.glb$/i.test(name) ? partsFromGlb(await r.arrayBuffer()) : /\.gltf$/i.test(name) ? partsFromGltf(await r.json()) : /\.obj$/i.test(name) ? partsFromObj(await r.text()) : undefined;
        if (alive && found) setParts(found);
      } catch { /* the list stays empty; the tile still shows */ }
    })();
    return () => { alive = false; };
  }, [view, src, name, parts]);
  // A still poster when the machine could draw but the user chose Static.
  useEffect(() => {
    if (view !== "poster" || gpu === "none") return;
    let alive = true;
    void import("./model-load").then((m) => m.renderPoster(path, src, name, 720)).then((u) => alive && setPoster(u), () => undefined);
    return () => { alive = false; };
  }, [view, gpu, path, src, name]);

  const choose = (p: ViewPref) => {
    setPref(p);
    try { localStorage.setItem(PREF_KEY, p); } catch { /* private window */ }
  };
  const send = async () => {
    if (!pick || !ask.trim()) return;
    try {
      await api(`/api/conversations/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { text: partAskMessage({ path, part: pick.part, ...(pick.material ? { material: pick.material } : {}), instruction: ask, he: getLocale() === "he" }) } });
      toast(L("נשלח לצ'אט", "Sent to the chat"));
      setAsk("");
      setPick(null);
      if (matchMedia("(max-width: 700px)").matches) closePanel();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="model-sf">
      <div className="model-sf-tools">
        <button type="button" className={turn ? "on" : ""} aria-pressed={turn} disabled={view !== "live"} onClick={() => setTurn(!turn)}>⟳ {L("סיבוב", "Turntable")}</button>
        <button type="button" className={wire ? "on" : ""} aria-pressed={wire} disabled={view !== "live"} onClick={() => setWire(!wire)}>▦ {L("רשת", "Wireframe")}</button>
        <select value={light} disabled={view !== "live"} onChange={(e) => setLight(e.target.value as LightId)} aria-label={L("תאורה", "Light")}>
          {(Object.keys(LIGHT_PRESETS) as LightId[]).map((k) => <option key={k} value={k}>{L(LIGHT_PRESETS[k].he, LIGHT_PRESETS[k].en)}</option>)}
        </select>
        {gpu !== "none" && <button type="button" onClick={() => choose(view === "live" ? "static" : "live")} title={L("תצוגה חיה או תמונה סטטית", "Live view or a static picture")}>{view === "live" ? L("תמונה סטטית", "Static picture") : L("תצוגה חיה", "Live view")}</button>}
        {editor && <button type="button" className="ghost" onClick={() => openSurface({ surface: "model-editor", kind: "model", id: path, path, convId: conv, title: name })}>✎ {L("עריכה בעורך התלת ממד", "Edit in the 3D editor")}</button>}
      </div>
      <div className="model-sf-stage">
        {view === "live" ? (
          <Suspense fallback={<p className="muted small">{L("טוען…", "Loading…")}</p>}>
            <ModelViewer src={src} name={name} autoRotate={turn} light={light} wire={wire} {...(pick ? { picked: pick.part } : {})} onLoaded={(i) => { setParts(i.parts); setTris(i.tris); }} onPick={setPick} />
          </Suspense>
        ) : poster ? <img className="model-sf-poster" src={poster} alt={L(`תמונה סטטית של ${name}`, `Static picture of ${name}`)} /> : <PosterTile name={name} parts={parts} />}
      </div>
      {view === "poster" && gpu === "none" && <p className="muted small model-sf-note">{L("למחשב הזה אין WebGL2 או כרטיס מסך, לכן המודל מוצג כתמונה סטטית.", "This computer has no WebGL2 or GPU, so the model is shown as a static picture.")}</p>}
      <div className="model-sf-lists">
        <section aria-label={L("חלקים", "Parts")}>
          <h4>{L("חלקים", "Parts")}{parts ? ` (${parts.meshes.length})` : ""}{tris ? <small className="muted"> · {tris.toLocaleString()} {L("משולשים", "triangles")}</small> : null}</h4>
          <ul>{(parts?.meshes ?? []).map((m) => <li key={m}><button type="button" className={`tree-row file${pick?.part === m ? " on" : ""}`} dir="ltr" onClick={() => setPick({ part: m })}>{m}</button></li>)}</ul>
        </section>
        <section aria-label={L("חומרים", "Materials")}>
          <h4>{L("חומרים", "Materials")}{parts ? ` (${parts.materials.length})` : ""}</h4>
          <ul>{(parts?.materials ?? []).map((m) => <li key={m.name}><button type="button" className="tree-row file" dir="ltr" onClick={() => setPick({ part: pick?.part ?? m.name, material: m.name })}>{m.color && <i className="model-swatch" style={{ background: m.color }} />}{m.name}</button></li>)}</ul>
        </section>
      </div>
      <div className="model-sf-ask" dir="auto">
        {pick ? <b dir="ltr" className="model-sf-picked">{pick.part}{pick.material ? ` · ${pick.material}` : ""}</b> : <span className="muted small">{L("הקישו על חלק במודל או ברשימה כדי לשאול עליו", "Tap a part of the model or the list to ask about it")}</span>}
        <input value={ask} disabled={!pick} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} placeholder={L("שאלו על החלק הזה…", "Ask about this part…")} aria-label={L("שאלה על החלק שנבחר", "Question about the picked part")} />
        <button type="button" className="primary" disabled={!pick || !ask.trim()} onClick={() => void send()}>{L("שאלה", "Ask")}</button>
      </div>
    </div>
  );
}
