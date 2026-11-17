import { useRef, useState } from "react";
import type { OcclusionBox, StudyOcclusion } from "@kesher/shared";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const pct = (n: number) => `${n * 100}%`;

/** A picture made smaller when it is large (the card keeps a light copy), as base64 and its type. */
async function prepare(f: File): Promise<{ data: string; mime: string; url: string }> {
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.src = url;
  await im.decode();
  const k = Math.min(1, 2000 / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(im.naturalWidth * k);
  c.height = Math.round(im.naturalHeight * k);
  c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
  const out = c.toDataURL("image/jpeg", 0.88);
  return { data: out.split(",")[1]!, mime: "image/jpeg", url: out };
}

/**
 * Making image occlusion cards (design ImageOcclusion, students part 28 #2, like Anki and RemNote): choose or paste a
 * picture (anatomy, a diagram), drag boxes over the labels to hide, name each if you like; each box becomes a card.
 */
export function OcclusionEditor({ courseId, lectureId, onDone }: { courseId: string; lectureId?: string; onDone: (n: number) => void }) {
  const [pic, setPic] = useState<{ data: string; mime: string; url: string } | null>(null);
  const [boxes, setBoxes] = useState<OcclusionBox[]>([]);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState<OcclusionBox | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const at = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const save = async () => {
    if (!pic || !boxes.length) return;
    setBusy(true);
    try {
      const r = await api<{ cards: unknown[] }>(`/api/study/courses/${courseId}/occlusion`, { method: "POST", body: { image: pic.data, mime: pic.mime, boxes, title, ...(lectureId ? { lectureId } : {}) } });
      onDone(r.cards.length);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!pic)
    return (
      <div className="study-occ" onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/")); if (f) void prepare(f).then(setPic); }}>
        <p className="muted small">{L("תמונה עם תוויות (אנטומיה, תרשים, מפה): מסתירים כל תווית בתיבה, וכל תיבה הופכת לכרטיסייה.", "A picture with labels (anatomy, a diagram, a map): hide each label with a box; each box becomes a card.")}</p>
        <label className="button primary">{L("בחירת תמונה (או הדבקה)", "Choose a picture (or paste)")}<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void prepare(f).then(setPic, (er: Error) => toast(er.message)); }} /></label>
      </div>
    );
  return (
    <div className="study-occ">
      <input dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L("שם התמונה (למשל: חתך של הלב)", "The picture's name (e.g. the heart in section)")} aria-label={L("שם", "Name")} />
      <div
        className="study-occ-pic"
        ref={area}
        onPointerDown={(e) => { if ((e.target as HTMLElement).closest("input,button")) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(at(e)); }}
        onPointerMove={(e) => { if (!drag) return; const p = at(e); setLive({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) }); }}
        onPointerUp={() => { if (live && live.w > 0.01 && live.h > 0.01) setBoxes((b) => [...b, live]); setDrag(null); setLive(null); }}
      >
        <img src={pic.url} alt="" draggable={false} />
        {[...boxes, ...(live ? [live] : [])].map((b, i) => <div key={i} className="study-occ-box" style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}><span>{i + 1}</span></div>)}
      </div>
      <p className="muted small">{L("גוררים על התמונה כדי לכסות תווית. אפשר לתת שם לכל תיבה (זו התשובה).", "Drag on the picture to cover a label. Name each box if you like (that is the answer).")}</p>
      {boxes.map((b, i) => (
        <div key={i} className="row study-occ-row">
          <b>{i + 1}</b>
          <input dir="auto" value={b.label ?? ""} onChange={(e) => setBoxes((bs) => bs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder={L("מה מוסתר כאן", "What is hidden here")} aria-label={L(`תיבה ${i + 1}`, `Box ${i + 1}`)} />
          <button type="button" className="ghost small" onClick={() => setBoxes((bs) => bs.filter((_, j) => j !== i))} aria-label={L("להסיר", "Remove")}>✕</button>
        </div>
      ))}
      <div className="study-actions">
        <button type="button" className="primary" disabled={busy || !boxes.length} onClick={() => void save()}>{busy ? "…" : L(`ליצור ${boxes.length} כרטיסיות`, `Make ${boxes.length} cards`)}</button>
        <button type="button" className="ghost" onClick={() => { setPic(null); setBoxes([]); }}>{L("תמונה אחרת", "Another picture")}</button>
      </div>
    </div>
  );
}

/**
 * An image occlusion card in review: every box hidden, the asked one marked; turned, the asked one shows (with its
 * name when it has one).
 */
export function OcclusionCard({ courseId, occ, shown }: { courseId: string; occ: StudyOcclusion; shown: boolean }) {
  return (
    <div className="study-occ-pic view">
      <img src={withToken(`/api/study/courses/${courseId}/images/${occ.image}`)} alt="" draggable={false} />
      {occ.boxes.map((b, i) => (i === occ.i && shown ? <div key={i} className="study-occ-box open" style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }} /> : <div key={i} className={`study-occ-box${i === occ.i ? " ask" : ""}`} style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}>{i === occ.i ? "?" : ""}</div>))}
    </div>
  );
}
