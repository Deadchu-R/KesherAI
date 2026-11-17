import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { framed } from "./ArtifactPanel";
import { frameSize } from "./design-frame";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { askText } from "./ui/askText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Note { x: number; y: number; text: string; frame: number }

/**
 * The design canvas (design DesignCanvasChat, like Claude's design canvas): every screen of this chat as a frame on a
 * board to pan and zoom. Pick a screen and ask for a change (it goes to the chat as a message naming that screen);
 * pin comments on screens (kept on this device). The screens run sandboxed, as in the artifact panel.
 */
export function DesignBoard({ screens, onPick }: { screens: string[]; onPick: (i: number) => void }) {
  const chat = location.hash.startsWith("#/c/") ? location.hash.slice(4).split(/[?/]/)[0]! : "";
  const notesKey = `kesher-design-notes-${chat}`;
  const [zoom, setZoom] = useState(0.35);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [sel, setSel] = useState(screens.length - 1);
  const [ask, setAsk] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(notesKey) ?? "[]") as Note[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(notesKey, JSON.stringify(notes));
    } catch {
      // Kept for this visit only.
    }
  }, [notes, notesKey]);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const sizes = screens.map(frameSize);
  const xs = sizes.reduce<number[]>((a, s, i) => [...a, i === 0 ? 0 : a[i - 1]! + sizes[i - 1]!.w + 80], []);
  const title = (code: string, i: number) => /<title>([^<]{1,60})<\/title>/i.exec(code)?.[1]?.trim() || L(`מסך ${i + 1}`, `Screen ${i + 1}`);
  const send = async () => {
    if (!ask.trim() || !chat) return;
    try {
      await api(`/api/conversations/${chat}/messages`, { method: "POST", body: { text: L(`במסך "${title(screens[sel]!, sel)}" (גרסה ${sel + 1}): ${ask.trim()}\nכתוב את המסך המעודכן כולו בבלוק html אחד.`, `On the screen "${title(screens[sel]!, sel)}" (version ${sel + 1}): ${ask.trim()}\nWrite the whole updated screen in one html block.`) } });
      setAsk("");
      toast(L("נשלח לצ'אט ✓", "Sent to the chat ✓"));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="design-board">
      <div className="design-tools">
        <button type="button" className={commenting ? "" : "primary"} onClick={() => setCommenting(false)}>↖ {L("בחר", "Select")}</button>
        <button type="button" className={commenting ? "primary" : ""} onClick={() => setCommenting(true)}>💬 {L("הערה", "Comment")}</button>
        <span className="grow" />
        <button type="button" className="ghost" aria-label={L("הקטן", "Zoom out")} onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}>−</button>
        <span className="muted small" dir="ltr">{Math.round(zoom * 100)}%</span>
        <button type="button" className="ghost" aria-label={L("הגדל", "Zoom in")} onClick={() => setZoom((z) => Math.min(2, z * 1.25))}>+</button>
      </div>
      <div
        className="design-space"
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom((z) => Math.min(2, Math.max(0.1, z * (e.deltaY < 0 ? 1.1 : 0.9)))); } else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY })); }}
        onPointerDown={(e) => { if ((e.target as HTMLElement).closest(".design-frame, .design-note")) return; drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); }}
        onPointerUp={() => (drag.current = null)}
      >
        <div className="design-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {screens.map((code, i) => (
            <div key={i} className={`design-frame${sel === i ? " sel" : ""}`} style={{ left: xs[i], width: sizes[i]!.w }}
              onClick={(e) => {
                if (commenting) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const at = { frame: i, x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom - 28 };
                  void askText(L("ההערה", "The comment")).then((text) => { if (text?.trim()) setNotes((n) => [...n, { ...at, text: text.trim() }]); });
                  return;
                }
                setSel(i);
                onPick(i);
              }}>
              <div className="design-label" dir="auto">{title(code, i)} · v{i + 1}</div>
              <div className="design-screen" style={{ height: sizes[i]!.h, borderRadius: sizes[i]!.phone ? 28 : 10 }}>
                <iframe title={title(code, i)} sandbox="allow-scripts" srcDoc={framed(code)} style={{ pointerEvents: commenting || sel !== i ? "none" : "auto" }} />
              </div>
              {notes.filter((n) => n.frame === i).map((n, k) => (
                <div key={k} className="design-note" style={{ left: n.x, top: n.y + 28 }} title={n.text}
                  onClick={(e) => { e.stopPropagation(); if (confirm(L(`"${n.text}"\n\nלמחוק את ההערה?`, `"${n.text}"\n\nDelete this comment?`))) setNotes((all) => all.filter((x) => x !== n)); }}>
                  {notes.indexOf(n) + 1}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <form className="design-ask" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <span className="muted small" dir="auto">{L("נבחר:", "Selected:")} <b>{screens[sel] ? title(screens[sel]!, sel) : "—"}</b></span>
        <input dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={L("בקש שינוי במסך הזה…", "Ask for a change on this screen…")} />
        <button type="submit" className="primary" disabled={!ask.trim()}>↑</button>
      </form>
    </div>
  );
}
