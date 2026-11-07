import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentEvent, AgentSessionInfo, ConversationSummary, ModelInfo, PermissionMode, Teammate } from "@kesher/shared";
import { explainCommand } from "@kesher/shared";
import { api, withToken } from "../api";
import { desktop, refreshLibrary, useLibrary } from "../library";
import { useModels } from "../useModels";
import { ModelMenu } from "../ModelMenu";
import { CoachPanel } from "../CoachPanel";
import { WebToggle, useWebSearch } from "../WebToggle";
import { Mic } from "../Mic";
import { PluginFrame, usePluginUi } from "../plugins";
import { FilesPanel } from "../FilesPanel";
// The editor and terminal are big; load them only when the IDE panel opens.
const Workspace = lazy(() => import("../ide/Workspace").then((m) => ({ default: m.Workspace })));
import { ActivityGroup, stepLabel, type Step } from "../Activity";
import { getLocale, t } from "../i18n";

type Loaded = ConversationSummary & { session: AgentSessionInfo; events: AgentEvent[] };
type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

/** Inline Markdown: **bold**, *italic*, `code` and [links](https://…). */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="inline-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(<a key={k} href={href} target="_blank" rel="noreferrer">{label}</a>);
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders a reply's Markdown: headings, lists, bold, code blocks and inline code. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose) {
      const lines = prose.split("\n");
      let list: { ordered: boolean; items: React.ReactNode[] } | null = null;
      const flush = (k: string) => {
        if (!list) return;
        out.push(list.ordered ? <ol key={k}>{list.items}</ol> : <ul key={k}>{list.items}</ul>);
        list = null;
      };
      lines.forEach((line, j) => {
        const k = `${i}-${j}`;
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (h) {
          flush(`l${k}`);
          out.push(<p key={k} className={`md-h md-h${h[1]!.length}`}>{inline(h[2]!, k)}</p>);
        } else if (li) {
          const ordered = !!li[2];
          if (!list || list.ordered !== ordered) {
            flush(`l${k}`);
            list = { ordered, items: [] };
          }
          list.items.push(<li key={k}>{inline(li[3]!, k)}</li>);
        } else {
          flush(`l${k}`);
          if (line.trim()) out.push(<p key={k}>{inline(line, k)}</p>);
        }
      });
      flush(`l${i}-end`);
    }
    if (parts[i + 2] !== undefined) out.push(<pre key={`c${i}`} className="code" dir="ltr"><code>{parts[i + 2]}</code></pre>);
  }
  return <div className="msg-text">{out}</div>;
}

