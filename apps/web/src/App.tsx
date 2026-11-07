import { AppBar } from "./AppBar";
import { UsagePage } from "./pages/Usage";
import { PluginsPage } from "./pages/Plugins";
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
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ activeModels: Record<string, string> }>("/api/settings").then((s) => setModelId((m) => m || s.activeModels.chat || "")).catch(() => undefined);
  }, []);
  const hour = new Date().getHours();
  const greeting = t(hour < 5 ? "greetNight" : hour < 12 ? "greetMorning" : hour < 18 ? "greetDay" : "greetEvening");
  const start = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const id = await createConversation({ kind: "chat", ...(modelId ? { modelId } : {}) });
      if (!id) return;
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: value } });
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
          <textarea
            rows={3}
            autoFocus
            value={text}
            placeholder={t("homePlaceholder")}
            aria-label={t("messagePlaceholder")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void start();
              }
            }}
          />
          <div className="box-bar">
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
  else if (hash === "#/models") page = <ModelsPage />;
  else if (hash === "#/connections") page = <ConnectionsPage />;
  else if (hash.startsWith("#/settings")) page = <SettingsPage />;
  else if (hash === "#/usage") page = <UsagePage />;
  else if (hash === "#/plugins") page = <PluginsPage />;
  else if (hash.startsWith("#/p/")) page = <PluginPage key={hash} route={hash.slice(4)} />;
  else page = <Home />;

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <AppBar hash={hash} online={online} sidebarOpen={narrow() ? menuOpen : !sidebarHidden} onSidebar={toggleSidebar} onLocale={() => rerender((n) => n + 1)} />
      <Sidebar hash={hash} online={online} open={menuOpen} onLocale={() => rerender((n) => n + 1)} />
      <main className="main">
        {online === false && <p className="error" style={{ padding: "12px 28px" }}>{t("serverOffline")}</p>}
        {page}
      </main>
      {message && <div className="toast" role="status">{message}</div>}
      <ModelPickerHost />
      <PluginStyles />
      <DownloadsButton />
    </div>
  );
}
