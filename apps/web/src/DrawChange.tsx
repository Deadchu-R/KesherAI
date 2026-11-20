import { useEffect, useRef, useState } from "react";
import { Annotator, type Annotated } from "./Annotator";
import { api, withToken } from "./api";
import { changeRequestText, type ChangeEngine } from "./chat/change-request";
import { getLocale, he$, t } from "./i18n";
import { createConversation } from "./library";
import { uploadToConversation } from "./phone";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A game project as /api/games lists it (the part a change request needs). */
export interface GameRef {
  engine: ChangeEngine;
  name: string;
  path: string;
}

type Source = "engine" | "screen" | "photo";

/**
 * "Draw a change": a picture of the running game or editor view, marked up (arrows, circles, boxes, numbered pins,
 * text), sent to a new chat as a change request with the project and engine context. The chat gets that engine's
 * tools by its words and works in "ask" mode, so every change waits for an approval card that shows the scene diff.
 *
 * Researched first (RESEARCH_LOG "Draw on a phone screenshot and send it to the engine"): Unity AI's "Edit Screen Capture" and the
 * screenshot-to-change flows of design-review tools: capture, mark, a few words, send; the picture with the marks
 * drawn in plus the pins' notes as text reads best for the model.
 *
 * @param props.project - The project (from its card); without one the send step asks which.
 * @param props.src - A picture already taken (the screen view's frame); without one the engine's view is taken.
 * @param props.onClose - Called when cancelled or sent.
 */
