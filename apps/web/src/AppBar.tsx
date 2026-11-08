import { useEffect, useRef, useState } from "react";
import { api, appHome, disconnectComputer, isRemote } from "./api";
import { getLocale, setLocale, t } from "./i18n";
import { ComputerHub } from "./ComputerHub";
import { reconnect } from "./Reconnect";

/**
 * The bar across the top of the window, laid out like Claude's: on the
 * sidebar side a menu, the sidebar toggle, back/forward and a Chat / Code
 * switch; then the page's title (pages put theirs into `#appbar-title`
 * with a portal), and at the end whether this computer is reachable.
 */

const Icon = {
  menu: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>
  ),
  sidebar: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M7 3.5v11" stroke="currentColor" strokeWidth="1.5" /></svg>
  ),
  back: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="dir-icon"><path d="M11 4 6 9l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
  ),
  forward: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="dir-icon"><path d="m7 4 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
  ),
  chat: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 4.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" /></svg>
  ),
  code: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><path d="M6.5 5 3 9l3.5 4M11.5 5 15 9l-3.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
  ),
  computer: (
    <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden="true"><rect x="3.5" y="3" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M1.5 15h17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  ),
};

/** Opens the "new code session" dialog the sidebar owns. */
export const NEW_CODE_EVENT = "kesher:new-code";

/**
 * @param props.hash - Current route.
 * @param props.online - Whether the KesherAI server answers.
 * @param props.sidebarOpen - Whether the sidebar is shown.
 * @param props.onSidebar - Toggles the sidebar.
 * @param props.onLocale - Called after the language changes.
 */
export function AppBar({ hash, online, sidebarOpen, onSidebar, onLocale }: { hash: string; online: boolean | null; sidebarOpen: boolean; onSidebar: () => void; onLocale: () => void }) {
  const [menu, setMenu] = useState(false);
  const [host, setHost] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ name?: string }>("/api/remote/links").then((r) => setHost(r.name ?? ""), () => undefined);
  }, []);
  useEffect(() => setMenu(false), [hash]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", esc);
    };
  }, [menu]);

  const pageTitle = hash === "#/images" ? t("images") : hash === "#/models" ? t("models") : hash === "#/connections" ? t("connections") : hash.startsWith("#/settings") ? t("settings") : hash === "#/usage" ? t("usageNav") : hash === "#/plugins" ? t("pluginsNav") : hash === "#/community" ? t("communityNav") : "";
  const inCode = hash.startsWith("#/c/") && document.querySelector("[data-conv-kind='code']") !== null;
  const status = online === null ? t("barChecking") : online ? t("computerOn", { name: host || location.hostname }) : t("serverOffline");

  return (
    <header className="appbar">
      <div className="appbar-start">
        <div className="appbar-menu" ref={menuRef}>
          <button type="button" data-slide-menu className="bar-btn" aria-label={t("menu")} aria-expanded={menu} aria-haspopup="menu" onClick={() => {
            // One menu at a time: on a phone the sidebar covers the screen.
            if (!menu && sidebarOpen && matchMedia("(max-width: 760px)").matches) onSidebar();
            setMenu(!menu);
          }}>
            {Icon.menu}
          </button>
          {menu && (
            <div className="bar-pop" role="menu">
              <a role="menuitem" href="#/">{t("newChat")}</a>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); dispatchEvent(new Event(NEW_CODE_EVENT)); }}>{t("newCode")}</button>
              <hr />
              {/* The tools themselves live in one place (the sidebar and "All tools"), not repeated here. */}
              <a role="menuitem" href="#/apps">{t("allTools")}</a>
              <a role="menuitem" href="#/settings">{t("settings")}</a>
              <hr />
              <button type="button" role="menuitem" onClick={() => { setLocale(getLocale() === "he" ? "en" : "he"); setMenu(false); onLocale(); }}>{t("language")}</button>
              <a role="menuitem" href="#/updates">{t("checkUpdates")}</a>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); void reconnect({ restart: true }); }}>{t("restartComputerApp")}</button>
              {appHome() && <a role="menuitem" href={`${appHome()!.replace(/\/$/, "")}/?switch=1`}>{t("switchComputer")}</a>}
              {(appHome() || isRemote()) && <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); if (confirm(t("disconnectSure"))) disconnectComputer(); }}>{t("disconnectComputer")}</button>}
            </div>
          )}
        </div>
        <button type="button" data-slide-menu className="bar-btn" aria-label={t("toggleSidebar")} aria-pressed={sidebarOpen} title={t("toggleSidebar")} onClick={() => { setMenu(false); onSidebar(); }}>
          {Icon.sidebar}
        </button>
        <button type="button" className="bar-btn hist" aria-label={t("back")} title={t("back")} onClick={() => history.back()}>{Icon.back}</button>
        <button type="button" className="bar-btn hist" aria-label={t("forward")} title={t("forward")} onClick={() => history.forward()}>{Icon.forward}</button>
        <div className="bar-seg" role="group" aria-label={t("chatOrCode")}>
          <a href="#/" className={!inCode ? "on" : ""} aria-label={t("newChat")} title={t("newChat")}>{Icon.chat}</a>
          <button type="button" className={inCode ? "on" : ""} aria-label={t("newCode")} title={t("newCode")} onClick={() => dispatchEvent(new Event(NEW_CODE_EVENT))}>{Icon.code}</button>
        </div>
      </div>
      <div className="appbar-main">
        <div className="appbar-title">
          {pageTitle && <span className="bar-page">{pageTitle}</span>}
          {/* Pages render their own title here with a portal; React leaves this element's children to them. */}
          <div id="appbar-title" className="appbar-slot" />
        </div>
        <ComputerHub online={online} status={status} icon={Icon.computer} />
      </div>
    </header>
  );
}
