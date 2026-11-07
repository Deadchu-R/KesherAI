import { ModelPickerHost } from "./ModelPicker";
import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";
import { Sidebar } from "./Sidebar";
import { createConversation, toast, useLibrary, useToast } from "./library";
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

/** The start screen: open the latest conversation, or offer to start one. */
function Home() {
  const { conversations } = useLibrary();
  useEffect(() => {
    if (conversations[0]) location.replace(`#/c/${conversations[0].id}`);
  }, [conversations]);
  return (
    <div className="page home">
      <p className="muted">{t("noConversations")}</p>
      <div className="row">
        <button type="button" className="primary" onClick={() => void createConversation({ kind: "chat" }).catch((e: Error) => toast(e.message))}>
          {t("newChat")}
        </button>
        <a className="btn" href="#/models">{t("models")}</a>
      </div>
    </div>
  );
}

/** Routes by URL hash: `#/c/<id>`, `#/images`, `#/models`, `#/connections`, `#/settings`. */
export function App() {
  const hash = useHash();
  const [, rerender] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
  else page = <Home />;

  return (
    <div className="app">
      <header className="mobile-bar">
        <button type="button" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? "✕" : "☰"}
        </button>
        <strong>KesherAI</strong>
      </header>
      <Sidebar hash={hash} online={online} open={menuOpen} onLocale={() => rerender((n) => n + 1)} />
      <main className="main">
        {online === false && <p className="error" style={{ padding: "12px 28px" }}>{t("serverOffline")}</p>}
        {page}
      </main>
      {message && <div className="toast" role="status">{message}</div>}
      <ModelPickerHost />
    </div>
  );
}