export function DrawChange({ project, src, onClose }: { project?: GameRef; src?: string; onClose: () => void }) {
  const [shot, setShot] = useState<{ url: string; source: Source } | null>(src ? { url: src, source: "screen" } : null);
  const [error, setError] = useState("");
  const [marked, setMarked] = useState<Annotated | null>(null);
  const [preview, setPreview] = useState("");
  const [projects, setProjects] = useState<GameRef[]>(project ? [project] : []);
  const [chosen, setChosen] = useState(project ? `${project.engine}|${project.path}` : "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  // Object URLs this dialog made (not the screen view's frame), freed when it closes.
  const made = useRef<string[]>([]);
  const own = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    made.current.push(url);
    return url;
  };
  useEffect(() => () => made.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const take = async (view: "game" | "scene" = "game") => {
    if (!project) return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch(withToken("/api/games/screenshot"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: project.engine, project: project.path, view }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      setShot({ url: own(await res.blob()), source: res.headers.get("x-shot-source") === "screen" ? "screen" : "engine" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!shot) void take();
    // Without a project (the screen view), the projects found on the computer to choose from.
    if (!project) void api<{ projects: GameRef[] }>("/api/games").then((r) => { setProjects(r.projects); if (r.projects.length === 1) setChosen(`${r.projects[0]!.engine}|${r.projects[0]!.path}`); }, () => undefined);
  }, []);

  const pickPhoto = (f: File | undefined) => {
    if (f && f.type.startsWith("image/")) setShot({ url: own(f), source: "photo" });
  };
  const marksDone = (r: Annotated | null) => {
    if (!r) return onClose();
    setMarked(r);
    setPreview(own(r.png));
  };
  const target = projects.find((p) => `${p.engine}|${p.path}` === chosen);
  const send = async () => {
    if (!marked || !target || !shot) return;
    setBusy(true);
    setError("");
    try {
      const id = await createConversation({ kind: "chat", mode: "ask" }, { open: false });
      if (!id) return setBusy(false);
      const pr = await api<{ line: string }>(`/api/conversations/${id}/project`, { method: "POST", body: { path: target.path } });
      const path = await uploadToConversation(id, `change-request-${Date.now()}.png`, marked.png);
      const message = changeRequestText({ engine: target.engine, name: target.name, projectLine: pr.line, imageLine: `[${t("attached")}: ${path}]`, notes: marked.notes, text, source: shot.source });
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: message } });
      onClose();
      location.hash = `#/c/${id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const photoInput = <input ref={photo} type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />;
  // 1. The picture: the engine's view is being taken, or it could not be (then a photo instead).
  if (!shot)
    return (
      <div className="hsheet-wrap" onClick={onClose}>
        <div className="hsheet draw-change" role="dialog" aria-modal="true" aria-label={L("לצייר שינוי", "Draw a change")} onClick={(e) => e.stopPropagation()}>
          <div className="hsheet-handle" aria-hidden />
          <div className="hd">
            <b className="grow">{L("לצייר שינוי", "Draw a change")}{project ? ` · ${project.name}` : ""}</b>
            <button type="button" className="ghost small" onClick={onClose} aria-label={L("סגור", "Close")}>✕</button>
          </div>
          {busy && <p className="muted small">{L("מצלם את המשחק או את העורך…", "Taking a picture of the game or editor…")}</p>}
          {error && <p className="error small" dir="auto">{error}</p>}
          {!busy && (
            <div className="row wrap draw-change-actions">
              {project && project.engine !== "unreal" && <button type="button" onClick={() => void take("game")}>{L("נסה שוב", "Try again")}</button>}
              {project?.engine === "unity" && <button type="button" onClick={() => void take("scene")}>{L("חלון הסצנה", "Scene view")}</button>}
              <button type="button" className="primary" onClick={() => photo.current?.click()}>{L("לבחור תמונה", "Choose a photo")}</button>
            </div>
          )}
          {photoInput}
        </div>
      </div>
    );
  // 2. Mark it up.
  if (!marked) return <Annotator src={shot.url} doneLabel={L("הבא", "Next")} onDone={marksDone} />;
  // 3. A few words, the project, and send.
  return (
    <div className="hsheet-wrap" onClick={busy ? undefined : onClose}>
      <form className="hsheet draw-change stack" role="dialog" aria-modal="true" aria-label={L("לשלוח בקשת שינוי", "Send a change request")} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className="hsheet-handle" aria-hidden />
        <div className="hd">
          <b className="grow">{L("בקשת שינוי למנוע", "Change request to the engine")}</b>
          <button type="button" className="ghost small" disabled={busy} onClick={onClose} aria-label={L("סגור", "Close")}>✕</button>
        </div>
        <img className="draw-change-preview" src={preview} alt={L("התמונה המסומנת", "The marked-up picture")} />
        {marked.notes.length > 0 && <ol className="small draw-change-notes" dir="auto">{marked.notes.map((n, i) => <li key={i}>{n.replace(/^\d+:\s*/, "")}</li>)}</ol>}
        {project ? (
          <p className="small muted" dir="auto">{project.name} · {project.engine === "unity" ? "Unity" : project.engine === "unreal" ? "Unreal" : "Godot"}</p>
        ) : (
          <label className="stack small">
            {L("לאיזה פרויקט?", "Which project?")}
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} required>
              <option value="" disabled>{projects.length ? L("בחר פרויקט", "Choose a project") : L("לא נמצאו פרויקטים במחשב", "No projects found on the computer")}</option>
              {projects.map((p) => <option key={`${p.engine}|${p.path}`} value={`${p.engine}|${p.path}`}>{p.name} · {p.engine === "unity" ? "Unity" : p.engine === "unreal" ? "Unreal" : "Godot"}</option>)}
            </select>
          </label>
        )}
        <label className="stack small">
          {L("מה לשנות? (לא חובה, הסימונים מספיקים)", "What should change? (optional; the marks are enough)")}
          <textarea dir="auto" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={L("למשל: להזיז את הדלת ימינה ולהגדיל את המטבע", "e.g. move the door to the right and make the coin bigger")} />
        </label>
        <p className="muted small">{L("כל שינוי יחכה לאישור שלך, עם תצוגה של מה ישתנה בסצנה.", "Every change waits for your approval, with a preview of what changes in the scene.")}</p>
        {error && <p className="error small" dir="auto">{error}</p>}
        <div className="row wrap draw-change-actions">
          <button type="button" disabled={busy} onClick={() => setMarked(null)}>{L("לסמן מחדש", "Mark again")}</button>
          <button type="submit" className="primary" disabled={busy || !target}>{busy ? "…" : L("שלח לצ׳אט", "Send to chat")}</button>
        </div>
      </form>
    </div>
  );
}
