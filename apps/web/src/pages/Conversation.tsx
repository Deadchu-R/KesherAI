import { usePersonas } from "../Personas";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { appearanceChanged } from "../appearance";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentEvent, AgentSessionInfo, ConversationSummary, ModelInfo, PermissionMode, Teammate } from "@kesher/shared";
import { api, withToken } from "../api";
import { desktop, refreshLibrary, useLibrary } from "../library";
import { useModels } from "../useModels";
import { RichText } from "../RichText";
import { ContextPanel } from "../ContextPanel";
import { PromptTextarea, expandSlash } from "../SlashMenu";
import { CoachPanel } from "../CoachPanel";
import { useWebSearch } from "../WebToggle";
import { UnityChip } from "../UnityChip";
import { VoiceMode } from "../VoiceMode";
import { useParts } from "../parts";
import { takeOpening } from "../phone";
import { SpeakButton, autoSpeak, speak } from "../Speak";
import { PluginFrame, usePluginUi } from "../plugins";
import { FilesPanel } from "../FilesPanel";
// The editor and terminal are big; load them only when the IDE panel opens.
const Workspace = lazy(() => import("../ide/Workspace").then((m) => ({ default: m.Workspace })));
import { ActivityGroup, type Step } from "../Activity";
import { getLocale, t } from "../i18n";
import { BlueprintChatPanel, blueprintContext, chatBlueprint } from "../BlueprintChatPanel";
import { useChatAttach } from "../ChatAttach";
import { ComposerBar } from "../ComposerBar";
import { ApprovalCard, QuestionCard, ToolCard } from "../ChatCards";
import { GroupButton, TeamButton, exportChat } from "../chat/ChatHeaderTools";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Loaded = ConversationSummary & { session: AgentSessionInfo; events: AgentEvent[]; interruptedAt?: string };
type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

