import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { api, withToken } from "../api";
import { t } from "../i18n";
import { EditorPane } from "./Editor";
import { TerminalPane } from "./Terminal";
import { GitPanel } from "./GitPanel";
import { AgentCliBar } from "./AgentCliBar";

interface FileItem { path: string; size: number }
interface Node { name: string; path: string; children?: Map<string, Node> }

function buildTree(files: FileItem[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children!.has(part)) node.children!.set(part, { name: part, path, ...(i < parts.length - 1 ? { children: new Map() } : {}) });
      node = node.children!.get(part)!;
    });
  }
  return root;
}

function Tree({ node, depth, open, toggle, onOpen, current }: { node: Node; depth: number; open: Set<string>; toggle: (p: string) => void; onOpen: (p: string) => void; current: string }) {
  const kids = [...(node.children?.values() ?? [])].sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
  return (
    <>
      {kids.map((k) =>
        k.children ? (
          <div key={k.path}>
            <button type="button" className="tree-row" style={{ paddingInlineStart: 8 + depth * 14 }} aria-expanded={open.has(k.path)} onClick={() => toggle(k.path)}>
              <span className={`chev ${open.has(k.path) ? "down" : ""}`} aria-hidden /> {k.name}
            </button>
            {open.has(k.path) && <Tree node={k} depth={depth + 1} open={open} toggle={toggle} onOpen={onOpen} current={current} />}
          </div>
        ) : (
          <button key={k.path} type="button" className={`tree-row file ${current === k.path ? "on" : ""}`} style={{ paddingInlineStart: 22 + depth * 14 }} onClick={() => onOpen(k.path)}>
            {k.name}
          </button>
        ),
      )}
    </>
  );
}

/**
 * The IDE side of a conversation: the folder's files with an editor, the
 * changes the agent made (and git's view of them), and a terminal.
 *
 * @param props.convId - Conversation id.
 * @param props.events - The conversation's events, for the Changes tab.
 * @param props.refresh - Changes whenever a tool finished.
 * @param props.onFixInChat - Puts text into the chat's message box (a failed git step).
 */
export function Workspace({ convId, events, refresh, onFixInChat }: { convId: string; events: AgentEvent[]; refresh: number; onFixInChat?: (text: string) => void }) {
  const [tab, setTab] = useState<"files" | "changes" | "terminal">("files");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState("");
  // Keep the terminal alive while other tabs are shown.
  const [terminalStarted, setTerminalStarted] = useState(false);
  // A fresh terminal (n) that may start a known command (Antigravity CLI, or its install).
  const [termRun, setTermRun] = useState<{ run?: string; n: number }>({ n: 0 });

  useEffect(() => {
    void api<{ files: FileItem[] }>(`/api/conversations/${convId}/files`).then((d) => setFiles(d.files)).catch(() => undefined);
  }, [convId, refresh]);
  useEffect(() => {
    if (tab === "terminal") setTerminalStarted(true);
  }, [tab]);

  const tree = useMemo(() => buildTree(files), [files]);
  const changes = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result" && !!e.diff);
  const toggle = (p: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });

  return (
    <aside className="workspace" aria-label={t("workspace")}>
      <nav className="tabs ws-tabs" role="tablist">
        {(["files", "changes", "terminal"] as const).map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
            {t(`ws-${x}`)}
            {x === "changes" && changes.length > 0 && <span className="tab-count">{changes.length}</span>}
          </button>
        ))}
      </nav>

      {tab === "files" && (
        <div className="ws-files">
          <div className="tree" dir="ltr">
            {files.length === 0 ? <p className="muted small">{t("noFiles")}</p> : <Tree node={tree} depth={0} open={open} toggle={toggle} onOpen={setCurrent} current={current} />}
          </div>
          <div className="ws-editor">
            {current ? (
              <>
                <EditorPane convId={convId} path={current} reloadKey={refresh} />
                <a className="muted small ws-download" href={withToken(`/api/conversations/${convId}/files/download?path=${encodeURIComponent(current)}`)} download>{t("download")}</a>
              </>
            ) : (
              <p className="muted ws-empty">{t("pickFile")}</p>
            )}
          </div>
        </div>
      )}

      {tab === "changes" && (
        <div className="ws-changes">
          <GitPanel convId={convId} refresh={refresh} {...(onFixInChat ? { onFixInChat } : {})} />
          {changes.length > 0 && <strong className="small muted">{t("ws-agentEdits")}</strong>}
          {changes.map((c) => (
            <details key={c.seq} open={changes.length < 4}>
              <summary className="mono" dir="ltr">{c.diff!.split("\n")[0]?.replace(/^---\s+(a\/)?/, "")}</summary>
              <pre className="code diff" dir="ltr">
                {c.diff!.split("\n").map((l, i) => (
                  <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
                    {l}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </details>
          ))}
        </div>
      )}

      {terminalStarted && (
        <div className="ws-terminal" hidden={tab !== "terminal"}>
          <AgentCliBar convId={convId} onRun={(r) => setTermRun({ run: r, n: termRun.n + 1 })} />
          <TerminalPane key={termRun.n} convId={convId} {...(termRun.run ? { run: termRun.run } : {})} />
        </div>
      )}
    </aside>
  );
}
