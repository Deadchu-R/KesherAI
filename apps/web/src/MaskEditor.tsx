import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";

/** The starting picture for image to image, with the parts to repaint. */
export interface StartImage {
  /** PNG, base64 (no data: prefix), at the size it will be made. */
  image: string;
  /** White where to paint, black elsewhere; absent = change the whole picture. */
  mask?: string;
  width: number;
  height: number;
  strength: number;
}

/**
 * Pick a picture to start from, and paint over the parts to change
 * (inpainting). Without painting, the whole picture changes (image to image).
 *
 * @param props.max - The longest side to make it (a multiple of 64).
 * @param props.onChange - Gets the start image, or undefined when removed.
 */
export function MaskEditor({ max, onChange }: { max: number; onChange: (s: StartImage | undefined) => void }) {
  const [src, setSrc] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [brush, setBrush] = useState(40);
  const [strength, setStrength] = useState(0.75);
  const [painted, setPainted] = useState(false);
  const view = useRef<HTMLCanvasElement>(null);
  const mask = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const redraw = () => {
    const c = view.current;
    if (!c || !src || !mask.current) return;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    g.globalAlpha = 0.45;
    g.drawImage(mask.current, 0, 0);
    g.globalAlpha = 1;
  };
  const emit = () => {
    if (!src) return onChange(undefined);
    const c = document.createElement("canvas");
    c.width = size.w;
    c.height = size.h;
    c.getContext("2d")!.drawImage(src, 0, 0, size.w, size.h);
    const image = c.toDataURL("image/png").split(",")[1]!;
    let m: string | undefined;
    if (painted && mask.current) {
      // The engine's mask: white = repaint, black = keep.
      const k = document.createElement("canvas");
      k.width = size.w;
      k.height = size.h;
      const g = k.getContext("2d")!;
      g.fillStyle = "#000";
      g.fillRect(0, 0, size.w, size.h);
      g.drawImage(mask.current, 0, 0);
      const d = g.getImageData(0, 0, size.w, size.h);
      for (let i = 0; i < d.data.length; i += 4) {
        const on = d.data[i + 3]! > 0 && d.data[i]! > 128;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = on ? 255 : 0;
        d.data[i + 3] = 255;
      }
      g.putImageData(d, 0, 0);
      m = k.toDataURL("image/png").split(",")[1]!;
    }
    onChange({ image, ...(m ? { mask: m } : {}), width: size.w, height: size.h, strength });
  };
  useEffect(() => {
    if (src) emit();
  }, [src, painted, strength, size.w, size.h]);

  const load = (f: File | undefined) => {
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      // The size it will be made at: the longest side `max`, both sides multiples of 64.
      const k = max / Math.max(img.naturalWidth, img.naturalHeight);
      const w = Math.max(64, Math.round((img.naturalWidth * k) / 64) * 64);
      const h = Math.max(64, Math.round((img.naturalHeight * k) / 64) * 64);
      const m = document.createElement("canvas");
      m.width = w;
      m.height = h;
      mask.current = m;
      setSize({ w, h });
      setPainted(false);
      setSrc(img);
    };
    img.src = URL.createObjectURL(f);
  };
  useEffect(redraw, [src, size.w, size.h, painted]);

  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = view.current;
    if (!drawing.current || !c || !mask.current) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const y = ((e.clientY - r.top) / r.height) * c.height;
    const g = mask.current.getContext("2d")!;
    const w = brush * (c.width / r.width);
    // A continuous stroke from the last point, even when the pointer moves fast.
    g.strokeStyle = g.fillStyle = "#fff";
    g.lineWidth = w;
    g.lineCap = "round";
    g.beginPath();
    if (last.current) {
      g.moveTo(last.current.x, last.current.y);
      g.lineTo(x, y);
      g.stroke();
    } else {
      g.arc(x, y, w / 2, 0, Math.PI * 2);
      g.fill();
    }
    last.current = { x, y };
    redraw();
  };
  const clear = () => {
    mask.current?.getContext("2d")!.clearRect(0, 0, size.w, size.h);
    setPainted(false);
    redraw();
  };

  return (
    <div className="stack mask-editor" style={{ gridColumn: "1 / -1", gap: 6 }}>
      <span className="row">
        <span className="grow">{t("startFrom")}</span>
        <button type="button" className="as-link" onClick={() => file.current?.click()}>{src ? t("startReplace") : t("startPick")}</button>
        {src && <button type="button" className="as-link" onClick={() => { setSrc(null); onChange(undefined); }}>{t("remove")}</button>}
      </span>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { load(e.target.files?.[0]); e.target.value = ""; }} />
      {src && (
        <>
          <canvas
            ref={view}
            width={size.w}
            height={size.h}
            className="mask-canvas"
            aria-label={t("maskPaint")}
            onPointerDown={(e) => { drawing.current = true; last.current = null; e.currentTarget.setPointerCapture(e.pointerId); paint(e); }}
            onPointerMove={paint}
            onPointerUp={() => { if (drawing.current) { drawing.current = false; setPainted(true); } }}
          />
          <span className="row small" style={{ flexWrap: "wrap", gap: 10 }}>
            <span className="muted grow">{painted ? t("maskPainted") : t("maskHint")}</span>
            <label className="row">{t("maskBrush")} <input type="range" min={8} max={120} value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
            <label className="row">{t("strength")} <input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} /> <span dir="ltr">{strength.toFixed(2)}</span></label>
            {painted && <button type="button" className="as-link" onClick={clear}>{t("maskClear")}</button>}
          </span>
        </>
      )}
    </div>
  );
}
