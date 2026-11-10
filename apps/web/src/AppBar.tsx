import { useEffect, useState } from "react";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { desktop } from "./library";
import { api, appHome, disconnectComputer, isRemote } from "./api";
import { getLocale, setLocale, t } from "./i18n";
import { ComputerHub } from "./ComputerHub";
import { reconnect } from "./Reconnect";
import { InboxBell } from "./pages/InboxPage";

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

  useEffect(() => {
    api<{ name?: string }>("/api/remote/links").then((r) => setHost(r.name ?? ""), () => undefined);
  }, []);
  useEffect(() => {
    setMenu(false);
  }, [hash]);

  const pageTitle = hash === "#/images" ? t("images") : hash === "#/models" ? t("models") : hash === "#/connections" ? t("connections") : hash.startsWith("#/settings") ? t("settings") : hash === "#/usage" ? t("usageNav") : hash === "#/plugins" ? t("pluginsNav") : hash === "#/community" ? t("communityNav") : "";
  const inCode = hash === "#/code" || (hash.startsWith("#/c/") && document.querySelector("[data-conv-kind='code']") !== null);
  const status = online === null ? t("barChecking") : online ? t("computerOn", { name: host || location.hostname }) : t("serverOffline");

  return (
    <header className="appbar">
      <div className="appbar-start">
        <Menu
          className="appbar-menu"
          popClassName="bar-pop"
          triggerClassName="bar-btn"
          aria-label={t("menu")}
          open={menu}
          onOpenChange={(o) => {
            // One menu at a time: on a phone the sidebar covers the screen.
            if (o && sidebarOpen && matchMedia("(max-width: 760px)").matches) onSidebar();
            setMenu(o);
          }}
          trigger={Icon.menu}
        >
          <MenuItem icon="+" href="#/">{t("newChat")}</MenuItem>
          <MenuItem icon="</>" onSelect={() => dispatchEvent(new Event(NEW_CODE_EVENT))}>{t("newCode")}</MenuItem>
          <MenuSeparator />
          {/* The tools themselves live in one place (the sidebar and "All tools"), not repeated here. */}
          <MenuItem icon="▦" href="#/apps">{t("allTools")}</MenuItem>
          <MenuItem icon="⚙" href="#/settings">{t("settings")}</MenuItem>
          <MenuSeparator />
          <MenuItem icon="🌐" onSelect={() => { setLocale(getLocale() === "he" ? "en" : "he"); onLocale(); }}>{t("language")}</MenuItem>
          <MenuItem icon="⟳" href="#/updates">{t("checkUpdates")}</MenuItem>
          <MenuItem icon="↻" onSelect={() => void reconnect({ restart: true })}>{t("restartComputerApp")}</MenuItem>
          {appHome() && <MenuItem icon="⇄" href={`${appHome()!.replace(/\/$/, "")}/?switch=1`}>{t("switchComputer")}</MenuItem>}
          {desktop()?.connectComputer && !isRemote() && <MenuItem icon="🔗" href="#/settings/phone">{getLocale() === "he" ? "התחבר למחשב אחר" : "Connect to another computer"}</MenuItem>}
          {(appHome() || isRemote()) && <MenuItem icon="⏏" danger onSelect={() => { if (confirm(t("disconnectSure"))) disconnectComputer(); }}>{t("disconnectComputer")}</MenuItem>}
        </Menu>
        <button type="button" data-slide-menu className="bar-btn" aria-label={t("toggleSidebar")} aria-pressed={sidebarOpen} title={t("toggleSidebar")} onClick={() => { setMenu(false); onSidebar(); }}>
          {Icon.sidebar}
        </button>
        <button type="button" className="bar-btn hist" aria-label={t("back")} title={t("back")} onClick={() => history.back()}>{Icon.back}</button>
        <button type="button" className="bar-btn hist" aria-label={t("forward")} title={t("forward")} onClick={() => history.forward()}>{Icon.forward}</button>
        <div className="bar-seg" role="group" aria-label={t("chatOrCode")}>
          <a href="#/" className={!inCode ? "on" : ""} aria-label={t("newChat")} title={t("newChat")}>{Icon.chat}</a>
          {/* Code, like the Claude app's Code side: its own start screen, the folder chosen in the message box (no dialog). */}
          <a href="#/code" className={inCode ? "on" : ""} aria-label={t("newCode")} title={t("newCode")}>{Icon.code}</a>
        </div>
      </div>
      <div className="appbar-main">
        <div className="appbar-title">
          {pageTitle && <span className="bar-page">{pageTitle}</span>}
          {/* Pages render their own title here with a portal; React leaves this element's children to them. */}
          <div id="appbar-title" className="appbar-slot" />
        </div>
        <InboxBell />
        <ComputerHub online={online} status={status} icon={Icon.computer} />
      </div>
    </header>
  );
}
