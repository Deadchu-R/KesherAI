import { appearanceChanged } from "../appearance";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentEvent, AgentSessionInfo, ConversationSummary, ModelInfo, PermissionMode, Teammate } from "@kesher/shared";
import { explainCommand } from "@kesher/shared";
import { api, withToken } from "../api";
import { desktop, refreshLibrary, toast, useLibrary } from "../library";
import { useModels } from "../useModels";
import { ModelMenu } from "../ModelMenu";
import { PersonaChip, usePersonas } from "../Personas";
import { RichText } from "../RichText";
import { ContextPanel } from "../ContextPanel";
import { PromptTextarea, expandSlash } from "../SlashMenu";
import { CoachPanel } from "../CoachPanel";
import { WebToggle, useWebSearch } from "../WebToggle";
import { Mic } from "../Mic";
import { VoiceMode } from "../VoiceMode";
import { useParts } from "../parts";
import { takeOpening, uploadToConversation } from "../phone";
import { SpeakButton, autoSpeak, speak } from "../Speak";
import { PluginFrame, usePluginUi } from "../plugins";
import { FilesPanel } from "../FilesPanel";
// The editor and terminal are big; load them only when the IDE panel opens.
const Workspace = lazy(() => import("../ide/Workspace").then((m) => ({ default: m.Workspace })));
import { ActivityGroup, stepLabel, type Step } from "../Activity";
import { getLocale, t } from "../i18n";

type Loaded = ConversationSummary & { session: AgentSessionInfo; events: AgentEvent[] };
type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

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
  // Agent group: a member's part, shown as that member's answer.
  if (call.name === "ask_member") {
    const head = result?.ok ? result.output.split("\n")[0] ?? "" : "";
    const body = result?.ok ? result.output.slice(head.length + 1) : result?.output ?? "";
    return (
      <details className="teammate member" open={!!result}>
        <summary>
          <span className="mate-role">{head || `👤 ${String(call.input.member ?? "")}`}</span>
          {!result && <span className="muted small">{getLocale() === "he" ? "עובד…" : "working…"}</span>}
        </summary>
        <p className="muted small" dir="auto">{String(call.input.task ?? "")}</p>
        {result && <div className="mate-body"><RichText text={body} /></div>}
      </details>
    );
  }
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

/**
 * Agent group: personas this chat's model leads. It splits a request between
 * them (each answers with its own instructions and model) and puts it together.
 */
