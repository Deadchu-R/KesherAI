import { AppBar } from "./AppBar";
import { WebToggle, useWebSearch } from "./WebToggle";
import { Mic } from "./Mic";
import { ComputerBanner } from "./ComputerSection";
import { UsagePage } from "./pages/Usage";
import { DayPage } from "./pages/Day";
import { KnowledgePage } from "./pages/Knowledge";
import { PersonasPage } from "./pages/PersonasPage";
import { PersonaChip } from "./Personas";
import { PromptTextarea, expandSlash } from "./SlashMenu";
import { PromptsPage } from "./pages/PromptsPage";
import { WatchPage, usePending } from "./pages/WatchPage";
import { PipelinesPage } from "./pages/PipelinesPage";
import { ComparePage } from "./pages/ComparePage";
import { PluginsPage } from "./pages/Plugins";
import { CommunityPage } from "./pages/Community";
import { PluginPage } from "./pages/PluginPage";
import { PluginStyles } from "./plugins";
import { DownloadsButton } from "./Downloads";
import { ModelPickerHost } from "./ModelPicker";
import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Sidebar } from "./Sidebar";
import { createConversation, refreshLibrary, toast, useToast } from "./library";
import { useModels } from "./useModels";
import { ConversationPage } from "./pages/Conversation";
import { ImagesPage } from "./pages/Images";
import { BatchImagesPage } from "./pages/BatchImages";
import { PairPrompt } from "./PairPrompt";
import { PageBoundary } from "./PageBoundary";
import { MemoryPage } from "./pages/MemoryPage";
import { UpdatesPage } from "./pages/UpdatesPage";
import { ModelsPage } from "./pages/Models";
import { ConnectionsPage } from "./pages/Connections";
import { SettingsPage } from "./pages/Settings";

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
  const [text, setText] = useState("");
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
  const ideas = [t("ideaExe"), t("ideaImage"), t("ideaCode"), t("ideaExplain")];
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

  let page: React.ReactNode;
  if (hash.startsWith("#/c/")) page = <ConversationPage key={hash} id={hash.slice(4)} />;
  else if (hash === "#/images") page = <ImagesPage />;
  else if (hash === "#/batch") page = <BatchImagesPage />;
  else if (hash === "#/memory") page = <MemoryPage />;
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

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <AppBar hash={hash} online={online} sidebarOpen={narrow() ? menuOpen : !sidebarHidden} onSidebar={toggleSidebar} onLocale={() => rerender((n) => n + 1)} />
      <Sidebar hash={hash} online={online} open={menuOpen} onLocale={() => rerender((n) => n + 1)} />
      <PairPrompt />
      <main className="main">
        {online === false && <p className="error" style={{ padding: "12px 28px" }}>{t("serverOffline")}</p>}
        <PageBoundary page={hash}>{page}</PageBoundary>
      </main>
      {message && <div className="toast" role="status">{message}</div>}
      <ComputerBanner />
      <ApprovalsPill hidden={hash === "#/watch" || hash.startsWith("#/c/")} />
      <ModelPickerHost />
      <PluginStyles />
      <DownloadsButton />
    </div>
  );
}
