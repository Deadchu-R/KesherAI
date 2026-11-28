import { useEffect, useMemo, useState } from "react";
import type { SceneEngine, SceneObjectChange } from "@kesher/shared";
import { api } from "./api";
import { closePanel, openSurface } from "./ArtifactPanel";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { ENGINE_TITLE, changeMarks, objectAskMessage, sceneModel, sceneSummary, type HNode, type SceneEvent, type SceneModel } from "./scene-surface";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";
import "./scene-diff.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const KIND: Record<SceneObjectChange["kind"], [string, string]> = { added: ["נוסף", "Added"], removed: ["נמחק", "Removed"], changed: ["משתנה", "Changed"] };
const isEngine = (s: string): s is SceneEngine => s === "unity" || s === "unreal" || s === "godot";

/** The chat's events read for one engine; asked again at most every 3 s (a card and a panel share the answer). */
const loads = new Map<string, { at: number; p: Promise<SceneModel> }>();
function loadScene(conv: string, engine: SceneEngine): Promise<SceneModel> {
  const key = `${conv}:${engine}`;
  const hit = loads.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.p;
  const p = api<{ events?: SceneEvent[] }>(`/api/conversations/${encodeURIComponent(conv)}`).then((c) => sceneModel(engine, c.events ?? []));
  loads.set(key, { at: Date.now(), p });
  return p;
}

/** The scene of one chat and engine; undefined while it loads. */
function useScene(conv: string, engine: SceneEngine): SceneModel | undefined {
  const [m, setM] = useState<SceneModel | undefined>();
  useEffect(() => {
    let alive = true;
    void loadScene(conv, engine).then((x) => alive && setM(x), () => alive && setM({ engine, nodes: [] }));
    return () => { alive = false; };
  }, [conv, engine]);
  return m;
}

/**
 * The card of a scene in the message: the engine's scene, how many objects it has and how many the agent added,
 * removed and changed, and Open.
 *
 * @param props - `item`: the scene (its id is the engine).
 */
