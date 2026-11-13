import { usePersonas } from "../Personas";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { appearanceChanged } from "../appearance";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentEvent, AgentSessionInfo, ConversationSummary, ModelInfo, PermissionMode, Teammate } from "@kesher/shared";
import { api, withToken } from "../api";
import { desktop, refreshLibrary, useActivity, useLibrary } from "../library";
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
import { BrowserPanel } from "../BrowserPanel";
import { SessionEnvBar } from "../CodeEnvironment";
import { StepsPanel, currentSteps } from "../StepsPanel";
// The editor and terminal are big; load them only when the IDE panel opens.
const Workspace = lazy(() => import("../ide/Workspace").then((m) => ({ default: m.Workspace })));
import { ActivityGroup, groupSummary, type Step } from "../Activity";
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

  // A live stream that went quiet (a phone's network, the tunnel) is opened again with the chat as it is now:
  // found on the phone, the page kept "Working…" and the stop button after the run had stopped.
  const [resync, setResync] = useState(0);
  // "Try again": a run that has said nothing for two minutes (no text, no tool output) is shown as stuck.
  const lastWork = useRef(Date.now());
  const [stalled, setStalled] = useState(false);
  const runStatus = info?.status;
  useEffect(() => {
    lastWork.current = Date.now();
    setStalled(false);
    if (runStatus !== "running") return;
    const tm = setInterval(() => setStalled(Date.now() - lastWork.current > 120_000), 5000);
    return () => clearInterval(tm);
  }, [runStatus, id]);
  const retry = () => {
    setStalled(false);
    setError("");
    lastWork.current = Date.now();
    void api(`/api/conversations/${id}/retry`, { method: "POST" })
      .then(() => setTimeout(() => setResync((n) => n + 1), 1500))
      .catch((err: Error) => setError(err.message));
  };
  const shownId = useRef("");
  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;
    let heard = Date.now();
    const watchdog = setInterval(() => {
      if (!cancelled && !document.hidden && Date.now() - heard > 25_000) setResync((n) => n + 1);
    }, 5000);
    if (shownId.current !== id) {
      shownId.current = id;
      setConv(null);
      setEvents([]);
    }
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
          heard = Date.now();
          const e = JSON.parse(m.data as string) as AgentEvent | ({ type: "info" } & AgentSessionInfo) | { type: "ping" };
          if (e.type === "ping") return;
          lastWork.current = Date.now();
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
          if (e.type === "tool_call" && e.name.startsWith("browser_") && Date.parse(e.at) > openedAt) setBrowserOpen(true);
          if (e.type === "status" && e.status === "error") setError(e.message ?? "Error");
          setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
        };
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      clearInterval(watchdog);
      es?.close();
    };
  }, [id, resync]);
  // The activity list (polled every few seconds) says the run ended but this page still shows it working: catch up.
  const activity = useActivity();
  const shownBusy = info?.status === "running" || info?.status === "waiting";
  const serverBusy = !!activity[id];
  useEffect(() => {
    if (!shownBusy || serverBusy) return;
    const tm = setTimeout(() => setResync((n) => n + 1), 4000);
    return () => clearTimeout(tm);
  }, [shownBusy, serverBusy]);

  // Follow new messages and steps while the user is at the bottom (reading further up stays put). The composer is
  // sticky over the end of the list, so the marker keeps a margin of its height (else it counts as already visible).
  const following = useRef(true);
  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const target: HTMLElement | Window = scroller ?? window;
    const s = () => scroller ?? document.documentElement;
    const gap = () => s().scrollHeight - s().scrollTop - s().clientHeight;
    // Reading up while an answer is written (found on Linux: each new word pulled the view back down). A scroll
    // the user makes (wheel, finger, keys, scrollbar) stops following at once; coming back near the end resumes it.
    // The page's own scroll to the end is not the user's, so it does not count.
    let userAt = 0;
    const mark = () => {
      userAt = Date.now();
    };
    const onScroll = () => {
      if (gap() < 80) following.current = true;
      else if (Date.now() - userAt < 600) following.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      mark();
      if (e.deltaY < 0) following.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (/^(ArrowUp|PageUp|Home)$/.test(e.key)) {
        mark();
        following.current = false;
      }
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    target.addEventListener("wheel", onWheel as EventListener, { passive: true });
    target.addEventListener("touchmove", mark, { passive: true });
    target.addEventListener("pointerdown", mark, { passive: true });
    addEventListener("keydown", onKey);
    return () => {
      target.removeEventListener("scroll", onScroll);
      target.removeEventListener("wheel", onWheel as EventListener);
      target.removeEventListener("touchmove", mark);
      target.removeEventListener("pointerdown", mark);
      removeEventListener("keydown", onKey);
    };
  }, [id]);
  useEffect(() => {
    if (following.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, streaming]);

  // How long each answer took and how fast it was written (tokens per second, from the model's own counts): shown
  // small under the answer, as LM Studio and Open WebUI do.
  const answerStats = useMemo(() => {
    const out = new Map<number, { seconds: number; tps?: number; tokens: number }>();
    let from = 0;
    let tokens = 0;
    for (const e of events) {
      if (e.type === "user") {
        from = Date.parse(e.at);
        tokens = 0;
      } else if (e.type === "usage") tokens += e.output;
      else if (e.type === "assistant" && from) {
        const seconds = Math.max(0, (Date.parse(e.at) - from) / 1000);
        out.set(e.seq, { seconds, tokens, ...(tokens && seconds > 0.2 ? { tps: tokens / seconds } : {}) });
        from = Date.parse(e.at);
        tokens = 0;
      }
    }
    return out;
  }, [events]);

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
        if (e.name === "set_steps") continue; // the Steps pane shows the list
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

  // The task's steps (the model's set_steps list). The pane opens by itself the first time a list appears in
  // this conversation, on a screen wide enough; closing it is remembered for the conversation.
  const taskSteps = useMemo(() => currentSteps(events), [events]);
  const stepsFallback = useMemo(() => {
    const groups = blocks.filter((b): b is { kind: "group"; key: number; steps: Step[] } => b.kind === "group");
    const after = groups.filter((g) => g.key > versions.lastUser);
    return after.map((g) => groupSummary(g.steps)).filter(Boolean).slice(-8);
  }, [blocks, versions.lastUser]);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const stepsAuto = useRef("");
  useEffect(() => {
    if (taskSteps.steps.length && taskSteps.current && stepsAuto.current !== id && innerWidth > 760) {
      stepsAuto.current = id;
      setStepsOpen(true);
    }
  }, [taskSteps, id]);
  useEffect(() => {
    setStepsOpen(false);
  }, [id]);

  // The pane column: any of Steps, Files, Context, Coach. Its width is remembered on this device.
  const anyPane = stepsOpen || filesOpen || contextOpen || coachOpen || browserOpen;
  const closePanes = () => {
    setBrowserOpen(false);
    setStepsOpen(false);
    setFilesOpen(false);
    setContextOpen(false);
    setCoachOpen(false);
  };
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      return Math.min(720, Math.max(260, Number(localStorage.getItem("kesher.paneWidth")) || 360));
    } catch {
      return 360;
    }
  });
  const startPaneResize = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const start = e.clientX;
    const from = paneWidth;
    // The column sits at the end of the row: in a right-to-left page that is the left side.
    const sign = getComputedStyle(document.documentElement).direction === "rtl" ? 1 : -1;
    let last = from;
    const move = (ev: PointerEvent) => {
      last = Math.min(720, Math.max(260, from + (ev.clientX - start) * sign));
      setPaneWidth(last);
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      try {
        localStorage.setItem("kesher.paneWidth", String(Math.round(last)));
      } catch {
        // only for this visit
      }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
  };
  useEffect(() => {
    if (!anyPane) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        closePanes();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [anyPane]);

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
  // Code sessions open with the IDE panel on a wide screen; on a phone the chat comes first (the IDE button opens it).
  const showIde = ideOpen ?? (conv.kind === "code" && !(typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches));
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
        {/* Steps: an icon (a checklist) with the count beside it, like the pane buttons in Claude's title bar. */}
        <button type="button" className={`pane-btn${stepsOpen ? " on" : ""}`} aria-pressed={stepsOpen} onClick={() => setStepsOpen(!stepsOpen)} aria-label={getLocale() === "he" ? "שלבים" : "Steps"} title={getLocale() === "he" ? "שלבים: שלבי המשימה שהמודל עובד עליה" : "Steps: the steps of the task the model is working on"}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M2.6 4.6l1.3 1.3 2.3-2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <path d="M2.6 10.1l1.3 1.3 2.3-2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="4.3" cy="15" r="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
            <path d="M9 4.6h6.4M9 10h6.4M9 15h6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {taskSteps.steps.length > 0 && taskSteps.current && <span className="pane-btn-count">{taskSteps.steps.filter((x) => x.status === "done").length}/{taskSteps.steps.length}</span>}
        </button>
        {/* Browser: KesherAI's own browser, which the model uses while you watch (opens by itself when it does). */}
        <button type="button" className={`pane-btn${browserOpen ? " on" : ""}`} aria-pressed={browserOpen} onClick={() => setBrowserOpen(!browserOpen)} aria-label={getLocale() === "he" ? "דפדפן" : "Browser"} title={getLocale() === "he" ? "דפדפן: הדפדפן של KesherAI, שבו המודל פותח דפים ואתם רואים" : "Browser: KesherAI's own browser, where the model opens pages while you watch"}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="1.8" y="2.8" width="14.4" height="12.4" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
            <path d="M1.8 6.4h14.4" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="4.2" cy="4.6" r="0.7" fill="currentColor" />
            <circle cx="6.3" cy="4.6" r="0.7" fill="currentColor" />
          </svg>
        </button>
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

      <div className={`conv-split ${showIde ? "with-ide" : ""}`}>
      <div className="chat">
        {/* For screen readers: the history is a log that is not read aloud while it streams (a live region on it
            re-read the answer on every word); one short line says what is happening instead. */}
        <ChatStatus status={info?.status} waiting={(info?.pendingApprovals.length ?? 0) > 0} />
        <div className="messages" role="log" aria-live="off" aria-busy={info?.status === "running"} aria-label={getLocale() === "he" ? "היסטוריית השיחה" : "Chat history"} tabIndex={0}>
          {conv.kind === "code" && <SessionEnvBar convId={id} />}
          {conv.incognito && <p className="muted small incognito-note">👻 {getLocale() === "he" ? "צ'אט בלי זיכרון: לא קורא ולא שומר זיכרון, ולא מופיע בחיפוש." : "Incognito: no memory read or filed, left out of search."}</p>}
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
                          {(() => {
                            const st2 = answerStats.get(e.seq);
                            if (!st2 || !st2.seconds) return null;
                            const secs = st2.seconds < 60 ? `${st2.seconds.toFixed(1)}s` : `${Math.floor(st2.seconds / 60)}m ${Math.round(st2.seconds % 60)}s`;
                            return (
                              <span className="answer-stats muted small" dir="ltr" title={getLocale() === "he" ? `${st2.tokens} טוקנים נכתבו ב-${secs}, כולל קריאת השאלה והכלים` : `${st2.tokens} tokens written in ${secs}, including reading the question and tools`}>
                                {st2.tps ? `${st2.tps.toFixed(1)} tok/s · ` : ""}{secs}
                              </span>
                            );
                          })()}
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
                if (e.status !== "error") return null;
                return (
                  <p key={e.seq} className="error row">
                    <span className="grow">{e.message}</span>
                    {!busy && e.seq === events.at(-1)?.seq && <button type="button" className="retry-btn" onClick={retry}>{L("↻ נסה שוב", "↻ Try again")}</button>}
                  </p>
                );
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
          {busy && stalled && (
            <div className="card row resume-card" role="status">
              <span className="grow small">{L("נראה שהצ'אט נתקע — לא הגיע ממנו כלום כבר שתי דקות.", "This chat looks stuck: nothing has come from it for two minutes.")}</span>
              <button type="button" className="primary" onClick={retry}>{L("נסה שוב", "Try again")}</button>
              <button type="button" onClick={() => { lastWork.current = Date.now(); setStalled(false); }}>{L("לחכות עוד", "Keep waiting")}</button>
            </div>
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
                    <button type="button" className="send stop" onClick={() => void api(`/api/conversations/${id}/stop`, { method: "POST" }).then(() => setTimeout(() => setResync((n) => n + 1), 1500))} aria-label={t("stop")}>■</button>
                  </>
                ) : undefined
              }
              canSend={!!input.trim()}
            />
          </div>
        </form>
      </div>
      {/* The panes (Steps, Files, Context, Coach) open beside the chat, like the panes in Claude's sessions: one
          column whose width can be dragged; on a phone, a sheet over the lower part of the chat. Ctrl+\ closes it. */}
      {anyPane && (
        <aside className="conv-panes" style={{ width: paneWidth }} aria-label={getLocale() === "he" ? "חלוניות" : "Panes"}>
          <div className="conv-panes-grip" role="separator" aria-orientation="vertical" aria-label={getLocale() === "he" ? "שינוי רוחב החלוניות" : "Resize the panes"} onPointerDown={startPaneResize} />
          <div className="conv-panes-head">
            <span className="muted small grow">{getLocale() === "he" ? "חלוניות" : "Panes"}</span>
            <button type="button" className="icon-btn" title={getLocale() === "he" ? "סגור את כל החלוניות (Ctrl+\\)" : "Close all panes (Ctrl+\\)"} aria-label={getLocale() === "he" ? "סגור את כל החלוניות" : "Close all panes"} onClick={closePanes}>✕</button>
          </div>
          <div className="conv-panes-body">
            {browserOpen && <BrowserPanel />}
            {stepsOpen && <StepsPanel steps={taskSteps.steps} busy={busy} fallback={stepsFallback} onClose={() => setStepsOpen(false)} />}
            {filesOpen && <FilesPanel convId={id} refresh={toolResults} onCount={(n) => setFileCount(n)} />}
            {contextOpen && <ContextPanel convId={id} refresh={busy ? -1 : events.length} />}
            {coachOpen && <CoachPanel convId={id} refresh={events.length} onUsePrompt={(text) => setInput(text)} />}
          </div>
        </aside>
      )}
      {showIde && (
        <Suspense fallback={<aside className="workspace"><p className="muted ws-empty">{t("loading")}</p></aside>}>
          <Workspace convId={id} events={events} refresh={toolResults} onFixInChat={(txt) => setInput((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${txt}`)} />
        </Suspense>
      )}
      </div>
    </>
  );
}

/**
 * Tells a screen reader what the chat is doing, in one polite line that changes only when the state does:
 * writing an answer, waiting for the user's approval, or done. Empty at first, so the region exists before
 * its first message (docs/DESIGN_RESEARCH.md, accessibility).
 *
 * @param p.status - The conversation's status.
 * @param p.waiting - Whether an approval waits for the user.
 */
function ChatStatus({ status, waiting }: { status: string | undefined; waiting: boolean }) {
  const he = getLocale() === "he";
  const now = waiting || status === "waiting" ? "waiting" : status === "running" ? "running" : "idle";
  const [said, setSaid] = useState("");
  const before = useRef("idle");
  useEffect(() => {
    if (before.current === now) return;
    const was = before.current;
    before.current = now;
    setSaid(now === "running" ? (he ? "כותב תשובה" : "Writing an answer") : now === "waiting" ? (he ? "מחכה לאישור שלך" : "Waiting for your approval") : was === "running" || was === "waiting" ? (he ? "התשובה מוכנה" : "The answer is ready") : "");
  }, [now, he]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said}</div>;
}
