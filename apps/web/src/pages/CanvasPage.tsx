import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements, exportToBlob, exportToSvg, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { Menu, MenuItem } from "../ui/Menu";
import { mergeElements, sceneKey, type Versioned } from "../canvas-merge";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Doc {
  id: string;
  title: string;
  convId?: string;
  elements: Array<Versioned & Record<string, unknown>>;
  pending: Array<{ id: string } & Record<string, unknown>>;
  rev: number;
}
interface Summary { id: string; title: string; convId?: string; shapes: number; updatedAt: string }
type El = Versioned & Record<string, unknown>;

/** Whether the interface is dark now (from the page's own background). */
function dark(): boolean {
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  return !m || Number(m[1]) + Number(m[2]) + Number(m[3]) < 3 * 128;
}

/** The model's skeletons as Excalidraw elements (our ids kept, so arrows stay bound to the right shapes). */
function draw(pending: Doc["pending"]): El[] {
  if (!pending.length) return [];
  return convertToExcalidrawElements(pending as never, { regenerateIds: false }) as unknown as El[];
}

/** Saves a blob as a file. */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** The Canvas page: every canvas (`#/canvas`), or one open (`#/canvas/<id>`). */
export function CanvasPage({ id }: { id?: string }) {
  return id ? <CanvasEditor id={id} /> : <CanvasList />;
}