/** One conversation: chat or code, with live events, approvals and questions. */
export function ConversationPage({ id }: { id: string }) {
  const [conv, setConv] = useState<Loaded | null>(null);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  // A long chat opens with its latest part drawn; earlier parts on request (a long chat stays quick).
  const [shownBlocks, setShownBlocks] = useState(150);
  useEffect(() => {
    setShownBlocks(150);
  }, [id]);
  const [info, setInfo] = useState<AgentSessionInfo | null>(null);
  const [streaming, setStreaming] = useState<Record<number, string>>({});
  /** Live output of running tools (builds, commands), by call id. */
  const [liveOut, setLiveOut] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const personas = usePersonas();
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
  const voiceOn = useRef(false);
  voiceOn.current = voice;
  const [openPanel, setOpenPanel] = useState("");
  const pluginUi = usePluginUi();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById("appbar-title"));
  }, []);
  const [filesOpen, setFilesOpen] = useState(false);
  const [ideOpen, setIdeOpen] = useState<boolean | null>(null);
  // An Unreal Blueprint connected to this chat (the 🔷 Blueprint panel).
  const [bpPath, setBpPath] = useState(() => chatBlueprint(id));
  const [bpOpen, setBpOpen] = useState(false);
  const [hasUnreal, setHasUnreal] = useState(false);
  useEffect(() => {
    void api<{ connected: boolean; projects: string[] }>("/api/unreal").then((r) => setHasUnreal(r.connected || r.projects.length > 0), () => setHasUnreal(false));
  }, []);
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
    setLiveOut({});
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
          if (e.type === "tool_output") {
            // Live output of a running build or command: kept only while the page is open (the result has the rest).
            setLiveOut((o) => ({ ...o, [e.callId]: ((o[e.callId] ?? "") + e.text).slice(-8000) }));
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

  // Follow new messages and steps while the user is at the bottom (reading further up stays put). The composer is
  // sticky over the end of the list, so the marker keeps a margin of its height (else it counts as already visible).
  const following = useRef(true);
  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const target: HTMLElement | Window = scroller ?? window;
    const onScroll = () => {
      const s = scroller ?? document.documentElement;
      following.current = s.scrollHeight - s.scrollTop - s.clientHeight < 320;
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [id]);
  useEffect(() => {
    if (following.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, streaming]);

  const byCall = useMemo(() => {
    const m = new Map<string, Ev<"tool_result">>();
    for (const e of events) if (e.type === "tool_result") m.set(e.callId, e);
    return m;
  }, [events]);
  const approvalResults = useMemo(() => new Map(events.filter((e): e is Ev<"approval_result"> => e.type === "approval_result").map((e) => [e.requestId, e])), [events]);
  // The agent's tool calls between two messages are folded into one "activity" line, like Claude's.
  // Answer versions ("another answer"): each user message's answers, split where it was written again; one is shown.
  const [chosenVersion, setChosenVersion] = useState<Record<number, number>>({});
  const versions = useMemo(() => {
    const total = new Map<number, number>();
    let user = 0;
    for (const e of events) {
      if (e.type === "user") {
        user = e.seq;
        total.set(user, 1);
      } else if (e.type === "regenerated" && e.ofUser === user) total.set(user, (total.get(user) ?? 1) + 1);
    }
    const shown: AgentEvent[] = [];
    const lastAnswerOf = new Map<number, number>(); // user seq → seq of the last answer shown for it
    const turnOf = new Map<number, number>(); // answer seq → its user seq
    user = 0;
    let seg = 0;
    for (const e of events) {
      if (e.type === "user") {
        user = e.seq;
        seg = 0;
      } else if (e.type === "regenerated") {
        if (e.ofUser === user) seg++;
        continue;
      }
      const want = user ? (chosenVersion[user] ?? (total.get(user) ?? 1) - 1) : 0;
      if (e.type !== "user" && user && seg !== want) continue;
      shown.push(e);
      if (e.type === "assistant" && user) {
        lastAnswerOf.set(user, e.seq);
        turnOf.set(e.seq, user);
      }
    }
    const lastUser = [...events].reverse().find((e) => e.type === "user")?.seq ?? 0;
    return { shown, total, lastAnswerOf, turnOf, lastUser };
  }, [events, chosenVersion]);
  const blocks = useMemo(() => {
    const out: Array<{ kind: "event"; e: AgentEvent } | { kind: "group"; key: number; steps: Step[] }> = [];
    let group: Step[] | null = null;
    for (const e of versions.shown) {
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
  }, [versions, byCall]);

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

  /** After adding an Unreal project that is not connected yet: offer the right way to connect it. */
  const [unrealSetup, setUnrealSetup] = useState<{ path: string; engine: string; msg?: string } | null>(null);
  // The + menu's attachments: the same hook in every chat box (start screen, chat, code start).
  const attachments = useChatAttach({
    convId: id,
    insert: (txt) => setInput((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${txt}`),
    onError: setError,
    onProject: (r) => {
      if (r.kind === "unreal" && !r.connected) setUnrealSetup({ path: r.path, engine: r.engine ?? "" });
    },
  });
  const resume = (dismiss: boolean) => {
    setConv((c) => (c ? { ...c, interruptedAt: undefined } : c));
    void api(`/api/conversations/${id}/resume`, { method: "POST", body: { dismiss } }).catch((e: Error) => setError(e.message));
  };
  if (!conv) return <div className="page">{error ? <p className="error">{error}</p> : <p className="muted">…</p>}</div>;

  const busy = info?.status === "running" || info?.status === "waiting";
  // Code sessions open with the IDE panel; chats can open it with the button.
  const showIde = ideOpen ?? conv.kind === "code";
  // The server titles a conversation from its first message; the sidebar list has the latest title.
  const title = conversations.find((c) => c.id === id)?.title ?? conv.title;
  // The persona's opening suggestions, for an empty chat (a click puts one in the message box).
  const starters = personas.find((p) => p.id === conv.personaId)?.starters;
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
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: `${text}${blueprintContext(bpPath)}`, ...(web ? { web: true } : {}) } });
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
      setInput(text);
    }
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
          <button type="button" className="primary" onClick={() => { setAskPhoto(false); attachments.takePhoto(); }}>{t("photoTake")}</button>
          <button type="button" className="as-link" onClick={() => setAskPhoto(false)}>✕</button>
        </div>
      )}
      {attachments.elements}
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
          <Menu
            className="bar-conv"
            popClassName="bar-pop"
            triggerClassName="bar-title"
            aria-label={t("convMenu")}
            open={titleMenu}
            onOpenChange={setTitleMenu}
            trigger={<>
              <span className="bar-title-text" dir="auto">{conv.kind === "code" ? "</> " : ""}{title}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </>}
          >
            <MenuItem icon="✎" onSelect={() => setEditingTitle(true)}>{t("rename")}</MenuItem>
            {info?.workspace && desktop()?.openPath && <MenuItem icon="📁" onSelect={() => void desktop()!.openPath!(info.workspace!)}>{t("openFolder")}</MenuItem>}
            <MenuSeparator />
            <MenuItem icon="⬇" onSelect={() => exportChat(conv.id, "md")}>{getLocale() === "he" ? "ייצוא ל-Markdown" : "Export as Markdown"}</MenuItem>
            <MenuItem icon="⬇" onSelect={() => exportChat(conv.id, "pdf")}>{getLocale() === "he" ? "ייצוא ל-PDF" : "Export as PDF"}</MenuItem>
            <MenuSeparator />
            <MenuItem icon="🗑" danger onSelect={() => void remove()}>{t("delete")}</MenuItem>
          </Menu>
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
        {(hasUnreal || bpPath) && (
          <button type="button" className={bpOpen ? "on" : ""} aria-pressed={bpOpen} onClick={() => setBpOpen(!bpOpen)} title={getLocale() === "he" ? "חיבור Blueprint של Unreal לצ'אט: לראות, לשנות ולבדוק" : "Connect an Unreal Blueprint to this chat: see, change and test it"}>
            🔷 Blueprint{bpPath ? ` · ${bpPath.split(".").pop()}` : ""}
          </button>
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
      {bpOpen && (
        <BlueprintChatPanel
          convId={id}
          busy={busy}
          refresh={busy ? 0 : events.length}
          onChange={setBpPath}
          onSend={(text) => void api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: `${text}${blueprintContext(bpPath)}` } }).catch((e: Error) => setError(e.message))}
        />
      )}
      {contextOpen && <ContextPanel convId={id} refresh={busy ? -1 : events.length} />}
      {coachOpen && <CoachPanel convId={id} refresh={events.length} onUsePrompt={(text) => setInput(text)} />}

      <div className={`conv-split ${showIde ? "with-ide" : ""}`}>
      <div className="chat">
        <div className="messages" aria-live="polite">
          {events.length === 0 && (
            <p className="muted empty">{conv.kind === "code" ? t("emptyCode", { folder: info?.workspace ?? "" }) : t("emptyChat")}</p>
          )}
          {events.length === 0 && !!starters?.length && (
            <div className="persona-starters">
              {starters.map((s) => <button key={s} type="button" dir="auto" onClick={() => setInput(s)}>{s}</button>)}
            </div>
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
                  // Live while the agent works and this group has a step still running (an approval card can come
                  // after the group, so "the last block" missed a build that was running after its approval).
                  live={busy && (bi === blocks.length - 1 || b.steps.some((st) => !st.result))}
                  convId={id}
                  renderStep={(s) => <ToolCard call={s.call} {...(s.result ? { result: s.result } : {})} />}
                  liveOutput={liveOut}
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
                    {(() => {
                      const u = versions.turnOf.get(e.seq);
                      if (!u || versions.lastAnswerOf.get(u) !== e.seq) return null;
                      const total = versions.total.get(u) ?? 1;
                      const cur = chosenVersion[u] ?? total - 1;
                      return (
                        <span className="answer-versions">
                          {total > 1 && (
                            <>
                              <button type="button" className="say-btn" disabled={cur === 0} aria-label={t("prevVersion")} onClick={() => setChosenVersion({ ...chosenVersion, [u]: cur - 1 })}>‹</button>
                              <span className="muted small" dir="ltr">{cur + 1}/{total}</span>
                              <button type="button" className="say-btn" disabled={cur === total - 1} aria-label={t("nextVersion")} onClick={() => setChosenVersion({ ...chosenVersion, [u]: cur + 1 })}>›</button>
                            </>
                          )}
                          {!busy && u === versions.lastUser && (
                            <button type="button" className="say-btn" title={t("anotherAnswer")} aria-label={t("anotherAnswer")} onClick={() => {
                              const next = { ...chosenVersion };
                              delete next[u];
                              setChosenVersion(next);
                              void api(`/api/conversations/${id}/regenerate`, { method: "POST" }).catch((err: Error) => setError(err.message));
                            }}>↻</button>
                          )}
                        </span>
                      );
                    })()}
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
                        void api(`/api/conversations/${id}/checkpoints/${encodeURIComponent(e.id)}/restore`, { method: "POST" }).catch((err: Error) => setError(err.message));
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
          {conv.interruptedAt && !busy && (
            <div className="card row resume-card" role="status">
              <span className="grow small">{L("KesherAI נסגר (עדכון או הפעלה מחדש) באמצע העבודה כאן. אפשר להמשיך מאיפה שעצר — הוא יבדוק מה כבר נעשה ולא יחזור על זה.", "KesherAI closed (an update or a restart) while working here. You can continue from where it stopped: it checks what was already done and does not repeat it.")}</span>
              <button type="button" className="primary" onClick={() => resume(false)}>{L("המשך מאיפה שעצר", "Continue where it stopped")}</button>
              <button type="button" onClick={() => resume(true)}>{L("לא צריך", "Dismiss")}</button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <div ref={bottom} style={{ scrollMarginBottom: "240px" }} />
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
            void attachments.attach(paths);
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
            {unrealSetup && (
              <div className="row unreal-setup small">
                <span className="grow">🎮 {unrealSetup.msg ?? (getLocale() === "he" ? `לחבר את פרויקט ה-Unreal (UE ${unrealSetup.engine || "?"}) לצ'אט:` : `Connect the Unreal project (UE ${unrealSetup.engine || "?"}) to the chat:`)}</span>
                {!unrealSetup.msg && (/^5\.(8|9|\d\d)/.test(unrealSetup.engine) || !/^\d/.test(unrealSetup.engine)) && (
                  <button type="button" className="primary" onClick={() => void api<{ message: string }>("/api/unreal/mcp-setup", { method: "POST", body: { project: unrealSetup.path } }).then((r) => setUnrealSetup({ ...unrealSetup, msg: r.message }), (e: Error) => setError(e.message))}>{getLocale() === "he" ? "הפעל MCP של Unreal (5.8+)" : "Turn on Unreal's MCP (5.8+)"}</button>
                )}
                {!unrealSetup.msg && (
                  <button type="button" onClick={() => void api("/api/unreal/install", { method: "POST", body: { project: unrealSetup.path } }).then(() => setUnrealSetup({ ...unrealSetup, msg: getLocale() === "he" ? "מתקין את KesherAI Bridge (בונה פעם אחת לכל גרסת מנוע; ההתקדמות בעמוד Unreal)…" : "Installing KesherAI Bridge (built once per engine version; progress on the Unreal page)…" }), (e: Error) => setError(e.message))}>{getLocale() === "he" ? "התקן KesherAI Bridge" : "Install KesherAI Bridge"}</button>
                )}
                <button type="button" aria-label={getLocale() === "he" ? "סגור" : "Close"} onClick={() => setUnrealSetup(null)}>✕</button>
              </div>
            )}
            <ComposerBar
              attach={attachments.menu}
              onInsert={(txt) => setInput((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${txt}`)}
              web={web}
              onWeb={setWeb}
              {...(voicePart ? { onDictate: (txt: string) => setInput((v) => (v ? `${v.trimEnd()} ${txt}` : txt)) } : {})}
              {...(conv.kind === "chat" ? { persona: { value: conv.personaId, onChange: (p: { id: string } | null) => void patch({ personaId: p?.id ?? null }) } } : {})}
              model={{ models: modelOptions, value: conv.modelId, onChange: (mid) => void patch({ modelId: mid }) }}
              mode={{ value: info?.mode ?? conv.mode, onChange: (m) => void patch({ mode: m }) }}
              extra={
                <>
                  <UnityChip onUse={(txt) => setInput((v) => (v.trim() ? v : txt))} />
                  {voicePart && (
                    <button type="button" className="chip voice-chip" title={t("voiceMode")} aria-label={t("voiceMode")} onClick={() => setVoice(true)}>
                      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6.5v3M5 4v8M8 2v12M11 4.5v7M14 6.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    </button>
                  )}
                </>
              }
              send={
                busy ? (
                  <>
                    {input.trim() && <button type="submit" className="send queue-send" aria-label={t("queueSendHint")} title={t("queueSendHint")}>↑</button>}
                    <button type="button" className="send stop" onClick={() => void api(`/api/conversations/${id}/stop`, { method: "POST" })} aria-label={t("stop")}>■</button>
                  </>
                ) : undefined
              }
              canSend={!!input.trim()}
            />
          </div>
        </form>
      </div>
      {showIde && (
        <Suspense fallback={<aside className="workspace"><p className="muted ws-empty">{t("loading")}</p></aside>}>
          <Workspace convId={id} events={events} refresh={toolResults} onFixInChat={(txt) => setInput((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${txt}`)} />
        </Suspense>
      )}
      </div>
    </>
  );
}

