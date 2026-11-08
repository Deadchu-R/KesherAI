import { GuardBanner } from "./GuardSection";
import { Welcome, useRole } from "./Welcome";
import { PhoneTabs } from "./PhoneTabs";
import { AppBar } from "./AppBar";
import { WebToggle, useWebSearch } from "./WebToggle";
import { Mic } from "./Mic";
import { ComputerBanner } from "./ComputerSection";
import { PersonaChip } from "./Personas";
import { PromptTextarea, expandSlash } from "./SlashMenu";
import { usePending } from "./pages/WatchPage";
import { PluginStyles } from "./plugins";
import { DownloadsButton } from "./Downloads";
import { ModelPickerHost } from "./ModelPicker";
import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, t } from "./i18n";
import { Sidebar } from "./Sidebar";
import { createConversation, refreshLibrary, toast, useToast } from "./library";
import { useModels } from "./useModels";
import { PairPrompt } from "./PairPrompt";
import { PageBoundary } from "./PageBoundary";
import { Reconnecting } from "./Reconnect";
import { PhoneUpdateBanner } from "./pages/UpdatesPage";
import { useParts } from "./parts";

/* Pages load only when opened, so starting KesherAI (and a part that is off) costs nothing. */
const UsagePage = lazy(() => import("./pages/Usage").then((m) => ({ default: m.UsagePage })));
const DayPage = lazy(() => import("./pages/Day").then((m) => ({ default: m.DayPage })));
const KnowledgePage = lazy(() => import("./pages/Knowledge").then((m) => ({ default: m.KnowledgePage })));
const PersonasPage = lazy(() => import("./pages/PersonasPage").then((m) => ({ default: m.PersonasPage })));
const PromptsPage = lazy(() => import("./pages/PromptsPage").then((m) => ({ default: m.PromptsPage })));
const PipelinesPage = lazy(() => import("./pages/PipelinesPage").then((m) => ({ default: m.PipelinesPage })));
const ComparePage = lazy(() => import("./pages/ComparePage").then((m) => ({ default: m.ComparePage })));
const PluginsPage = lazy(() => import("./pages/Plugins").then((m) => ({ default: m.PluginsPage })));
const CommunityPage = lazy(() => import("./pages/Community").then((m) => ({ default: m.CommunityPage })));
const PluginPage = lazy(() => import("./pages/PluginPage").then((m) => ({ default: m.PluginPage })));
const ConversationPage = lazy(() => import("./pages/Conversation").then((m) => ({ default: m.ConversationPage })));
const ImagesPage = lazy(() => import("./pages/Images").then((m) => ({ default: m.ImagesPage })));
const BatchImagesPage = lazy(() => import("./pages/BatchImages").then((m) => ({ default: m.BatchImagesPage })));
const MemoryPage = lazy(() => import("./pages/MemoryPage").then((m) => ({ default: m.MemoryPage })));
const NodesPage = lazy(() => import("./pages/NodesPage").then((m) => ({ default: m.NodesPage })));
const UnrealPage = lazy(() => import("./pages/UnrealPage").then((m) => ({ default: m.UnrealPage })));
const PartsPage = lazy(() => import("./pages/PartsPage").then((m) => ({ default: m.PartsPage })));
const PagesPage = lazy(() => import("./pages/PagesPage").then((m) => ({ default: m.PagesPage })));
const ModelsPage = lazy(() => import("./pages/Models").then((m) => ({ default: m.ModelsPage })));
const ConnectionsPage = lazy(() => import("./pages/Connections").then((m) => ({ default: m.ConnectionsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const AppsPage = lazy(() => import("./pages/AppsPage").then((m) => ({ default: m.AppsPage })));
const WatchPage = lazy(() => import("./pages/WatchPage").then((m) => ({ default: m.WatchPage })));
const UpdatesPage = lazy(() => import("./pages/UpdatesPage").then((m) => ({ default: m.UpdatesPage })));

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/**
 * The start screen, like Claude's: a greeting and one big message box in
 * the middle. Writing there starts a new chat with the chosen model.
 */
function Home() {
  const { models } = useModels("chat");
  // `#/?ask=…` (Settings → Appearance "say it in words", and other pages) fills the box.
  const [text, setText] = useState(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("ask") ?? "");
  const [modelId, setModelId] = useState("");
  const [personaId, setPersonaId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [web, setWeb] = useWebSearch();
  useEffect(() => {
    void api<{ activeModels: Record<string, string> }>("/api/settings").then((s) => setModelId((m) => m || s.activeModels.chat || "")).catch(() => undefined);
  }, []);
  const hour = new Date().getHours();
  const greeting = t(hour < 5 ? "greetNight" : hour < 12 ? "greetMorning" : hour < 18 ? "greetDay" : "greetEvening");
  const start = async () => {
    const value = expandSlash(text.trim());
    if (!value || busy) return;
    setBusy(true);
    try {
      const id = await createConversation({ kind: "chat", ...(modelId ? { modelId } : {}), ...(personaId ? { personaId } : {}) });
      if (!id) return;
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: value, ...(web ? { web: true } : {}) } });
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const role = useRole();
  const ideas = role ? role.ideas[getLocale() === "he" ? "he" : "en"] : [t("ideaExe"), t("ideaImage"), t("ideaCode"), t("ideaExplain")];
  return (
    <div className="home">
      <h1 className="greeting">{greeting}</h1>
      <form className="composer home-composer" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <div className="box">
          <PromptTextarea
            rows={3}
            autoFocus
            value={text}
            placeholder={t("homePlaceholder")}
            aria-label={t("messagePlaceholder")}
            onValue={setText}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void start();
              }
            }}
          />
          <div className="box-bar">
            <WebToggle on={web} onChange={setWeb} />
            <Mic onText={(txt) => setText((v) => (v ? `${v.trimEnd()} ${txt}` : txt))} />
            <PersonaChip value={personaId} onChange={(p) => { setPersonaId(p?.id); if (p?.modelId) setModelId(p.modelId); }} />
            <select className="model-chip" value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label={t("pickModel")}>
              {!modelId && <option value="">{t("pickModel")}</option>}
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <span className="grow" />
            <button type="submit" className="primary send" disabled={!text.trim() || busy} aria-label={t("send")}>↑</button>
          </div>
        </div>
      </form>
      <div className="ideas">
        {ideas.map((i) => <button key={i} type="button" onClick={() => setText(i)}>{i}</button>)}
      </div>
    </div>
  );
}

/** A pill when agents wait for approval somewhere, linking to "Watch and approve". */
function ApprovalsPill({ hidden }: { hidden: boolean }) {
  const pending = usePending();
  if (hidden || !pending.length) return null;
  return <a className="approvals-pill" href="#/watch">✋ {t("approvalsWaiting", { n: pending.length })}</a>;
}

/** Routes by URL hash: `#/c/<id>`, `#/images`, `#/models`, `#/connections`, `#/settings`. */
export function App() {
  const hash = useHash();
  const [, rerender] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);
  const narrow = () => matchMedia("(max-width: 760px)").matches;
  const [menuOpen, setMenuOpen] = useState(false);
  // On a computer the sidebar can be hidden with the top bar's toggle (remembered); on a phone it is a menu.
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem("kesher-sidebar") === "hidden";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    if (narrow()) return setMenuOpen(!menuOpen);
    const next = !sidebarHidden;
    setSidebarHidden(next);
    try {
      localStorage.setItem("kesher-sidebar", next ? "hidden" : "shown");
    } catch {
      // not stored; fine
    }
  };
  const message = useToast();

  // On a phone the sidebar is a full-screen menu; close it when the user navigates.
  useEffect(() => setMenuOpen(false), [hash]);

  useEffect(() => {
    api("/api/health").then(() => setOnline(true), () => setOnline(false));
  }, []);

  const { parts } = useParts();
  let page: React.ReactNode;
  if (hash.startsWith("#/c/")) page = <ConversationPage key={hash} id={hash.slice(4)} />;
  else if (hash === "#/images") page = <ImagesPage />;
  else if (hash === "#/batch") page = <BatchImagesPage />;
  else if (hash === "#/memory") page = <MemoryPage />;
  else if (hash === "#/nodes") page = <NodesPage />;
  else if (hash === "#/unreal") page = <UnrealPage key="unreal" />;
  else if (hash === "#/unity") page = <UnrealPage kind="unity" key="unity" />;
  else if (hash === "#/parts") page = <PartsPage />;
  else if (hash === "#/apps") page = <AppsPage />;
  else if (hash === "#/pages" || hash.startsWith("#/pages/")) page = <PagesPage {...(hash.length > 8 ? { id: hash.slice(8) } : {})} />;
  else if (hash === "#/updates") page = <UpdatesPage />;
  else if (hash === "#/models") page = <ModelsPage />;
  else if (hash === "#/connections") page = <ConnectionsPage />;
  else if (hash.startsWith("#/settings")) page = <SettingsPage />;
  else if (hash === "#/usage") page = <UsagePage />;
  else if (hash === "#/day") page = <DayPage />;
  else if (hash === "#/knowledge") page = <KnowledgePage />;
  else if (hash === "#/personas") page = <PersonasPage />;
  else if (hash === "#/prompts") page = <PromptsPage />;
  else if (hash === "#/watch") page = <WatchPage />;
  else if (hash === "#/pipelines") page = <PipelinesPage />;
  else if (hash === "#/compare") page = <ComparePage />;
  else if (hash === "#/plugins") page = <PluginsPage />;
  else if (hash === "#/community") page = <CommunityPage />;
  else if (hash.startsWith("#/p/")) page = <PluginPage key={hash} route={hash.slice(4)} />;
  else page = <Home />;
  // A page of a part the user turned off (Settings → Parts): say so, with a way to turn it on.
  const offPart = parts.find((p) => !p.on && p.pages.some((x) => hash === x || hash.startsWith(`${x}/`)));
  if (offPart) {
    const he = getLocale() === "he";
    page = (
      <div className="page">
        <h1>{offPart.icon} {he ? offPart.title.he : offPart.title.en}</h1>
        <p className="muted">{he ? "החלק הזה כבוי." : "This part is off."} {he ? offPart.description.he : offPart.description.en}</p>
        <div className="row"><a className="button" href="#/parts">{he ? "חלקי KesherAI" : "Parts of KesherAI"}</a></div>
      </div>
    );
  }

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <AppBar hash={hash} online={online} sidebarOpen={narrow() ? menuOpen : !sidebarHidden} onSidebar={toggleSidebar} onLocale={() => rerender((n) => n + 1)} />
      <Sidebar hash={hash} online={online} open={menuOpen} onLocale={() => rerender((n) => n + 1)} />
      <PairPrompt />
      <Reconnecting />
      <main className="main">
        <PhoneUpdateBanner />
        <GuardBanner />
        {online === false && (
          <p className="error row" style={{ padding: "12px 28px", gap: 10 }}>
            <span className="grow">{t("serverOffline")}</span>
            <button type="button" onClick={() => location.reload()}>{t("reconnectNow")}</button>
          </p>
        )}
        <PageBoundary page={hash}><Suspense fallback={<div className="page-loading" aria-busy="true" />}>{page}</Suspense></PageBoundary>
      </main>
      {message && <div className="toast" role="status">{message}</div>}
      <ComputerBanner />
      <ApprovalsPill hidden={hash === "#/watch" || hash.startsWith("#/c/")} />
      <ModelPickerHost />
      <PluginStyles />
      <DownloadsButton />
      <PhoneTabs hash={hash} onChats={() => setMenuOpen(true)} />
      <Welcome onLocale={() => rerender((n) => n + 1)} />
    </div>
  );
}