/** The list of canvases, newest first, and a new one. */
function CanvasList() {
  const [list, setList] = useState<Summary[] | null>(null);
  const load = () => void api<{ canvases: Summary[] }>("/api/canvases").then((r) => setList(r.canvases), (e: Error) => toast(e.message));
  useEffect(load, []);
  const make = () => void api<Doc>("/api/canvases", { method: "POST", body: { title: L("קנבס חדש", "New canvas") } }).then((d) => (location.hash = `#/canvas/${d.id}`), (e: Error) => toast(e.message));
  return (
    <div className="page stack">
      <div className="row">
        <h1 className="grow">{L("קנבס", "Canvas")}</h1>
        <button type="button" className="primary" onClick={make}>{L("קנבס חדש", "New canvas")}</button>
      </div>
      <p className="muted small">{L("לוח ציור שאתם והמודל עורכים יחד: תרשימים, זרימות, ארכיטקטורה. בכל שיחה, בקשו מהמודל לצייר ופתחו את הקנבס מהכותרת.", "A board you and the model draw on together: diagrams, flows, architecture. In any chat, ask the model to draw and open the canvas from the header.")}</p>
      {list && list.length === 0 && <p className="muted">{L("אין עדיין קנבסים.", "No canvases yet.")}</p>}
      <ul className="stack canvas-list">
        {list?.map((c) => (
          <li key={c.id} className="card row">
            <a className="grow" href={`#/canvas/${c.id}`} dir="auto">{c.title}</a>
            <span className="muted small">{L(`${c.shapes} צורות`, `${c.shapes} shapes`)}{c.convId ? ` · ${L("משיחה", "from a chat")}` : ""}</span>
            <button type="button" className="ghost small" onClick={() => void api(`/api/canvases/${c.id}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message))} aria-label={L(`מחיקת ${c.title}`, `Delete ${c.title}`)}>✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One canvas: Excalidraw with the saved elements, the model's additions drawn as they come (a live stream), and the
 * user's own drawing saved a moment after it stops. When both changed, each element keeps its newer version.
 */
function CanvasEditor({ id }: { id: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [initial, setInitial] = useState<El[] | null>(null);
  const [error, setError] = useState("");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const rev = useRef(0);
  const savedKey = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef(false);

  /** Saves the scene (with the model's skeletons just drawn); on a conflict, merges the server's and tries again. */
  const save = useCallback(async (elements: readonly El[], drawn: string[] = [], tries = 2): Promise<void> => {
    saving.current = true;
    try {
      const d = await api<Doc>(`/api/canvases/${id}`, { method: "PUT", body: { elements, rev: rev.current, drawn } });
      rev.current = d.rev;
      savedKey.current = sceneKey(elements);
    } catch (e) {
      if (tries > 0 && /changed/.test((e as Error).message)) {
        const remote = await api<Doc>(`/api/canvases/${id}`);
        rev.current = remote.rev;
        const merged = mergeElements(elements, [...remote.elements, ...draw(remote.pending)]);
        apiRef.current?.updateScene({ elements: merged as never });
        await save(merged, [...drawn, ...remote.pending.map((p) => p.id)], tries - 1);
      } else toast((e as Error).message);
    } finally {
      saving.current = false;
    }
  }, [id]);

  // Open: the saved elements plus the model's additions, drawn now and saved.
  useEffect(() => {
    let gone = false;
    api<Doc>(`/api/canvases/${id}`).then(
      (d) => {
        if (gone) return;
        rev.current = d.rev;
        const els = [...d.elements, ...draw(d.pending)];
        setDoc(d);
        setInitial(els);
        savedKey.current = sceneKey(d.elements);
        if (d.pending.length) void save(els, d.pending.map((p) => p.id));
      },
      (e: Error) => setError(e.message),
    );
    return () => {
      gone = true;
    };
  }, [id, save]);

  // Live: when the model changes the canvas, merge its version in.
  useEffect(() => {
    if (!initial) return;
    const es = new EventSource(withToken(`/api/canvases/${id}/events`));
    es.onmessage = (m) => {
      const r = JSON.parse(m.data as string) as { rev?: number };
      if (typeof r.rev !== "number" || r.rev <= rev.current || saving.current) return;
      if (r.rev < 0) return void (location.hash = "#/canvas");
      void api<Doc>(`/api/canvases/${id}`).then((remote) => {
        const x = apiRef.current;
        if (!x || remote.rev <= rev.current) return;
        rev.current = remote.rev;
        const drawn = draw(remote.pending);
        const merged = mergeElements(x.getSceneElementsIncludingDeleted() as unknown as El[], [...remote.elements, ...drawn]);
        x.updateScene({ elements: merged as never });
        if (remote.pending.length) void save(merged, remote.pending.map((p) => p.id));
      });
    };
    return () => es.close();
  }, [id, initial, save]);

  const onChange = (elements: readonly unknown[]) => {
    const els = elements as readonly El[];
    if (sceneKey(els) === savedKey.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(els), 1200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const exportAs = async (kind: "png" | "svg" | "excalidraw") => {
    const x = apiRef.current;
    if (!x || !doc) return;
    const elements = x.getSceneElements();
    const appState = x.getAppState();
    const files = x.getFiles();
    const name = doc.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "canvas";
    if (kind === "png") saveFile(await exportToBlob({ elements, appState, files, mimeType: "image/png" }), `${name}.png`);
    else if (kind === "svg") saveFile(new Blob([(await exportToSvg({ elements, appState, files })).outerHTML], { type: "image/svg+xml" }), `${name}.svg`);
    else saveFile(new Blob([serializeAsJSON(elements, appState, files, "local")], { type: "application/json" }), `${name}.excalidraw`);
  };

  const rename = () => {
    if (!doc) return;
    const title = prompt(L("שם הקנבס", "Canvas name"), doc.title)?.trim();
    if (title) void api<Doc>(`/api/canvases/${id}`, { method: "PUT", body: { title } }).then((d) => setDoc({ ...doc, title: d.title }), (e: Error) => toast(e.message));
  };

  if (error) return <div className="page"><p className="error">{error}</p><a href="#/canvas">{L("לכל הקנבסים", "All canvases")}</a></div>;
  if (!doc || !initial) return <div className="page"><p className="muted">{L("טוען…", "Loading…")}</p></div>;
  return (
    <div className="canvas-page">
      <div className="row canvas-head">
        {doc.convId ? <a href={`#/c/${doc.convId}`} className="chip text-chip">{L("→ לשיחה", "← Chat")}</a> : <a href="#/canvas" className="chip text-chip">{L("→ קנבסים", "← Canvases")}</a>}
        <button type="button" className="ghost grow canvas-title" dir="auto" onClick={rename} title={L("שינוי שם", "Rename")}>{doc.title}</button>
        <Menu trigger={L("ייצוא", "Export")} triggerClassName="chip text-chip" popClassName="bar-pop" aria-label={L("ייצוא", "Export")}>
          <MenuItem onSelect={() => void exportAs("png")}>PNG</MenuItem>
          <MenuItem onSelect={() => void exportAs("svg")}>SVG</MenuItem>
          <MenuItem onSelect={() => void exportAs("excalidraw")}>{L("קובץ Excalidraw", "Excalidraw file")}</MenuItem>
        </Menu>
      </div>
      <div className="canvas-board" dir="ltr">
        <Excalidraw
          excalidrawAPI={(x) => {
            const first = !apiRef.current;
            apiRef.current = x;
            // Open with the whole drawing in view (on a phone, the default 100% shows only the first shape).
            if (first && initial.length) setTimeout(() => x.scrollToContent(undefined, { fitToContent: true, animate: false }), 50);
          }}
          initialData={{ elements: initial as never, appState: { theme: dark() ? "dark" : "light" }, scrollToContent: true }}
          onChange={onChange}
          langCode={getLocale() === "he" ? "he-IL" : "en"}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } }}
        />
      </div>
    </div>
  );
}