function GroupButton({ group, onChange }: { group: string[]; onChange: (group: string[]) => void }) {
  const personas = usePersonas();
  const [open, setOpen] = useState(false);
  const he = getLocale() === "he";
  const toggle = (id: string) => onChange(group.includes(id) ? group.filter((x) => x !== id) : [...group, id].slice(0, 8));
  return (
    <div className="team">
      <button type="button" className={group.length ? "on" : ""} aria-expanded={open} onClick={() => setOpen(!open)} title={he ? "קבוצת סוכנים: כמה פרסונות עובדות יחד על משימה" : "Agent group: several personas work on one task together"}>
        {he ? "קבוצה" : "Group"}{group.length ? ` (${group.length})` : ""}
      </button>
      {open && (
        <div className="team-pop" role="dialog" aria-label={he ? "קבוצה" : "Group"}>
          <p className="muted small">{he ? "המודל של הצ'אט מוביל את הקבוצה: הוא מחלק את הבקשה בין החברים, כל אחד עונה עם ההוראות והמודל שלו, והוא מאחד את התשובות." : "The chat's model leads the group: it splits the request between the members, each answers with its own instructions and model, and it puts their work together."}</p>
          {personas.length === 0 && <p className="small">{he ? "אין עדיין פרסונות. " : "No personas yet. "}<a href="#/personas">{he ? "צור פרסונה" : "Make one"}</a></p>}
          {personas.map((p) => (
            <label key={p.id} className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={group.includes(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.icon ?? "👤"} {p.name}</span>
              {p.modelId && <span className="muted small" dir="ltr">{p.modelId.split("/").pop()}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
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
    <div className="card approval" role="group" aria-label={headline} data-guard="">
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
/**
 * Saves the chat as a file: Markdown (downloaded), or PDF (the desktop app
 * asks where to save it; a browser opens the print dialog: "Save as PDF").
 */
function exportChat(id: string, kind: "md" | "pdf"): void {
  if (kind === "pdf" && desktop()?.saveChatPdf) {
    void desktop()!.saveChatPdf!(id).then((file) => file && toast(getLocale() === "he" ? `נשמר: ${file}` : `Saved: ${file}`), (e: Error) => toast(e.message));
    return;
  }
  const url = withToken(`/api/conversations/${id}/export?${kind === "md" ? "format=md&download=1" : "format=html&print=1"}`);
  if (kind === "pdf") {
    window.open(url, "_blank", "noopener");
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

export function ConversationPage({ id }: { id: string }) {
  const [conv, setConv] = useState<Loaded | null>(null);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  // A long chat opens with its latest part drawn; earlier parts on request (a long chat stays quick).
  const [shownBlocks, setShownBlocks] = useState(150);
  useEffect(() => setShownBlocks(150), [id]);
  const [info, setInfo] = useState<AgentSessionInfo | null>(null);
  const [streaming, setStreaming] = useState<Record<number, string>>({});
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleMenu, setTitleMenu] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const [coachOpen, setCoachOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [web, setWeb] = useWebSearch();
  const [voice, setVoice] = useState(false);
  // Voice (Settings → Parts): the microphone, voice mode and reading aloud.
  const voicePart = useParts().on("voice");
  const [askPhoto, setAskPhoto] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  // Opened from the phone (shared from another app, or a widget button): a draft, voice mode, or the camera.
  useEffect(() => {
    const apply = () => {
      const o = takeOpening(id);
      if (o?.draft) setInput((v) => (v ? `${v}\n${o.draft}` : o.draft!));
      if (o?.voice) setVoice(true);
      if (o?.photo) setAskPhoto(true);
    };
    apply();
    const on = (e: Event) => (e as CustomEvent<string>).detail === id && apply();
    addEventListener("kesher-opening", on);
    return () => removeEventListener("kesher-opening", on);
  }, [id]);
  const addPhotos = async (files: FileList | null) => {
    setAskPhoto(false);
    for (const f of [...(files ?? [])]) {
      try {
        const path = await uploadToConversation(id, f.name || "photo.jpg", f);
        setInput((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}[${t("attached")}: ${path}]\n`);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };
  const voiceOn = useRef(false);
  voiceOn.current = voice;
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
  const branches = conversations.filter((c) => c.branchOf?.id === id);
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
          // "Read answers aloud": only answers that arrive now, not old ones replayed on opening.
          if (e.type === "assistant" && autoSpeak() && !voiceOn.current && Date.parse(e.at) > openedAt) void speak(e.text);
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
  // The chat changed the app's look: show it at once.
  const lastLook = useMemo(() => [...events].reverse().find((e): e is Ev<"tool_result"> => e.type === "tool_result" && e.name === "change_look" && e.ok), [events]);
  useEffect(() => {
    if (lastLook) appearanceChanged();
  }, [lastLook?.seq]);
  const answers = useMemo(() => new Map(events.filter((e): e is Ev<"answer"> => e.type === "answer").map((e) => [e.questionId, e])), [events]);

  if (!conv) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">…</p>}</div>;

  const busy = info?.status === "running" || info?.status === "waiting";
  // Code sessions open with the IDE panel; chats can open it with the button.
  const showIde = ideOpen ?? conv.kind === "code";
  // The server titles a conversation from its first message; the sidebar list has the latest title.
  const title = conversations.find((c) => c.id === id)?.title ?? conv.title;
  const send = async () => {
    // "/goal …": keep going until it is done (checked each time the agent stops); "/goal" alone stops it.
    const goal = /^\/goal(?:\s+([\s\S]*))?$/i.exec(input.trim());
    if (goal) {
      setInput("");
      setError("");
      await api(`/api/conversations/${id}/goal`, { method: "POST", body: { goal: goal[1] ?? "" } }).catch((e: Error) => setError(e.message));
      return;
    }
    const text = expandSlash(input.trim());
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
  const patch = async (body: Partial<{ title: string; modelId: string; mode: PermissionMode; team: Teammate[]; group: string[]; personaId: string | null }>) => {
    await api(`/api/conversations/${id}`, { method: "PATCH", body }).catch((e: Error) => setError(e.message));
    const { personaId, ...rest } = body;
    const next = { ...conv, ...rest };
    if (personaId !== undefined) {
      delete next.personaId;
      if (personaId) next.personaId = personaId;
    }
    setConv(next);
    await refreshLibrary().catch(() => undefined);
  };
  /** Opens a branch at an event; with text, the user's message there is replaced by it. */
  const branchAt = async (seq: number, text?: string) => {
    try {
      const b = await api<{ id: string }>(`/api/conversations/${id}/branch`, { method: "POST", body: { seq, ...(text !== undefined ? { text } : {}) } });
      setEditingSeq(null);
      await refreshLibrary().catch(() => undefined);
      location.hash = `#/c/${b.id}`;
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    await refreshLibrary();
    location.hash = "#/";
  };

  const modelOptions: ModelInfo[] = models.some((m) => m.id === conv.modelId)
    ? models
    : [{ id: conv.modelId, name: conv.modelId, providerId: "", providerModelId: "", category: "chat", location: "local" }, ...models];

  const lastAnswer = [...events].reverse().find((e): e is Ev<"assistant"> => e.type === "assistant");
  return (
    <>
      {askPhoto && (
        <div className="photo-ask card row">
          <span className="grow">{t("photoAsk")}</span>
          <button type="button" className="primary" onClick={() => photoInput.current?.click()}>{t("photoTake")}</button>
          <button type="button" className="as-link" onClick={() => setAskPhoto(false)}>✕</button>
        </div>
      )}
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = ""; }} />
      {voice && (
        <VoiceMode
          busy={busy}
          {...(lastAnswer ? { answer: { seq: lastAnswer.seq, text: lastAnswer.text } } : {})}
          onSend={async (text) => {
            await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text } });
          }}
          onClose={() => setVoice(false)}
        />
      )}
      {slot && createPortal(
        editingTitle ? (
          <form className="bar-rename" onSubmit={(e) => { e.preventDefault(); setEditingTitle(false); void patch({ title: (e.currentTarget.elements.namedItem("title") as HTMLInputElement).value }); }}>
            <input name="title" defaultValue={title} autoFocus aria-label={t("rename")} onBlur={() => setEditingTitle(false)} onKeyDown={(e) => e.key === "Escape" && setEditingTitle(false)} />
          </form>
        ) : (
          <div className="bar-conv">
            <button type="button" className="bar-title" data-slide-menu aria-haspopup="menu" aria-expanded={titleMenu} aria-label={t("convMenu")} onClick={() => setTitleMenu(!titleMenu)}>
              <span className="bar-title-text" dir="auto">{conv.kind === "code" ? "</> " : ""}{title}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {titleMenu && (
              <div className="bar-pop" role="menu">
                <button type="button" role="menuitem" onClick={() => { setTitleMenu(false); setEditingTitle(true); }}>{t("rename")}</button>
                {info?.workspace && desktop()?.openPath && <button type="button" role="menuitem" onClick={() => { setTitleMenu(false); void desktop()!.openPath!(info.workspace!); }}>{t("openFolder")}</button>}
                <button type="button" role="menuitem" onClick={() => { setTitleMenu(false); exportChat(conv.id, "md"); }}>{getLocale() === "he" ? "ייצוא ל-Markdown" : "Export as Markdown"}</button>
                <button type="button" role="menuitem" onClick={() => { setTitleMenu(false); exportChat(conv.id, "pdf"); }}>{getLocale() === "he" ? "ייצוא ל-PDF" : "Export as PDF"}</button>
                <button type="button" role="menuitem" className="danger" onClick={() => { setTitleMenu(false); void remove(); }}>{t("delete")}</button>
              </div>
            )}
          </div>
        ),
        slot,
      )}
      <div className="topbar conv-tools" data-conv-kind={conv.kind}>
        <TeamButton team={conv.team ?? []} models={models} onChange={(team) => void patch({ team })} />
        {conv.kind === "chat" && <GroupButton group={conv.group ?? []} onChange={(group) => void patch({ group })} />}
        {pluginUi.panels.map((x) => {
          const key = `${x.pluginId}/${x.id}`;
          return <button key={key} type="button" className={openPanel === key ? "on" : ""} aria-pressed={openPanel === key} onClick={() => setOpenPanel(openPanel === key ? "" : key)}>{x.title}</button>;
        })}
        <button type="button" className={coachOpen ? "on" : ""} aria-pressed={coachOpen} onClick={() => setCoachOpen(!coachOpen)} title={t("coachHint")}>{t("coach")}</button>
        <button type="button" className={contextOpen ? "on" : ""} aria-pressed={contextOpen} onClick={() => setContextOpen(!contextOpen)} title={t("contextHint")}>{t("contextNav")}</button>
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
      {(conv.branchOf || branches.length > 0) && (
        <div className="branch-bar">
          {conv.branchOf && <span>⑂ {t("branchOf")} <a href={`#/c/${conv.branchOf.id}`} dir="auto">{conv.branchOf.title}</a></span>}
          {branches.length > 0 && (
            <span>
              {t("branches")}: {branches.map((b, i) => <a key={b.id} href={`#/c/${b.id}`} dir="auto">{i ? ", " : ""}{b.title}</a>)}
            </span>
          )}
        </div>
      )}
      {filesOpen && <FilesPanel convId={id} refresh={toolResults} onCount={(n) => setFileCount(n)} />}
      {openPanel && (() => {
        const panel = pluginUi.panels.find((x) => `${x.pluginId}/${x.id}` === openPanel);
        return panel ? <div className="plugin-panel"><PluginFrame pluginId={panel.pluginId} file={panel.file} title={panel.title} conversationId={id} onInsertPrompt={setInput} uses={panel.uses ?? []} /></div> : null;
      })()}
      {contextOpen && <ContextPanel convId={id} refresh={busy ? -1 : events.length} />}
      {coachOpen && <CoachPanel convId={id} refresh={events.length} onUsePrompt={(text) => setInput(text)} />}

      <div className={`conv-split ${showIde ? "with-ide" : ""}`}>
      <div className="chat">
        <div className="messages" aria-live="polite">
          {events.length === 0 && (
            <p className="muted empty">{conv.kind === "code" ? t("emptyCode", { folder: info?.workspace ?? "" }) : t("emptyChat")}</p>
          )}
          {blocks.length > shownBlocks && (
            <button type="button" className="show-earlier" onClick={() => setShownBlocks((n) => n + 150)}>
              {getLocale() === "he" ? `הצג הודעות קודמות (${blocks.length - shownBlocks})` : `Show earlier messages (${blocks.length - shownBlocks})`}
            </button>
          )}
          {blocks.slice(-shownBlocks).map((b, i) => {
            const bi = Math.max(0, blocks.length - shownBlocks) + i;
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
                return editingSeq === e.seq ? (
                  <form key={e.seq} className="msg user editing" onSubmit={(ev) => { ev.preventDefault(); void branchAt(e.seq, editText); }}>
                    <textarea dir="auto" autoFocus rows={Math.min(10, editText.split("\n").length + 1)} value={editText} onChange={(ev) => setEditText(ev.target.value)} />
                    <div className="row">
                      <span className="muted small">{t("editBranchHint")}</span>
                      <span className="grow" />
                      <button type="button" onClick={() => setEditingSeq(null)}>{t("cancel")}</button>
                      <button type="submit" className="primary" disabled={!editText.trim()}>{t("send")}</button>
                    </div>
                  </form>
                ) : (
                  <div key={e.seq} className="msg user" dir="auto">
                    {e.text}
                    {!busy && <span className="msg-tools"><button type="button" className="msg-tool" title={t("editMessage")} aria-label={t("editMessage")} onClick={() => { setEditingSeq(e.seq); setEditText(e.text.replace(/\n*\[[^\]\n]+: [^\]\n]+\]\s*$/g, "")); }}>✎</button></span>}
                  </div>
                );
              case "assistant":
                return (
                  <div key={e.seq} className="msg">
                    <RichText text={e.text} />
                    {voicePart && <SpeakButton text={e.text} />}
                    {!busy && <button type="button" className="say-btn branch-btn" title={t("branchHere")} aria-label={t("branchHere")} onClick={() => void branchAt(e.seq)}>⑂</button>}
                  </div>
                );
              case "approval_request":
                return <ApprovalCard key={e.seq} convId={id} ev={e} pending={!!info?.pendingApprovals.includes(e.requestId)} result={approvalResults.get(e.requestId)} />;
              case "plan":
                return (
                  <div key={e.seq} className="plan-card">
                    <div className="plan-head"><strong>{t("agentPlanTitle")}</strong></div>
                    <RichText text={e.text} />
                    {(info?.mode ?? conv.mode) === "plan" && !busy && (
                      <div className="row">
                        <button
                          type="button"
                          className="primary"
                          onClick={() =>
                            void (async () => {
                              await patch({ mode: "auto-edit" });
                              await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: t("planGo") } }).catch((err: Error) => setError(err.message));
                            })()
                          }
                        >
                          {t("planApprove")}
                        </button>
                        <span className="muted small">{t("planChangeHint")}</span>
                      </div>
                    )}
                  </div>
                );
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
              case "checkpoint":
                return (
                  <div key={e.seq} className="checkpoint-line">
                    <button
                      type="button"
                      className="link-btn small"
                      disabled={busy}
                      title={t("cpHint")}
                      onClick={() => {
                        if (!confirm(t("cpConfirm"))) return;
                        void api(`/api/conversations/${id}/checkpoints/${e.id}/restore`, { method: "POST" }).catch((err: Error) => setError(err.message));
                      }}
                    >
                      ↺ {t("cpRestore")}
                    </button>
                  </div>
                );
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
            <PromptTextarea
              rows={2}
              value={input}
              placeholder={conv.kind === "code" ? t("codePlaceholder") : t("messagePlaceholder")}
              aria-label={t("messagePlaceholder")}
              onValue={setInput}
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
              {voicePart && <Mic onText={(txt) => setInput((v) => (v ? `${v.trimEnd()} ${txt}` : txt))} />}
              {voicePart && (
                <button type="button" className="chip voice-chip" title={t("voiceMode")} aria-label={t("voiceMode")} onClick={() => setVoice(true)}>
                  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6.5v3M5 4v8M8 2v12M11 4.5v7M14 6.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              )}
              {conv.kind === "chat" && <PersonaChip value={conv.personaId} onChange={(p) => void patch({ personaId: p?.id ?? null })} />}
              <ModelMenu models={modelOptions} value={conv.modelId} onChange={(id) => void patch({ modelId: id })} />
              <select className="model-chip" value={info?.mode ?? conv.mode} onChange={(e) => void patch({ mode: e.target.value as PermissionMode })} aria-label={t("mode")}>
                <option value="plan">{t("modePlan")}</option>
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
