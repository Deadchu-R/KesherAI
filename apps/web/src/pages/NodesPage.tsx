import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { ComfySection } from "../ComfySection";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** The parts of ComfyUI's page the Nodes page uses (its app object, in the frame). */
interface ComfyApp {
  graphToPrompt(): Promise<{ output: Record<string, unknown> }>;
  loadApiJson(flow: Record<string, unknown>, name?: string): void | Promise<void>;
}

/**
 * Nodes: ComfyUI's node editor inside KesherAI, with a box to change the
 * flow in words (the local chat model edits it; Undo goes back).
 */
export function NodesPage() {
  const [state, setState] = useState<"checking" | "ready" | "off">("checking");
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const frame = useRef<HTMLIFrameElement>(null);

  const check = () =>
    void api<{ running: boolean }>("/api/comfy-ui/session").then(
      (r) => setState(r.running ? "ready" : "off"),
      () => setState("off"),
    );
  useEffect(check, []);
  useEffect(() => {
    if (state !== "off") return;
    const id = setInterval(check, 4000);
    return () => clearInterval(id);
  }, [state]);

  const comfy = (): ComfyApp | undefined => {
    const w = frame.current?.contentWindow as unknown as { app?: ComfyApp; comfyAPI?: { app?: { app?: ComfyApp } } } | undefined;
    return w?.app ?? w?.comfyAPI?.app?.app;
  };

  const edit = async () => {
    const app = comfy();
    if (!app) return toast(L("העורך עוד נטען.", "The editor is still loading."));
    setBusy(true);
    setNote("");
    try {
      const { output } = await app.graphToPrompt();
      const r = await api<{ flow: Record<string, unknown>; note: string }>("/api/comfy-ui/edit", { method: "POST", body: { flow: output, request } });
      setHistory((h) => [...h.slice(-19), output]);
      await app.loadApiJson(r.flow, "KesherAI");
      setNote(r.note || L("עודכן.", "Updated."));
      setRequest("");
    } catch (e) {
      setNote("");
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    const prev = history.at(-1);
    const app = comfy();
    if (!prev || !app) return;
    await app.loadApiJson(prev, "KesherAI");
    setHistory((h) => h.slice(0, -1));
    setNote(L("חזרתי לזרימה הקודמת.", "Back to the previous flow."));
  };

  if (state === "checking") return <div className="page"><p className="muted">{L("בודק את ComfyUI…", "Checking ComfyUI…")}</p></div>;
  if (state === "off") {
    return (
      <div className="page">
        <h1>{L("נודים", "Nodes")}</h1>
        <p className="muted">{L("עורך הנודים של ComfyUI, בתוך KesherAI: בונים ועורכים זרימות לתמונות, וידאו, מוזיקה ותלת-ממד, וגם משנים אותן במילים עם המודל המקומי. צריך ש-ComfyUI יפעל:", "ComfyUI's node editor inside KesherAI: build and edit flows for pictures, video, music and 3D, and change them in words with your local model. ComfyUI needs to be running:")}</p>
        <ComfySection />
      </div>
    );
  }
  return (
    <div className="nodes-page">
      <form className="nodes-ask row" onSubmit={(e) => { e.preventDefault(); void edit(); }}>
        <input dir="auto" value={request} onChange={(e) => setRequest(e.target.value)} placeholder={L("מה לשנות בזרימה? למשל: תוסיף LoRA של אנימה, 30 צעדים, ותחליף את התיאור לחתול על גג", "What to change in the flow? e.g. add an anime LoRA, 30 steps, and make it a cat on a roof")} aria-label={L("שינוי במילים", "Change in words")} />
        <button type="submit" className="primary" disabled={busy || !request.trim()}>{busy ? L("המודל עורך…", "Editing…") : L("שנה", "Change")}</button>
        <button type="button" disabled={!history.length || busy} onClick={() => void undo()}>{L("בטל", "Undo")}</button>
        {note && <span className="muted small" dir="auto">{note}</span>}
      </form>
      <iframe ref={frame} className="nodes-frame" src="/comfy-ui/" title="ComfyUI" />
    </div>
  );
}
