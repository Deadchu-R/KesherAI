import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentSessionInfo, ConversationSummary, ModelInfo, PermissionMode } from "@kesher/shared";
import { api, withToken } from "../api";
import { refreshLibrary, useLibrary } from "../library";
import { useModels } from "../useModels";
import { t } from "../i18n";

type Loaded = ConversationSummary & { session: AgentSessionInfo; events: AgentEvent[] };
type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

/** Renders text with ``` fenced code blocks as code. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) out.push(<span key={i}>{parts[i]}</span>);
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
    <details className={`tool ${state}`} open={!!result?.diff || !!result?.assetIds?.length}>
      <summary>
        <span className="mono">{call.name}</span> <span className="mono muted" dir="ltr">{summary(call.name, call.input)}</span>
        <span className="tool-state">{state === "pending" ? "…" : state === "ok" ? "✓" : "✕"}</span>
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

function ApprovalCard({ convId, ev, pending, result }: { convId: string; ev: Ev<"approval_request">; pending: boolean; result?: Ev<"approval_result"> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "allow" | "always" | "deny") => {
    setBusy(true);
    await api(`/api/conversations/${convId}/approvals/${ev.requestId}`, { method: "POST", body: { decision, ...(note ? { feedback: note } : {}) } }).catch(() => undefined);
    setBusy(false);
  };
  if (!pending) {
    const d = result?.decision;
    return (
      <p className="muted approval-done">
        {ev.name} · {d === "deny" ? t("denied") : d === "expired" ? t("expired") : t("allowed")}
      </p>
    );
  }
  return (
    <div className="card approval" role="group" aria-label={reasonText(ev.reason)}>
      <strong>{reasonText(ev.reason)}</strong>
      {ev.name === "run_command" ? <pre className="code" dir="ltr">{ev.preview}</pre> : ev.preview.startsWith("---") || ev.preview.includes("@@") ? <Diff diff={ev.preview} /> : <pre className="code" dir="ltr">{ev.preview}</pre>}
      <input placeholder={t("noteForAgent")} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("noteForAgent")} />
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void decide("allow")}>{t("allow")}</button>
        <button type="button" disabled={busy} onClick={() => void decide("always")}>{t("allowAlways")}</button>
        <button type="button" disabled={busy} onClick={() => void decide("deny")}>{t("deny")}</button>
      </div>
    </div>
  );
}

function QuestionCard({ convId, ev, pending, answer }: { convId: string; ev: Ev<"question">; pending: boolean; answer?: Ev<"answer"> }) {
  const [text, setText] = useState("");
  const send = (value: string) => void api(`/api/conversations/${convId}/answers/${ev.questionId}`, { method: "POST", body: { text: value } }).catch(() => undefined);
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
  const answers = useMemo(() => new Map(events.filter((e): e is Ev<"answer"> => e.type === "answer").map((e) => [e.questionId, e])), [events]);

  if (!conv) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">…</p>}</div>;

  const busy = info?.status === "running" || info?.status === "waiting";
  // The server titles a conversation from its first message; the sidebar list has the latest title.
  const title = conversations.find((c) => c.id === id)?.title ?? conv.title;
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError("");
    try {
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text } });
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
      setInput(text);
    }
  };
  const patch = async (body: Partial<{ title: string; modelId: string; mode: PermissionMode }>) => {
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
      <div className="topbar">
        {editingTitle ? (
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); setEditingTitle(false); void patch({ title: (e.currentTarget.elements.namedItem("title") as HTMLInputElement).value }); }}>
            <input name="title" className="grow" defaultValue={title} autoFocus aria-label={t("rename")} />
            <button type="submit">{t("save")}</button>
          </form>
        ) : (
          <button type="button" className="title-btn grow" onClick={() => setEditingTitle(true)} title={t("rename")}>
            {conv.kind === "code" ? "</> " : ""}{title}
          </button>
        )}
        <select value={conv.modelId} onChange={(e) => void patch({ modelId: e.target.value })} aria-label={t("pickModel")}>
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>{m.name} · {m.providerId || "?"}</option>
          ))}
        </select>
        {conv.kind === "code" && (
          <select value={info?.mode ?? conv.mode} onChange={(e) => void patch({ mode: e.target.value as PermissionMode })} aria-label={t("mode")}>
            <option value="ask">{t("modeAsk")}</option>
            <option value="auto-edit">{t("modeAutoEdit")}</option>
            <option value="auto">{t("modeAuto")}</option>
          </select>
        )}
        {info?.canUndo && !busy && (
          <button type="button" onClick={() => void api(`/api/conversations/${id}/undo`, { method: "POST" }).catch((e: Error) => setError(e.message))}>{t("undo")}</button>
        )}
        <button type="button" onClick={() => void remove()} aria-label={t("delete")}>{t("delete")}</button>
      </div>
      {info?.workspace && <div className="workspace-bar mono" dir="ltr">{info.workspace}</div>}

      <div className="chat">
        <div className="messages" aria-live="polite">
          {events.length === 0 && (
            <p className="muted empty">{conv.kind === "code" ? t("emptyCode", { folder: info?.workspace ?? "" }) : t("emptyChat")}</p>
          )}
          {events.map((e) => {
            switch (e.type) {
              case "user":
                return <div key={e.seq} className="msg user">{e.text}</div>;
              case "assistant":
                return <div key={e.seq} className="msg"><RichText text={e.text} /></div>;
              case "tool_call":
                return <ToolCard key={e.seq} call={e} result={byCall.get(e.callId)} />;
              case "approval_request":
                return <ApprovalCard key={e.seq} convId={id} ev={e} pending={!!info?.pendingApprovals.includes(e.requestId)} result={approvalResults.get(e.requestId)} />;
              case "question":
                return <QuestionCard key={e.seq} convId={id} ev={e} pending={!!info?.pendingQuestions.includes(e.questionId)} answer={answers.get(e.questionId)} />;
              case "note":
                return <p key={e.seq} className="muted note">{e.text}</p>;
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
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
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
            {busy ? (
              <button type="button" onClick={() => void api(`/api/conversations/${id}/stop`, { method: "POST" })}>{t("stop")}</button>
            ) : (
              <button type="submit" className="primary" disabled={!input.trim()}>{t("send")}</button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