/** Colours a unified diff. */
function Diff({ diff }: { diff: string }) {
  return (
    <pre className="code diff" dir="ltr">
      {diff.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function summary(name: string, input: Record<string, unknown>): string {
  const v = input.path ?? input.command ?? input.pattern ?? input.prompt ?? input.glob ?? input.question;
  return typeof v === "string" ? v : "";
}

function ToolCard({ call, result }: { call: Ev<"tool_call">; result?: Ev<"tool_result"> }) {
  if (call.name === "ask_user") return null;
  const state = !result ? "pending" : result.ok ? "ok" : "fail";
  return (
    <details className={`tool ${state}`}>
      <summary>
        <span className="tool-state" aria-hidden>{state === "pending" ? "…" : state === "ok" ? "✓" : "✕"}</span>
        <span className="tool-label" dir="auto">{stepLabel({ call, ...(result ? { result } : {}) })}</span>
      </summary>
      {result?.diff && <Diff diff={result.diff} />}
      {result?.assetIds?.map((id) => (
        <img key={id} src={withToken(`/api/assets/${id}`)} alt={summary(call.name, call.input)} className="asset" />
      ))}
      {result && !result.diff && <pre className="code" dir="ltr">{result.output}</pre>}
    </details>
  );
}

/** Shows the server's approval reason in the user's language. */
function reasonText(reason: string): string {
  if (reason === "The agent wants to change a file.") return t("reasonWrite");
  if (reason === "The agent wants to run a command on your computer.") return t("reasonExec");
  const danger = /^This command (.+), so it always needs your approval\.$/.exec(reason);
  if (danger) return t("reasonDanger", { what: danger[1]! });
  return reason;
}

/**
 * Multi-model chat: pick a planner (writes a plan before each request) and a
 * reviewer (checks the answer and sends it back with notes) next to the
 * main model. Any connected model can take either job.
 */
function TeamButton({ team, models, onChange }: { team: Teammate[]; models: ModelInfo[]; onChange: (team: Teammate[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".model-pop")) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  const of = (role: Teammate["role"]) => team.find((m) => m.role === role)?.modelId ?? "";
  const set = (role: Teammate["role"], modelId: string) => onChange([...team.filter((m) => m.role !== role), ...(modelId ? [{ role, modelId }] : [])]);
  return (
    <div className="team" ref={ref}>
      <button type="button" className={team.length ? "on" : ""} aria-expanded={open} onClick={() => setOpen(!open)} title={t("teamHint")}>
        {t("team")}{team.length ? ` (${team.length + 1})` : ""}
      </button>
      {open && (
        <div className="team-pop" role="dialog" aria-label={t("team")}>
          <p className="muted small">{t("teamHint")}</p>
          {(["planner", "reviewer"] as const).map((role) => (
            <div key={role} className="team-row">
              <div>
                <strong>{role === "planner" ? t("rolePlanner") : t("roleReviewer")}</strong>
                <p className="muted small">{role === "planner" ? t("plannerHint") : t("reviewerHint")}</p>
              </div>
              <div className="row">
                {of(role) ? (
                  <>
                    <ModelMenu models={models} value={of(role)} onChange={(id) => set(role, id)} />
                    <button type="button" className="link-btn" onClick={() => set(role, "")}>{t("remove")}</button>
                  </>
                ) : (
                  <button type="button" onClick={() => models[0] && set(role, models[0].id)} disabled={!models.length}>{t("addTeammate")}</button>
                )}
              </div>
            </div>
          ))}
          <p className="muted small">{t("teamCost")}</p>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ convId, ev, pending, result }: { convId: string; ev: Ev<"approval_request">; pending: boolean; result?: Ev<"approval_result"> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const decide = async (decision: "allow" | "always" | "deny", scope?: "conversation" | "model" | "everywhere") => {
    setBusy(true);
    await api(`/api/conversations/${convId}/approvals/${ev.requestId}`, { method: "POST", body: { decision, ...(scope ? { scope } : {}), ...(note ? { feedback: note } : {}) } }).catch(() => undefined);
    setBusy(false);
  };
  if (!pending) {
    const d = result?.decision;
    return (
      <p className="muted approval-done">
        <span dir="auto">{summary(ev.name, ev.input)}</span> · {d === "deny" ? t("denied") : d === "expired" ? t("expired") : t("allowed")}
      </p>
    );
  }
  const cmd = ev.name === "run_command" && typeof ev.input.command === "string" ? ev.input.command : ev.name === "install_tool" ? ev.preview.split("\n").pop() : undefined;
  const parts = cmd ? explainCommand(cmd) : [];
  const he = getLocale() === "he";
  const path = typeof ev.input.path === "string" ? ev.input.path : "";
  const headline =
    ev.name === "run_command" ? t("apRun")
    : ev.name === "install_tool" ? t("apInstall", { what: String(ev.input.name ?? "") })
    : ev.name === "build_executable" ? t("apBuild", { what: String(ev.input.entry ?? "") })
    : ev.name === "download_file" ? t("apDownload")
    : ev.name === "computer_use_app" ? t("apComputer", { what: String(ev.input.app ?? "") })
    : ev.name === "write_file" || ev.name === "edit_file" ? t("apWrite", { what: path })
    : reasonText(ev.reason);
  const danger = /^This command .+, so it always needs your approval\.$/.test(ev.reason);
  return (
    <div className="card approval" role="group" aria-label={headline}>
      <strong dir="auto">{headline}</strong>
      {danger && <p className="ap-danger">⚠ {reasonText(ev.reason)}</p>}
      {ev.purpose && (
        <div className="ap-why">
          <span className="muted small">{t("apWhy")}</span>
          <p dir="auto">{ev.purpose}</p>
        </div>
      )}
      {ev.name === "run_command" ? <pre className="code" dir="ltr">{ev.preview}</pre> : ev.preview.startsWith("---") || ev.preview.includes("@@") ? <Diff diff={ev.preview} /> : <pre className="code" dir="ltr">{ev.preview}</pre>}
      {parts.length > 0 && (
        <div className="ap-what">
          <span className="muted small">{t("apWhat")}</span>
          <ul>
            {parts.map((p, i) => (
              <li key={i} className={p.risky ? "risky" : ""}>
                <span dir="auto">{he ? p.he : p.en}</span>
                {parts.length > 1 && <code dir="ltr">{p.text}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {ev.folder && (
        <p className="muted small">
          {t("apWhere")} <code dir="ltr">{ev.folder}</code>
        </p>
      )}
      <input placeholder={t("noteForAgent")} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("noteForAgent")} />
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void decide("allow")}>{t("allow")}</button>
        <button type="button" disabled={busy} aria-expanded={scopeOpen} onClick={() => setScopeOpen(!scopeOpen)}>{t("allowAlways")} ▾</button>
        <button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("deny")}</button>
      </div>
      {scopeOpen && (
        <div className="scope-menu" role="menu">
          <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "conversation")}>{t("alwaysChat", { tool: ev.name })}</button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "model")}>{t("alwaysModel", { tool: ev.name })}</button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => void decide("always", "everywhere")}>{t("alwaysEverywhere", { tool: ev.name })}</button>
          <span className="muted small">{t("alwaysNote")}</span>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ convId, ev, pending, answer }: { convId: string; ev: Ev<"question">; pending: boolean; answer?: Ev<"answer"> }) {
  const [text, setText] = useState(ev.path ?? "");
  const send = (value: string) => void api(`/api/conversations/${convId}/answers/${ev.questionId}`, { method: "POST", body: { text: value } }).catch(() => undefined);
  if (ev.kind === "access") {
    // The agent asks for a folder or file outside its own: allow it, pick another, or refuse.
    return (
      <div className={`card question access ${pending ? "" : "done"}`}>
        <strong>{t("accessRequest")}</strong>
        <p>{ev.question}</p>
        {pending ? (
          <>
            <input className="mono" dir="ltr" value={text} onChange={(e) => setText(e.target.value)} placeholder="C:\Users\…" aria-label={t("accessPath")} />
            <div className="row">
              <button type="button" className="primary" disabled={!text.trim()} onClick={() => send(text.trim())}>{t("allowAccess")}</button>
              {desktop() && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && send(f))}>{t("chooseFolder")}</button>}
              {desktop()?.pickFiles && <button type="button" onClick={() => void desktop()!.pickFiles!().then((f) => f[0] && send(f[0]))}>{t("chooseFile")}</button>}
              <button type="button" onClick={() => send("")}>{t("refuse")}</button>
            </div>
          </>
        ) : (
          <p className="muted mono" dir="ltr">{answer?.text ? `✓ ${answer.text}` : t("refused")}</p>
        )}
      </div>
    );
  }
  return (
    <div className={`card question ${pending ? "" : "done"}`}>
      <strong>{ev.question}</strong>
      {pending ? (
        <>
          {ev.options && (
            <div className="row">
              {ev.options.map((o) => (
                <button key={o} type="button" onClick={() => send(o)}>{o}</button>
              ))}
            </div>
          )}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send(text.trim()); }}>
            <input className="grow" value={text} onChange={(e) => setText(e.target.value)} aria-label={t("answer")} />
            <button type="submit" className="primary">{t("answer")}</button>
          </form>
        </>
      ) : (
        <p className="muted">{answer?.text}</p>
      )}
    </div>
  );
}

/** One conversation: chat or code, with live events, approvals and questions. */
export function ConversationPage({ id }: { id: string }) {
  const [conv, setConv] = useState<Loaded | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [info, setInfo] = useState<AgentSessionInfo | null>(null);
  const [streaming, setStreaming] = useState<Record<number, string>>({});
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleMenu, setTitleMenu] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [web, setWeb] = useWebSearch();
  const [openPanel, setOpenPanel] = useState("");
  const pluginUi = usePluginUi();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("appbar-title")), []);
  useEffect(() => {
    if (!titleMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest?.(".bar-conv")) setTitleMenu(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [titleMenu]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [ideOpen, setIdeOpen] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const { models } = useModels("chat");
  const { conversations } = useLibrary();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;
    setConv(null);
    setEvents([]);
    setStreaming({});
    setError("");
    api<Loaded>(`/api/conversations/${id}`)
      .then((c) => {
        if (cancelled) return;
        setConv(c);
        setEvents(c.events);
        setInfo(c.session);
        const last = c.events.at(-1)?.seq ?? 0;
        es = new EventSource(withToken(`/api/conversations/${id}/events?after=${last}`));
        es.onmessage = (m) => {
          const e = JSON.parse(m.data as string) as AgentEvent | ({ type: "info" } & AgentSessionInfo) | { type: "ping" };
          if (e.type === "ping") return;
          if (e.type === "info") {
            const { type: _t, ...rest } = e;
            setInfo(rest);
            if (rest.status === "idle") void refreshLibrary().catch(() => undefined);
            return;
          }
          if (e.type === "assistant_delta") {
            setStreaming((s) => ({ ...s, [e.turn]: (s[e.turn] ?? "") + e.text }));
            return;
          }
          if (e.type === "assistant") setStreaming((s) => { const n = { ...s }; delete n[e.turn]; return n; });
          if (e.type === "status" && e.status === "error") setError(e.message ?? "Error");
          setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
        };
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [events.length, streaming]);

  const byCall = useMemo(() => {
    const m = new Map<string, Ev<"tool_result">>();
    for (const e of events) if (e.type === "tool_result") m.set(e.callId, e);
    return m;
  }, [events]);
  const approvalResults = useMemo(() => new Map(events.filter((e): e is Ev<"approval_result"> => e.type === "approval_result").map((e) => [e.requestId, e])), [events]);
  // The agent's tool calls between two messages are folded into one "activity" line, like Claude's.
  const blocks = useMemo(() => {
    const out: Array<{ kind: "event"; e: AgentEvent } | { kind: "group"; key: number; steps: Step[] }> = [];
    let group: Step[] | null = null;
    for (const e of events) {
      if (e.type === "tool_call") {
        if (e.name === "ask_user" || e.name === "request_access") continue; // their question card shows instead
        if (!group) {
          group = [];
          out.push({ kind: "group", key: e.seq, steps: group });
        }
        const result = byCall.get(e.callId);
        group.push({ call: e, ...(result ? { result } : {}) });
        continue;
      }
      if (e.type === "tool_result" || e.type === "approval_result" || e.type === "answer" || e.type === "usage" || (e.type === "status" && e.status !== "error")) continue;
      group = null;
      out.push({ kind: "event", e });
    }
    return out;
  }, [events, byCall]);

  // Every finished tool may have changed files: refresh the Files count, and open the panel when a program was built.
  const toolResults = useMemo(() => events.filter((e) => e.type === "tool_result").length, [events]);
  const lastBuild = useMemo(() => [...events].reverse().find((e): e is Ev<"tool_result"> => e.type === "tool_result" && e.name === "build_executable" && e.ok), [events]);
  useEffect(() => {
    void api<{ files: unknown[] }>(`/api/conversations/${id}/files`).then((d) => setFileCount(d.files.length)).catch(() => undefined);
  }, [id, toolResults]);
  useEffect(() => {
    if (lastBuild) setFilesOpen(true);
  }, [lastBuild?.seq]);
  const answers = useMemo(() => new Map(events.filter((e): e is Ev<"answer"> => e.type === "answer").map((e) => [e.questionId, e])), [events]);

  if (!conv) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">…</p>}</div>;

  const busy = info?.status === "running" || info?.status === "waiting";
  // Code sessions open with the IDE panel; chats can open it with the button.
  const showIde = ideOpen ?? conv.kind === "code";
  // The server titles a conversation from its first message; the sidebar list has the latest title.
  const title = conversations.find((c) => c.id === id)?.title ?? conv.title;
  const send = async () => {
    const text = input.trim();
    // While the agent works, the message joins the queue and goes when it is free.
    if (!text) return;
    setInput("");
    setError("");
    try {
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text, ...(web ? { web: true } : {}) } });
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
      setInput(text);
    }
  };
  /** Gives the agent access to files the user attached, and names them in the message. */
  const attach = async (paths: string[]) => {
    const added: string[] = [];
    for (const p of paths) {
      try {
        const r = await api<{ path: string }>(`/api/conversations/${id}/access`, { method: "POST", body: { path: p } });
        added.push(r.path);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    if (added.length) setInput((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${added.map((p) => `[${t("attached")}: ${p}]`).join("\n")}\n`);
  };
  const patch = async (body: Partial<{ title: string; modelId: string; mode: PermissionMode; team: Teammate[] }>) => {
    await api(`/api/conversations/${id}`, { method: "PATCH", body }).catch((e: Error) => setError(e.message));
    setConv({ ...conv, ...body });
    await refreshLibrary().catch(() => undefined);
  };
  const remove = async () => {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    await refreshLibrary();
    location.hash = "#/";
  };

  const modelOptions: ModelInfo[] = models.some((m) => m.id === conv.modelId)
    ? models
    : [{ id: conv.modelId, name: conv.modelId, providerId: "", providerModelId: "", category: "chat", location: "local" }, ...models];

  return (
    <>
      {slot && createPortal(
        editingTitle ? (
          <form className="bar-rename" onSubmit={(e) => { e.preventDefault(); setEditingTitle(false); void patch({ title: (e.currentTarget.elements.namedItem("title") as HTMLInputElement).value }); }}>
            <input name="title" defaultValue={title} autoFocus aria-label={t("rename")} onBlur={() => setEditingTitle(false)} onKeyDown={(e) => e.key === "Escape" && setEditingTitle(false)} />
          </form>
        ) : (
          <div className="bar-conv">
            <button type="button" className="bar-title" aria-haspopup="menu" aria-expanded={titleMenu} aria-label={t("convMenu")} onClick={() => setTitleMenu(!titleMenu)}>
              <span className="bar-title-text" dir="auto">{conv.kind === "code" ? "</> " : ""}{title}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {titleMenu && (
              <div className="bar-pop" role="menu">
                <button type="button" role="menuitem" onClick={() => { setTitleMenu(false); setEditingTitle(true); }}>{t("rename")}</button>
                {info?.workspace && desktop()?.openPath && <button type="button" role="menuitem" onClick={() => { setTitleMenu(false); void desktop()!.openPath!(info.workspace!); }}>{t("openFolder")}</button>}
                <button type="button" role="menuitem" className="danger" onClick={() => { setTitleMenu(false); void remove(); }}>{t("delete")}</button>
              </div>
            )}
          </div>
        ),
        slot,
      )}
      <div className="topbar conv-tools" data-conv-kind={conv.kind}>
        <TeamButton team={conv.team ?? []} models={models} onChange={(team) => void patch({ team })} />
        {pluginUi.panels.map((x) => {
          const key = `${x.pluginId}/${x.id}`;
          return <button key={key} type="button" className={openPanel === key ? "on" : ""} aria-pressed={openPanel === key} onClick={() => setOpenPanel(openPanel === key ? "" : key)}>{x.title}</button>;
        })}
        <button type="button" className={coachOpen ? "on" : ""} aria-pressed={coachOpen} onClick={() => setCoachOpen(!coachOpen)} title={t("coachHint")}>{t("coach")}</button>
        <span className="grow" />
        {info?.canUndo && !busy && (
          <button type="button" onClick={() => void api(`/api/conversations/${id}/undo`, { method: "POST" }).catch((e: Error) => setError(e.message))}>{t("undo")}</button>
        )}
        <button type="button" className={showIde ? "on" : ""} aria-pressed={showIde} onClick={() => setIdeOpen(!showIde)} title={t("workspaceHint")}>
          {t("workspace")}
        </button>
        <button type="button" className={filesOpen ? "on" : ""} aria-pressed={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
          {t("files")}{fileCount ? ` (${fileCount})` : ""}
        </button>
      </div>
      {conv.kind === "code" && info?.workspace && <div className="workspace-bar mono" dir="ltr">{info.workspace}</div>}
      {filesOpen && <FilesPanel convId={id} refresh={toolResults} onCount={(n) => setFileCount(n)} />}
      {openPanel && (() => {
        const panel = pluginUi.panels.find((x) => `${x.pluginId}/${x.id}` === openPanel);
        return panel ? <div className="plugin-panel"><PluginFrame pluginId={panel.pluginId} file={panel.file} title={panel.title} conversationId={id} onInsertPrompt={setInput} /></div> : null;
      })()}
      {coachOpen && <CoachPanel convId={id} refresh={events.length} onUsePrompt={(text) => setInput(text)} />}

      <div className={`conv-split ${showIde ? "with-ide" : ""}`}>
      <div className="chat">
        <div className="messages" aria-live="polite">
          {events.length === 0 && (
            <p className="muted empty">{conv.kind === "code" ? t("emptyCode", { folder: info?.workspace ?? "" }) : t("emptyChat")}</p>
          )}
          {blocks.map((b, bi) => {
            if (b.kind === "group") {
              return (
                <ActivityGroup
                  key={`g${b.key}`}
                  steps={b.steps}
                  live={busy && bi === blocks.length - 1}
                  convId={id}
                  renderStep={(s) => <ToolCard call={s.call} {...(s.result ? { result: s.result } : {})} />}
                />
              );
            }
            const e = b.e;
            switch (e.type) {
              case "user":
                return <div key={e.seq} className="msg user">{e.text}</div>;
              case "assistant":
                return <div key={e.seq} className="msg"><RichText text={e.text} /></div>;
              case "approval_request":
                return <ApprovalCard key={e.seq} convId={id} ev={e} pending={!!info?.pendingApprovals.includes(e.requestId)} result={approvalResults.get(e.requestId)} />;
              case "question":
                return <QuestionCard key={e.seq} convId={id} ev={e} pending={!!info?.pendingQuestions.includes(e.questionId)} answer={answers.get(e.questionId)} />;
              case "teammate":
                return (
                  <details key={e.seq} className={`teammate ${e.role}${e.approved === false ? " sent-back" : ""}`} open={e.role === "reviewer" && e.approved === false}>
                    <summary>
                      <span className="mate-role">{e.role === "planner" ? t("rolePlanner") : t("roleReviewer")}</span>
                      <span className="mate-model" dir="ltr">{e.modelId.split("/").pop()}</span>
                      {e.role === "reviewer" && <span className={`pill ${e.approved ? "good" : "bad"}`}>{e.approved ? t("reviewApproved") : t("reviewSentBack")}</span>}
                    </summary>
                    <div className="mate-body"><RichText text={e.text.replace(/^\s*\**APPROVED\**[:.]?\s*/i, "")} /></div>
                  </details>
                );
              case "note":
                return <p key={e.seq} className="muted note">{e.text}</p>;
              case "compacted":
                return <p key={e.seq} className="muted note">{t("compactedNote")}</p>;
              case "access":
                return <p key={e.seq} className="muted note" dir="auto">{t("accessGiven")} <span className="mono" dir="ltr">{e.path}</span></p>;
              case "undo":
                return <p key={e.seq} className="muted note">{t("undone", { path: e.path })}</p>;
              case "status":
                return e.status === "error" ? <p key={e.seq} className="error">{e.message}</p> : null;
              default:
                return null;
            }
          })}
          {Object.entries(streaming).map(([turn, text]) => (
            <div key={`s${turn}`} className="msg streaming"><RichText text={text} /></div>
          ))}
          {busy && (
            <p className="muted status-line">{info?.status === "waiting" ? t("waitingForYou") : t("working")}</p>
          )}
          {error && <p className="error">{error}</p>}
          <div ref={bottom} />
        </div>
        <form
          className={`composer ${dragging ? "dragging" : ""}`}
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          onDragOver={(e) => { if (desktop()?.pathOf) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            const bridge = desktop();
            if (!bridge?.pathOf) return;
            e.preventDefault();
            setDragging(false);
            const paths = [...e.dataTransfer.files].map((f) => bridge.pathOf!(f)).filter(Boolean);
            void attach(paths);
          }}
        >
          <div className="box">
            <textarea
              rows={2}
              value={input}
              placeholder={conv.kind === "code" ? t("codePlaceholder") : t("messagePlaceholder")}
              aria-label={t("messagePlaceholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {(info?.queued?.length ?? 0) > 0 && (
              <div className="queue" aria-label={t("queueTitle")}>
                <div className="queue-head small">
                  <span>{info!.queuePaused ? t("queuePaused") : t("queueWaiting", { n: info!.queued.length })}</span>
                  {info!.queuePaused && <button type="button" className="link-btn" onClick={() => void api(`/api/conversations/${id}/queue/resume`, { method: "POST" })}>{t("queueResume")}</button>}
                </div>
                <ol>
                  {info!.queued.map((q, i) => (
                    <li key={q.id}>
                      <span className="queue-n" aria-hidden>{i + 1}</span>
                      <span className="queue-text" dir="auto">{q.text}</span>
                      <button type="button" className="queue-x" aria-label={t("queueRemove")} title={t("queueRemove")} onClick={() => void api(`/api/conversations/${id}/queue/${q.id}`, { method: "DELETE" }).catch(() => undefined)}>✕</button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {pluginUi.composerActions.length > 0 && (
              <div className="composer-actions">
                {pluginUi.composerActions.map((a) => (
                  <button key={`${a.pluginId}/${a.id}`} type="button" className="chip-text" onClick={() => setInput(a.prompt)} title={a.prompt}>{a.label}</button>
                ))}
              </div>
            )}
            <div className="box-bar">
              {desktop()?.pickFiles && (
                <button type="button" className="chip" title={t("attachHint")} aria-label={t("attach")} onClick={() => void desktop()!.pickFiles!().then((f) => attach(f))}>+</button>
              )}
              <WebToggle on={web} onChange={setWeb} />
              <Mic onText={(txt) => setInput((v) => (v ? `${v.trimEnd()} ${txt}` : txt))} />
              <ModelMenu models={modelOptions} value={conv.modelId} onChange={(id) => void patch({ modelId: id })} />
              <select className="model-chip" value={info?.mode ?? conv.mode} onChange={(e) => void patch({ mode: e.target.value as PermissionMode })} aria-label={t("mode")}>
                <option value="ask">{t("modeAsk")}</option>
                <option value="auto-edit">{t("modeAutoEdit")}</option>
                <option value="auto">{t("modeAuto")}</option>
              </select>
              <span className="grow" />
              {busy ? (
                <>
                  {input.trim() && <button type="submit" className="send queue-send" aria-label={t("queueSendHint")} title={t("queueSendHint")}>↑</button>}
                  <button type="button" className="send stop" onClick={() => void api(`/api/conversations/${id}/stop`, { method: "POST" })} aria-label={t("stop")}>■</button>
                </>
              ) : (
                <button type="submit" className="primary send" disabled={!input.trim()} aria-label={t("send")}>↑</button>
              )}
            </div>
          </div>
        </form>
      </div>
      {showIde && (
        <Suspense fallback={<aside className="workspace"><p className="muted ws-empty">{t("loading")}</p></aside>}>
          <Workspace convId={id} events={events} refresh={toolResults} />
        </Suspense>
      )}
      </div>
    </>
  );
}