export function ScenesCard({ item }: SurfaceCardProps) {
  const engine = isEngine(item.id) ? item.id : "unity";
  const m = useScene(item.convId ?? "", engine);
  const s = m ? sceneSummary(m) : undefined;
  const t = ENGINE_TITLE[engine];
  return (
    <button type="button" className="item-card scenes-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${L(t.he, t.en)}`}>
      <span className="item-card-text">
        <strong>{L(t.he, t.en)}{m?.scene ? <> · <code dir="ltr">{m.scene.split("/").pop()}</code></> : null}</strong>
        <small className="muted">
          {s ? <>{s.objects > 0 ? L(`${s.objects} אובייקטים`, `${s.objects} objects`) : L("אין רשימת אובייקטים עדיין", "No object list yet")}</> : "…"}
        </small>
      </span>
      {s && (s.added > 0 || s.removed > 0 || s.changed > 0) && (
        <span className="code-stat" dir="ltr">{s.added > 0 && <b className="plus">+{s.added}</b>}{s.removed > 0 && <b className="minus">−{s.removed}</b>}{s.changed > 0 && <b className="sd-changed">~{s.changed}</b>}</span>
      )}
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/** One row of the hierarchy tree and its children. */
function Row({ node, depth, marks, sel, onSel }: { node: HNode; depth: number; marks: Map<string, SceneObjectChange["kind"]>; sel: string; onSel: (n: HNode) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const mark = marks.get(node.path) ?? marks.get(node.name);
  return (
    <li role="treeitem" aria-expanded={node.children.length ? open : undefined} aria-selected={sel === node.path}>
      <div className="scenes-row" style={{ paddingInlineStart: depth * 14 }}>
        {node.children.length ? <button type="button" className="scenes-twisty" onClick={() => setOpen(!open)} aria-label={open ? L("סגירה", "Collapse") : L("פתיחה", "Expand")}>{open ? "▾" : "▸"}</button> : <span className="scenes-twisty" />}
        <button type="button" className={`tree-row file${sel === node.path ? " on" : ""}${node.inactive ? " muted" : ""}`} dir="ltr" onClick={() => onSel(node)}>
          <span>{node.name}</span>{node.type && <small className="muted"> {node.type}</small>}
          {mark && <span className={`sd-chip sd-${mark}`}>{mark === "added" ? "+" : mark === "removed" ? "−" : "~"}</span>}
        </button>
      </div>
      {open && node.children.length > 0 && <ul role="group">{node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} marks={marks} sel={sel} onSel={onSel} />)}</ul>}
    </li>
  );
}

/**
 * The scenes surface (Unity, Unreal, Godot): the scene's hierarchy as the agent read it, the diff of the changes it
 * made (added, removed, changed objects and their values, old → new), and "Ask about this object". A phone shows one
 * of the two at a time.
 *
 * @param props - `item`: the scene (its id is the engine); `full` and `onFull`: the panel's full-screen state.
 */
export function ScenesPanel({ item }: SurfacePanelProps) {
  const conv = item.convId ?? "";
  const engine = isEngine(item.id) ? item.id : "unity";
  const m = useScene(conv, engine);
  const [tab, setTab] = useState<"tree" | "diff">("tree");
  const [sel, setSel] = useState<{ path: string; name: string } | null>(null);
  const [ask, setAsk] = useState("");
  const marks = useMemo(() => changeMarks(m?.diff), [m?.diff]);
  const change = sel ? m?.diff?.objects.find((o) => o.name === sel.name || o.name === sel.path) : undefined;
  const counts = m ? sceneSummary(m) : undefined;
  useEffect(() => { if (m && !m.nodes.length && m.diff) setTab("diff"); }, [m]);

  const send = async () => {
    if (!sel || !ask.trim()) return;
    try {
      await api(`/api/conversations/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { text: objectAskMessage({ engine, ...(m?.scene ? { scene: m.scene } : {}), object: sel.path, ...(change ? { change } : {}), instruction: ask, he: getLocale() === "he" }) } });
      toast(L("נשלח לצ'אט", "Sent to the chat"));
      setAsk("");
      setSel(null);
      if (matchMedia("(max-width: 700px)").matches) closePanel();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const t = ENGINE_TITLE[engine];

  return (
    <div className="scenes-sf">
      <header className="scenes-head">
        <b>{L(t.he, t.en)}</b>{m?.scene && <code dir="ltr" className="muted small">{m.scene}</code>}
        {counts && <span className="muted small">{L(`${counts.objects} אובייקטים`, `${counts.objects} objects`)}</span>}
      </header>
      <div className="scenes-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "tree"} className={tab === "tree" ? "on" : ""} onClick={() => setTab("tree")}>{L("היררכיה", "Hierarchy")}</button>
        <button type="button" role="tab" aria-selected={tab === "diff"} className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>
          {L("שינויים", "Changes")}{counts && counts.added + counts.removed + counts.changed > 0 ? ` (${counts.added + counts.removed + counts.changed})` : ""}
        </button>
      </div>
      <div className="scenes-body">
        {!m ? <p className="muted small">…</p> : tab === "tree" ? (
          m.nodes.length ? <ul role="tree" className="scenes-tree">{m.nodes.map((n) => <Row key={n.path} node={n} depth={0} marks={marks} sel={sel?.path ?? ""} onSel={(n2) => setSel({ path: n2.path, name: n2.name })} />)}</ul>
            : <p className="muted small">{L("הסוכן עוד לא קרא את רשימת האובייקטים של הסצנה הזו בצ'אט.", "The agent has not read this scene's object list in this chat yet.")}</p>
        ) : m.diff && m.diff.objects.length ? (
          <ul className="sd-objects scenes-diff">
            {m.diff.objects.map((o, i) => (
              <li key={`${o.name}-${i}`} className={`sd-obj sd-${o.kind}${sel?.name === o.name ? " on" : ""}`}>
                <button type="button" className="sd-obj-head scenes-obj" onClick={() => setSel({ path: o.name, name: o.name })} aria-pressed={sel?.name === o.name}>
                  <span className="sd-kind">{L(...KIND[o.kind])}</span>
                  <code className="sd-name" dir="ltr">{o.name}</code>
                  {o.type && <span className="muted small" dir="ltr">{o.type}</span>}
                </button>
                {(o.components?.added?.length || o.components?.removed?.length) && (
                  <p className="sd-comps">
                    {o.components?.added?.map((x) => <span key={`+${x}`} className="sd-chip sd-added" dir="ltr">+ {x}</span>)}
                    {o.components?.removed?.map((x) => <span key={`-${x}`} className="sd-chip sd-removed" dir="ltr">− {x}</span>)}
                  </p>
                )}
                {o.props && o.props.length > 0 && (
                  <table className="sd-props"><tbody>{o.props.map((p) => (
                    <tr key={p.name}><th scope="row" dir="ltr">{p.name}</th><td dir="ltr">{p.from !== undefined && <><del className="sd-old">{p.from}</del> <span aria-hidden="true">→</span> </>}<ins className="sd-new">{p.to}</ins></td></tr>
                  ))}</tbody></table>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted small">{L("הסוכן עוד לא שינה את הסצנה הזו בצ'אט.", "The agent has not changed this scene in this chat yet.")}</p>}
      </div>
      <div className="scenes-ask" dir="auto">
        {sel ? <b dir="ltr" className="scenes-picked">{sel.path}</b> : <span className="muted small">{L("בחרו אובייקט ברשימה כדי לשאול עליו", "Pick an object in the list to ask about it")}</span>}
        <input value={ask} disabled={!sel} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} placeholder={L("שאלו על האובייקט הזה…", "Ask about this object…")} aria-label={L("שאלה על האובייקט שנבחר", "Question about the picked object")} />
        <button type="button" className="primary" disabled={!sel || !ask.trim()} onClick={() => void send()}>{L("שאלה", "Ask")}</button>
      </div>
    </div>
  );
}
