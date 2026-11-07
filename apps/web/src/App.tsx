import { useEffect, useState } from "react";
import { branding } from "@kesher/shared";
import { api } from "./api";
import { getLocale, setLocale, t, type StringKey } from "./i18n";
import { ChatPage } from "./pages/Chat";
import { ImagesPage } from "./pages/Images";
import { ModelsPage } from "./pages/Models";
import { ConnectionsPage } from "./pages/Connections";

/** Screens, keyed by the URL hash. Add a screen here and in the sidebar. */
const ROUTES: Array<{ hash: string; label: StringKey; render: () => React.ReactNode }> = [
  { hash: "#/chat", label: "chat", render: () => <ChatPage /> },
  { hash: "#/images", label: "images", render: () => <ImagesPage /> },
  { hash: "#/models", label: "models", render: () => <ModelsPage /> },
  { hash: "#/connections", label: "connections", render: () => <ConnectionsPage /> },
];

function useHash(): string {
  const [hash, setHash] = useState(location.hash || "#/chat");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/chat");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const [, rerender] = useState(0);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    api("/api/health").then(() => setOnline(true), () => setOnline(false));
  }, []);

  const route = ROUTES.find((r) => r.hash === hash) ?? ROUTES[0]!;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true">
            <circle cx="8" cy="13" r="5" fill="none" stroke="var(--accent)" strokeWidth="2" />
            <circle cx="18" cy="13" r="5" fill="none" stroke="var(--accent)" strokeWidth="2" />
          </svg>
          {branding.productName}
        </div>
        {ROUTES.map((r) => (
          <a key={r.hash} href={r.hash} className="nav-link" aria-current={r === route ? "page" : undefined}>
            {t(r.label)}
          </a>
        ))}
        <div className="sidebar-foot">
          <span>
            <span style={{ color: online ? "var(--good)" : "var(--bad)" }}>●</span> {location.host}
          </span>
          <button
            type="button"
            onClick={() => {
              setLocale(getLocale() === "he" ? "en" : "he");
              rerender((n) => n + 1);
            }}
          >
            {t("language")}
          </button>
        </div>
      </nav>
      <main className="main">
        {online === false && <p className="error" style={{ padding: "12px 28px" }}>{t("serverOffline")}</p>}
        {route.render()}
      </main>
    </div>
  );
}
