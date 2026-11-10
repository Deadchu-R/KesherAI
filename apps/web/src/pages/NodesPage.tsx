import { useEffect, useRef, useState } from "react";
import { Menu, MenuItem } from "../ui/Menu";
import { api } from "../api";
import { getLocale } from "../i18n";
import { ComfySection } from "../ComfySection";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A ready-made flow, as `/api/comfy-ui/flows` lists it. */
interface ReadyFlow {
  id: string;
  icon: string;
  title: { en: string; he: string };
  description: { en: string; he: string };
  license: { name: string; url: string };
  ready: boolean;
  downloading: boolean;
  missingGb: number;
}

/** The parts of ComfyUI's page the Nodes page uses (its app object, in the frame). */
interface ComfyApp {
  graphToPrompt(): Promise<{ output: Record<string, unknown> }>;
  loadApiJson(flow: Record<string, unknown>, name?: string): void | Promise<void>;
}

/**
 * Fits ComfyUI's page to a phone: its messages and panels are made to stay
 * inside the screen (so their close buttons can be reached), and the side
 * bar and floating bars get smaller. Runs inside the frame (same address).
 *
 * @param doc - The frame's document.
 */
function fitComfy(doc: Document): void {
  if (doc.getElementById("kesher-fit")) return;
  const style = doc.createElement("style");
  style.id = "kesher-fit";
  style.textContent = `
    .p-toast { max-width: calc(100vw - 16px) !important; }
    @media (max-width: 760px) {
      .p-toast { width: auto !important; left: 8px !important; right: 8px !important; }
      .p-dialog { max-width: calc(100vw - 12px) !important; max-height: calc(100dvh - 12px) !important; }
      .side-tool-bar-container, .side-tool-bar-container .side-bar-button { --sidebar-width: 2.6rem; }
      .side-bar-button { width: 2.6rem !important; height: 2.6rem !important; }
      .side-bar-button .side-bar-button-icon { font-size: 1rem !important; }
    }`;
  doc.head.appendChild(style);
  const win = doc.defaultView;
  if (!win) return;
  /** Pulls a floating element that runs off the screen back inside it. */
  const fit = (el: Element) => {
    if (!(el instanceof win.HTMLElement)) return;
    const pos = win.getComputedStyle(el).position;
    if (pos !== "fixed" && pos !== "absolute") return;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.right <= win.innerWidth + 1) return;
    if (el.closest("canvas, .graph-canvas-container, .litegraph")) return;
    el.style.maxWidth = `${Math.max(160, win.innerWidth - Math.max(0, r.left) - 8)}px`;
    el.style.overflowX = "auto";
    if (r.left > 8 && r.width > win.innerWidth - 16) el.style.left = "8px";
  };
  const scan = (root: Element) => {
    fit(root);
    root.querySelectorAll("[role=alert], [role=dialog], [role=status], .p-toast-message, .p-message, .p-panel, .p-card").forEach(fit);
  };
  new win.MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => n instanceof win.Element && setTimeout(() => scan(n), 60)))).observe(doc.body, { childList: true, subtree: true });
  win.addEventListener("resize", () => scan(doc.body));
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
  // Full screen: the editor gets the whole screen (KesherAI's bar hides), handy on a phone.
  const [full, setFull] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [flows, setFlows] = useState<ReadyFlow[]>([]);
  const [flowMenu, setFlowMenu] = useState(false);
  const [offer, setOffer] = useState<ReadyFlow | null>(null);
  const loadFlows = () => void api<ReadyFlow[]>("/api/comfy-ui/flows").then(setFlows, () => undefined);
  useEffect(() => {
    if (state !== "ready") return;
    loadFlows();
    const id = setInterval(loadFlows, 15_000);
    return () => clearInterval(id);
  }, [state]);
  useEffect(() => {
    document.documentElement.classList.toggle("nodes-full", full);
    return () => document.documentElement.classList.remove("nodes-full");
  }, [full]);

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
      if (innerWidth < 760) toast(r.note || L("עודכן.", "Updated."));
      setRequest("");
    } catch (e) {
      setNote("");
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Loads a ready-made flow, or offers to download its models first. */
  const chooseFlow = async (f: ReadyFlow) => {
    setFlowMenu(false);
    if (!f.ready) return setOffer(f);
    const app = comfy();
    if (!app) return toast(L("העורך עוד נטען.", "The editor is still loading."));
    try {
      const { output } = await app.graphToPrompt().catch(() => ({ output: {} as Record<string, unknown> }));
      const r = await api<{ name: string; flow: Record<string, unknown> }>(`/api/comfy-ui/flows/${f.id}`);
      if (Object.keys(output).length) setHistory((h) => [...h.slice(-19), output]);
      await app.loadApiJson(r.flow, r.name);
      toast(`${f.icon} ${L(f.title.he, f.title.en)}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const download = async (f: ReadyFlow) => {
    try {
      await api(`/api/comfy-ui/flows/${f.id}/setup`, { method: "POST" });
      setOffer(null);
      toast(L("ההורדה התחילה — אפשר לעקוב בעיגול ההורדות.", "Downloading — follow it in the downloads circle."));
      loadFlows();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  /** Closes ComfyUI's messages (e.g. "5 issues found") that cover the editor. */
  const closeMessages = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    let n = 0;
    doc.querySelectorAll<HTMLElement>(".p-toast-close-button, .p-message-close-button, .p-toast [aria-label=Close], [role=alert] button[aria-label=Close], [role=alert] .p-button-icon-only").forEach((b) => (b.click(), n++));
    if (!n) toast(L("אין הודעות פתוחות.", "No messages are open."));
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
  const ask = (
    <form className="nodes-ask" onSubmit={(e) => { e.preventDefault(); void edit(); }}>
      <input dir="auto" value={request} onChange={(e) => setRequest(e.target.value)} placeholder={L("מה לשנות בזרימה? למשל: תוסיף LoRA של אנימה, 30 צעדים", "What to change in the flow? e.g. add an anime LoRA, 30 steps")} aria-label={L("שינוי במילים", "Change in words")} />
      <button type="submit" className="primary" disabled={busy || !request.trim()} title={L("שנה", "Change")}>{busy ? "…" : <>✨<span className="nodes-label"> {L("שנה", "Change")}</span></>}</button>
      <button type="button" disabled={!history.length || busy} onClick={() => void undo()} title={L("בטל", "Undo")}>↶<span className="nodes-label"> {L("בטל", "Undo")}</span></button>
      <Menu className="nodes-flows" popClassName="bar-pop" title={L("זרימות מוכנות", "Ready-made flows")} open={flowMenu} onOpenChange={setFlowMenu} trigger={<>📂<span className="nodes-label"> {L("זרימות מוכנות", "Ready-made")}</span></>}>
        {flows.map((f) => (
          <MenuItem key={f.id} icon={f.icon} keepOpen onSelect={() => void chooseFlow(f)} end={f.ready ? undefined : f.downloading ? L("מוריד…", "Downloading…") : `\u2066⬇ ~${f.missingGb} GB\u2069`}>{L(f.title.he, f.title.en)}</MenuItem>
        ))}
      </Menu>
      <button type="button" onClick={closeMessages} title={L("סגור הודעות", "Close messages")}>✕<span className="nodes-label"> {L("הודעות", "Messages")}</span></button>
      <button type="button" onClick={() => { setFull(!full); setAskOpen(false); }} title={full ? L("צא ממסך מלא", "Exit full screen") : L("מסך מלא", "Full screen")}>{full ? "⤡" : "⤢"}</button>
      {note && <span className="muted small nodes-note" dir="auto">{note}</span>}
    </form>
  );
  const offerCard = offer && (
    <div className="nodes-offer card stack" role="dialog" aria-label={L(offer.title.he, offer.title.en)}>
      <strong>{offer.icon} {L(offer.title.he, offer.title.en)}</strong>
      <p className="small">{L(offer.description.he, offer.description.en)}</p>
      <p className="muted small">
        {offer.downloading
          ? L("המודל כבר בהורדה. כשתסתיים, בחר שוב את הזרימה.", "The model is already downloading. When it finishes, choose the flow again.")
          : L(`צריך להוריד את המודל (בערך \u2066${offer.missingGb} GB\u2069) לתיקיית המודלים של KesherAI. רישיון: `, `The model needs to be downloaded (about ${offer.missingGb} GB) into KesherAI's models folder. Licence: `)}
        {!offer.downloading && <a href={offer.license.url} target="_blank" rel="noreferrer">{offer.license.name}</a>}
      </p>
      <div className="row">
        {!offer.downloading && <button type="button" className="primary" onClick={() => void download(offer)}>⬇ {L("הורד", "Download")}</button>}
        <button type="button" onClick={() => setOffer(null)}>{L("סגור", "Close")}</button>
      </div>
    </div>
  );
  return (
    <div className={`nodes-page${full ? " full" : ""}`}>
      {full ? (
        <div className="nodes-float">
          {askOpen ? ask : (
            <>
              <button type="button" onClick={() => setAskOpen(true)} title={L("שינוי במילים", "Change in words")}>✨</button>
              <button type="button" onClick={closeMessages} title={L("סגור הודעות", "Close messages")}>✕</button>
              <button type="button" onClick={() => setFull(false)} title={L("צא ממסך מלא", "Exit full screen")}>⤡</button>
            </>
          )}
        </div>
      ) : ask}
      {offerCard}
      <iframe ref={frame} className="nodes-frame" src="/comfy-ui/" title="ComfyUI" onLoad={() => {
        const doc = frame.current?.contentDocument;
        try {
          if (doc) fitComfy(doc);
        } catch {
          // not reachable (should not happen: same address)
        }
      }} />
    </div>
  );
}
