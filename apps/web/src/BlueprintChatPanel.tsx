import { useEffect, useState } from "react";
import { api } from "./api";
import { BlueprintCanvas, type GNode } from "./BlueprintCanvas";
import { getLocale } from "./i18n";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Graph = { path: string; name: string; parent?: string; graphs: Array<{ name: string; nodes: GNode[] }> };

/** The Blueprint connected to a chat (remembered per chat on this device). */
export function chatBlueprint(convId: string): string {
  try {
    return localStorage.getItem(`kesher.chat.bp.${convId}`) ?? "";
  } catch {
    return "";
  }
}

/** The line added to each message while a Blueprint is connected, so the agent knows what "it" is. */
export function blueprintContext(path: string): string {
  return path ? `\n\n[Connected Unreal Blueprint: ${path}. Use unreal_read_graph, unreal_change_graph and unreal_test_blueprint on it.]` : "";
}

/**
 * The Unreal Blueprint panel of a regular chat: pick a Blueprint to connect,
 * see its graph (it refreshes after each answer), and "Test" it: the chat's
 * agent plays the game in Unreal, reads the log and picture, and answers in
 * the chat.
 *
 * @param props.convId - The chat.
 * @param props.refresh - Changes when the chat moved on (the graph is read again).
 * @param props.onSend - Sends a message in the chat.
 * @param props.onChange - Tells the chat which Blueprint is connected.
 */
export function BlueprintChatPanel({ convId, refresh, onSend, onChange, busy }: { convId: string; refresh: number; onSend: (text: string) => void; onChange: (path: string) => void; busy: boolean }) {
  const [list, setList] = useState<Array<{ path: string; name: string; parent?: string; saved?: boolean }>>([]);
  const [connected, setConnected] = useState(false);
  const [path, setPath] = useState(() => chatBlueprint(convId));
  const [g, setG] = useState<Graph | null>(null);
  const [graphName, setGraphName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ connected: boolean }>("/api/unreal").then((r) => setConnected(r.connected), () => setConnected(false));
    void api<{ blueprints: Array<{ path: string; name: string; parent?: string; saved?: boolean }> }>("/api/unreal/blueprints").then((r) => setList(r.blueprints), (e: Error) => setError(e.message));
  }, []);
  const load = () => {
    if (!path) {
      setG(null);
      return;
    }
    void api<{ graph: Graph }>(`/api/unreal/graph?path=${encodeURIComponent(path)}`).then(
      (r) => {
        setG(r.graph);
        setError("");
        setGraphName((n) => (r.graph.graphs.some((x) => x.name === n) ? n : r.graph.graphs[0]?.name ?? ""));
      },
      (e: Error) => setError(e.message),
    );
  };
  useEffect(load, [path, refresh]);

  const choose = (p: string) => {
    setPath(p);
    onChange(p);
    try {
      if (p) localStorage.setItem(`kesher.chat.bp.${convId}`, p);
      else localStorage.removeItem(`kesher.chat.bp.${convId}`);
    } catch {
      // private window: not remembered
    }
  };
  const graph = g?.graphs.find((x) => x.name === graphName) ?? g?.graphs[0];
  const name = list.find((b) => b.path === path)?.name ?? path.split(".").pop() ?? "";
  const test = () =>
    onSend(L(`בדוק את ה-Blueprint ${name}: הרץ אותו ב-Unreal עם unreal_test_blueprint, קרא את הלוג והתמונה, ותגיד אם הוא עושה מה שהוא אמור. אם יש בעיה — הסבר ותציע תיקון.`, `Test the Blueprint ${name}: run it in Unreal with unreal_test_blueprint, read the log and the picture, and tell me whether it does what it should. If something is wrong, explain and suggest a fix.`));

  return (
    <div className="bp-chat-panel card">
      <div className="row bp-chat-head">
        <strong>🔷 Blueprint</strong>
        <Select className="grow" value={path} onChange={(e) => choose(e.target.value)} aria-label={L("ה-Blueprint המחובר לצ'אט", "The Blueprint connected to this chat")}>
          <option value="">{L("לא מחובר", "Not connected")}</option>
          {list.map((b) => <option key={b.path} value={b.path} disabled={!connected && !b.saved}>{b.name}{b.parent ? ` · ${b.parent}` : ""}</option>)}
        </Select>
        {path && <button type="button" className="primary" disabled={!connected || busy} onClick={test} title={L("הסוכן מריץ את המשחק ב-Unreal, בודק ומחזיר תשובה בצ'אט", "The agent plays the game in Unreal, checks and answers in the chat")}>🧪 {L("בדיקה", "Test")}</button>}
        <a className="small" href="#/unreal">{L("לעורך המלא", "Full editor")}</a>
      </div>
      {!connected && <p className="muted small">{L("Unreal סגור: רואים עותק שמור. בדיקה ושינויים — כש-Unreal פתוח עם הפלאגין.", "Unreal is closed: a saved copy is shown. Testing and changes need Unreal open with the plugin.")}</p>}
      {error && <p className="error small">{error}</p>}
      {path && g && (
        <>
          {g.graphs.length > 1 && (
            <div className="ue-tabs" role="tablist">
              {g.graphs.map((x) => <button key={x.name} type="button" role="tab" aria-selected={x.name === graph?.name} className={x.name === graph?.name ? "on" : ""} onClick={() => setGraphName(x.name)}>{x.name}</button>)}
            </div>
          )}
          <div className="ue-canvas bp-chat-canvas">{graph && <BlueprintCanvas nodes={graph.nodes} path={path} graph={graph.name} editable={connected} onChanged={load} />}</div>
          <p className="muted small">{L("כל הודעה בצ'אט הזה יודעת על ה-Blueprint המחובר: אפשר לבקש שינויים ובדיקות במילים.", "Every message in this chat knows the connected Blueprint: ask for changes and tests in words.")}</p>
        </>
      )}
      {!path && <p className="muted small">{L("חברו Blueprint לצ'אט: הסוכן יוכל לקרוא, לשנות ולבדוק אותו, והגרף יוצג כאן.", "Connect a Blueprint to this chat: the agent can read, change and test it, and the graph shows here.")}</p>}
    </div>
  );
}
