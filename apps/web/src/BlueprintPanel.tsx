import { useEffect, useMemo, useState } from "react";
import { acceptedInput, parseGraphChange, parseProposal, toggleChange, type ChangeNode } from "@kesher/shared";
import { api } from "./api";
import { closePanel, openSurface } from "./ArtifactPanel";
import { BlueprintCanvas, type GNode } from "./BlueprintCanvas";
import { acceptMessage, askNodeMessage, cardLine, diffMarks, graphTitle, marksCss } from "./blueprint-surface";
import { getLocale, he$ } from "./i18n";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const narrow = () => matchMedia("(max-width: 1099px)").matches;

/** The graph the editor bridge answers (`GET /api/unreal|unity/graph`). */
type Doc = { path: string; name: string; graphs: Array<{ name: string; nodes: GNode[] }> };
type Tab = "graph" | "diff" | "proposal";

/**
 * The card in the message: the graph's name, how many nodes it has, and what the step changed ("+3 nodes, 2 links")
 * or how many changes it proposes. Opens the panel.
 *
 * @param props.item - The step's item (`id` = the asset's path, `data` = the tool's result).
 */
export function BlueprintCard({ item }: SurfaceCardProps) {
  const line = cardLine(item.data, getLocale() === "he");
  const nodes = line?.nodes !== undefined ? L(`${line.nodes} נודים`, `${line.nodes} nodes`) : "";
  return (
    <button type="button" className="item-card blueprint-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${item.title || graphTitle(item.id)}`}>
      <span className="item-card-icon" aria-hidden>🔷</span>
      <span className="item-card-text">
        <strong dir="auto">{item.title || graphTitle(item.id)}{line?.graph ? ` · ${line.graph}` : ""}</strong>
        {line && <small className="muted" dir="auto">{[nodes, line.text].filter(Boolean).join(" · ")}</small>}
      </span>
      <span className="item-card-open">{line?.proposal ? L("לבדיקה", "Review") : L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * The visual-script panel: the graph (pan, zoom, pinch; read only here), the diff of the last change, "Ask about this
 * node", and a proposal reviewed one change at a time. The accepted changes are sent to the chat as a request for the
 * graph write tool, so its approval card appears; nothing is written from here.
 *
 * @param props - The item (see {@link BlueprintCard}), full screen, and the full-screen toggle.
 */
export function BlueprintPanel({ item, full, onFull }: SurfacePanelProps) {
  const conv = item.convId ?? "";
  const change = useMemo(() => (item.data ? parseGraphChange(item.data) : undefined), [item.data]);
  const proposal = useMemo(() => (item.data ? parseProposal(item.data) : undefined), [item.data]);
  const engine = change?.kind ?? proposal?.kind ?? "unreal";
  const [doc, setDoc] = useState<Doc>();
  const [graphName, setGraphName] = useState(change?.graph ?? proposal?.graph ?? "");
  const [tab, setTab] = useState<Tab>(proposal ? "proposal" : change ? "diff" : "graph");
  const [sel, setSel] = useState<string>();
  const [ask, setAsk] = useState("");
  const [accepted, setAccepted] = useState<Set<number>>(() => new Set(proposal?.items.map((_, i) => i)));
  const [flash, setFlash] = useState<{ id: string; n: number }>();
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ graph: Doc }>(`/api/${engine}/graph?path=${encodeURIComponent(item.id)}`).then(
      (r) => {
        setDoc(r.graph);
        setGraphName((n) => (r.graph.graphs.some((g) => g.name === n) ? n : r.graph.graphs[0]?.name ?? ""));
      },
      (e: Error) => setError(e.message),
    );
  }, [engine, item.id]);

  const graph = doc?.graphs.find((g) => g.name === graphName) ?? doc?.graphs[0];
  const marks = useMemo(() => (tab === "diff" && change && graph?.name === change.graph ? diffMarks(change) : new Map()), [tab, change, graph?.name]);
  const node = graph?.nodes.find((n) => n.id === sel);
  const tool = `${engine}_change_graph`;
  const send = async (text: string) => {
    try {
      await api(`/api/conversations/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { text } });
      setMsg(L("נשלח לצ'אט", "Sent to the chat"));
      if (narrow()) closePanel();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const focus = (n: ChangeNode) => {
    setSel(n.id);
    setFlash((f) => ({ id: n.id, n: (f?.n ?? 0) + 1 }));
  };
  const nodeRows = (title: string, list: ChangeNode[], canFocus: boolean) =>
    list.length > 0 && (
      <div className="bp-sf-group">
        <strong className="small">{title} ({list.length})</strong>
        {list.map((n) => (
          <button key={n.id} type="button" className="bp-sf-row" disabled={!canFocus} onClick={() => focus(n)}><span dir="auto">{n.title}</span><small className="muted" dir="ltr">{n.class.replace(/^K2Node_/, "")}</small></button>
        ))}
      </div>
    );
  const tabBtn = (t: Tab, he: string, en: string, on: boolean) => on && <button type="button" role="tab" aria-selected={tab === t} className={`chip-text${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>{L(he, en)}</button>;
  const accept = proposal ? acceptedInput(proposal, accepted) : undefined;

  return (
    <div className="bp-sf" data-bp-sf>
      {marks.size > 0 && <style>{marksCss("[data-bp-sf]", marks)}</style>}
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={closePanel}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <strong className="grow" dir="auto">🔷 {item.title || graphTitle(item.id)}{graph ? ` · ${graph.name}` : ""}</strong>
        <button type="button" className="ghost" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={closePanel}>✕</button>
      </div>
      <div className="bp-sf-tabs" role="tablist" aria-label={L("תצוגות", "Views")}>
        {tabBtn("graph", "גרף", "Graph", true)}
        {tabBtn("diff", "שינויים", "Changes", !!change)}
        {tabBtn("proposal", `הצעה (${proposal?.items.length ?? 0})`, `Proposal (${proposal?.items.length ?? 0})`, !!proposal)}
        {doc && doc.graphs.length > 1 && (
          <select className="bp-sf-graphs" value={graph?.name} onChange={(e) => setGraphName(e.target.value)} aria-label={L("הגרף", "Graph")}>{doc.graphs.map((g) => <option key={g.name}>{g.name}</option>)}</select>
        )}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="bp-sf-canvas ue-canvas">
        {graph ? <BlueprintCanvas nodes={graph.nodes} path={item.id} graph={graph.name} editable={false} unity={engine === "unity"} onChanged={() => undefined} flash={flash} onSelect={(ids) => setSel([...ids][0])} readOnlyWhy={L("עריכה רק דרך הצ'אט: בקשו שינוי או אשרו הצעה", "Edit through the chat: ask for a change or accept a proposal")} /> : !error && <p className="muted small" role="status">…</p>}
      </div>
      <div className="bp-sf-lower">
        {tab === "diff" && change && (
          <div className="bp-sf-list">
            {change.graph !== graph?.name && <p className="muted small">{L(`השינוי היה בגרף ${change.graph}`, `The change was in graph ${change.graph}`)}</p>}
            {nodeRows(L("נוספו", "Added"), change.added, change.graph === graph?.name)}
            {nodeRows(L("שונו", "Changed"), change.changed, change.graph === graph?.name)}
            {nodeRows(L("הוסרו", "Removed"), change.removed, false)}
            <p className="muted small">{L(`קישורים: +${change.links} −${change.unlinked}`, `Links: +${change.links} −${change.unlinked}`)}</p>
          </div>
        )}
        {tab === "proposal" && proposal && (
          <div className="bp-sf-list">
            {proposal.note && <p className="small" dir="auto">{proposal.note}</p>}
            {proposal.items.map((it, i) => (
              <label key={i} className="bp-sf-change">
                <input type="checkbox" checked={accepted.has(i)} onChange={(e) => setAccepted((a) => toggleChange(proposal.items, a, i, e.target.checked))} />
                <span dir="auto">{it.label}</span>
              </label>
            ))}
            <div className="row wrap">
              <button type="button" className="ghost" onClick={() => setAccepted(new Set(proposal.items.map((_, i) => i)))}>{L("אשר הכול", "Accept all")}</button>
              <button type="button" className="ghost" onClick={() => setAccepted(new Set())}>{L("דחה הכול", "Reject all")}</button>
              <button type="button" className="primary" disabled={!accept || !conv} onClick={() => { const t = acceptMessage(tool, proposal, accepted, getLocale() === "he"); if (t) void send(t); }}>{L(`שליחה לאישור (${accept?.ops.length ?? 0})`, `Send for approval (${accept?.ops.length ?? 0})`)}</button>
            </div>
            <p className="muted small">{L("השינויים עוברים דרך כלי הכתיבה של ה-Blueprint, עם בקשת אישור. כאן לא נכתב כלום.", "The changes go through the Blueprint write tool, with its approval. Nothing is written here.")}</p>
          </div>
        )}
        {node ? (
          <div className="bp-sf-ask stack" style={{ gap: 6 }}>
            <strong className="small" dir="auto">{node.title} <small className="muted" dir="ltr">{node.class.replace(/^K2Node_/, "")}</small></strong>
            <div className="row">
              <input className="grow" dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={L("מה לשאול על הנוד הזה?", "What to ask about this node?")} aria-label={L("השאלה על הנוד", "Your question about the node")} />
              <button type="button" className="primary" disabled={!ask.trim() || !conv} onClick={() => { void send(askNodeMessage({ path: item.id, graph: graph?.name ?? "", node, instruction: ask, he: getLocale() === "he" })); setAsk(""); }}>💬 {L("שאל על הנוד", "Ask about this node")}</button>
            </div>
          </div>
        ) : (
          <p className="muted small">{L("בחרו נוד בגרף כדי לשאול עליו.", "Pick a node in the graph to ask about it.")}</p>
        )}
        {msg && <p className="muted small" role="status">{msg}</p>}
      </div>
    </div>
  );
}
