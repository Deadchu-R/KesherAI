import { canChooseView, computerView, setViewChoice, viewChoice } from "./desktop-view";
import { createPortal } from "react-dom";
import { openPalette } from "./CommandPalette";
import { useParts } from "./parts";
import { useEffect, useRef, useState } from "react";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { useAppMenu } from "./AppMenu";
import { desktop } from "./library";
import { api, appHome, disconnectComputer, isRemote } from "./api";
import { getLocale, setLocale, t } from "./i18n";
import { ComputerHub } from "./ComputerHub";
import { ComputerTabs } from "./ComputerTabs";
import { reconnect } from "./Reconnect";
import { InboxBell } from "./pages/InboxPage";
import { DesignAssistant } from "./DesignAssistant";
import { UpdateButton } from "./UpdateButton";
import { SidebarEdit } from "./SidebarEdit";
import { PhoneSettings } from "./PhoneSettings";
import { ComputersDialog } from "./ComputersMenu";

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
  home: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 8.5 9 3l6.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /><path d="M4.5 7.5V15h3.5v-4h2v4h3.5V7.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" /></svg>
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
  // The menu's ✏ (the phone has no sidebar on screen, so the edit list opens as a dialog).
  const [editMenu, setEditMenu] = useState(false);
  // The Computers menu (one list for every chat: switch, disconnect).
  const [computers, setComputers] = useState(false);
  const app = useAppMenu();
  const { simple } = useParts();
  const [host, setHost] = useState("");

  // The phone app's ☁ Cloud tab opens this PC's hub (its address goes along, so the app remembers it for when the PC is off).
  const [hubUrl, setHubUrl] = useState("");
  useEffect(() => {
    api<{ name?: string }>("/api/remote/links").then((r) => setHost(r.name ?? ""), () => undefined);
    if (appHome()) api<{ url?: string }>("/api/hub").then((r) => setHubUrl(r.url ?? ""), () => undefined);
  }, []);
  useEffect(() => {
    setMenu(false);
  }, [hash]);

  const pageTitle = hash === "#/images" ? t("images") : hash === "#/models" ? t("models") : hash === "#/downloads" ? t("downloads") : hash === "#/connections" || hash === "#/parts" ? t("customizeNav") : hash.startsWith("#/settings") ? t("settings") : hash === "#/usage" ? t("usageNav") : hash === "#/scheduled" ? t("scheduledNav") : hash === "#/plugins" ? t("customizeNav") : hash === "#/community" ? t("communityNav") : "";
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
          {/* The same entries as the sidebar (useAppMenu): main actions, pinned tools, shortcuts. */}
          {[app.main, app.pinned, app.shortcuts].filter((part) => part.length).map((part, i) => (
            <div key={i} className="kmenu-part">
              {i > 0 && <MenuSeparator />}
              {part.map((e) => (
                <MenuItem key={e.key} icon={e.icon} {...(e.run ? { onSelect: e.run } : { href: e.href! })}>{e.label}{e.external ? " ↗" : ""}</MenuItem>
              ))}
            </div>
          ))}
          <MenuSeparator />
          <MenuItem icon="✏" onSelect={() => setEditMenu(true)}>{getLocale() === "he" ? "עריכת התפריט" : "Edit the menu"}</MenuItem>
          <MenuItem icon="⚙" href="#/settings">{appHome() || isRemote() ? (getLocale() === "he" ? "הגדרות המחשב" : "PC settings") : t("settings")}</MenuItem>
          {(appHome() || isRemote()) && <MenuItem icon="❤" href="#/health">{getLocale() === "he" ? "בריאות" : "Health"}</MenuItem>}
          <MenuSeparator />
          <MenuItem icon="🌐" onSelect={() => { setLocale(getLocale() === "he" ? "en" : "he"); onLocale(); }}>{t("language")}</MenuItem>
          {/* A phone: the computer's layout (on by itself while a mouse is connected), or back to the phone's. */}
          {canChooseView() && <MenuItem icon={computerView() ? "📱" : "🖥"} onSelect={() => setViewChoice(computerView() ? "phone" : "computer")}>{computerView() ? (getLocale() === "he" ? "תצוגת טלפון" : "Phone view") : getLocale() === "he" ? "תצוגת מחשב" : "Computer view"}</MenuItem>}
          {canChooseView() && viewChoice() !== "auto" && <MenuItem icon="🖱" onSelect={() => setViewChoice("auto")}>{getLocale() === "he" ? "לפי העכבר (אוטומטי)" : "By the mouse (automatic)"}</MenuItem>}
          <MenuItem icon="⟳" href="#/updates">{t("checkUpdates")}</MenuItem>
          <MenuItem icon="↻" onSelect={() => void reconnect({ restart: true })}>{t("restartComputerApp")}</MenuItem>
          <MenuItem icon="💻" onSelect={() => setComputers(true)}>{getLocale() === "he" ? "מחשבים" : "Computers"}</MenuItem>
          {appHome() && <MenuItem icon="⇄" href={`${appHome()!.replace(/\/$/, "")}/?switch=1`}>{t("switchComputer")}</MenuItem>}
          {desktop()?.connectComputer && !isRemote() && <MenuItem icon="🔗" href="#/settings/phone">{getLocale() === "he" ? "התחבר למחשב אחר" : "Connect to another computer"}</MenuItem>}
          {(appHome() || isRemote()) && <MenuItem icon="⏏" danger onSelect={() => { if (confirm(t("disconnectSure"))) disconnectComputer(); }}>{t("disconnectComputer")}</MenuItem>}
        </Menu>
        <PhoneSettings onLocale={onLocale} />
        <button type="button" data-slide-menu data-pad="≡" className="bar-btn" aria-label={t("toggleSidebar")} aria-pressed={sidebarOpen} title={t("toggleSidebar")} onClick={() => { setMenu(false); onSidebar(); }}>
          {Icon.sidebar}
        </button>
        <button type="button" data-pad="B" className="bar-btn hist" aria-label={t("back")} title={t("back")} onClick={() => history.back()}>{Icon.back}</button>
        <button type="button" className="bar-btn hist" aria-label={t("forward")} title={t("forward")} onClick={() => history.forward()}>{Icon.forward}</button>
        {/* In the phone app (remote): Phone / Computer / ☁ Cloud, from the top bar. */}
        {appHome() && (
          <div className="bar-where" role="tablist" aria-label={getLocale() === "he" ? "איפה זה רץ" : "Where it runs"}>
            <a role="tab" href={`${appHome()!.replace(/\/$/, "")}/local.html`}>{getLocale() === "he" ? "טלפון" : "Phone"}</a>
            <span role="tab" aria-selected="true" className="on">{getLocale() === "he" ? "מחשב" : "Computer"}</span>
            {/* Cloud: the Kesher Cloud hub's screens (devices, tasks, pairing), from the app's own cloud.html. */}
            <a role="tab" href={`${appHome()!.replace(/\/$/, "")}/cloud.html${hubUrl ? `?hub=${encodeURIComponent(hubUrl)}` : ""}`}>{getLocale() === "he" ? "☁ ענן" : "☁ Cloud"}</a>
          </div>
        )}
        {/* Home, from every screen (computer, remote and phone). */}
        <a href="#/" className="bar-btn appbar-home" aria-label={getLocale() === "he" ? "בית" : "Home"} title={getLocale() === "he" ? "בית" : "Home"} aria-current={hash === "#/" || hash === "" ? "page" : undefined}>{Icon.home}</a>
        <div className="bar-seg" role="group" aria-label={t("chatOrCode")}>
          <a href="#/" className={!inCode ? "on" : ""} aria-label={t("chatSide")} title={t("chatSide")}>{Icon.chat}</a>
          {/* Code, like the Claude app's Code side: its own start screen, the folder chosen in the message box (no dialog). */}
          {!simple && <a href="#/code" className={inCode ? "on" : ""} aria-label={t("codeSide")} title={t("codeSide")}>{Icon.code}</a>}
        </div>
        {/* In the phone app: where the model runs (redesign 2026-11). Here it is the computer; "on the phone" opens the
            app's own chat with a small model on the phone itself. */}
        {appHome() && (
          <div className="bar-seg device-seg" role="group" aria-label={getLocale() === "he" ? "איפה זה רץ" : "Where it runs"}>
            <a href="#/" className="on" aria-current="true" aria-label={getLocale() === "he" ? "במחשב" : "On the computer"} title={getLocale() === "he" ? "במחשב" : "On the computer"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
            </a>
            <a href={`${appHome()!.replace(/\/$/, "")}/local.html?chat=1`} aria-label={t("phoneChat")} title={t("phoneChat")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>
            </a>
          </div>
        )}
      </div>
      <div className="appbar-main">
        <div className="appbar-title">
          {pageTitle && <span className="bar-page">{pageTitle}</span>}
          {/* Pages render their own title here with a portal; React leaves this element's children to them. */}
          <div id="appbar-title" className="appbar-slot" />
        </div>
        {/* On a phone the open tabs' counter goes here (PageTabs, with a portal), as Chrome's square beside the menu. */}
        <div id="appbar-tabs" className="appbar-slot" />
        <button type="button" data-pad="Y" className="bar-btn palette-btn" aria-label={getLocale() === "he" ? "חיפוש ופקודות (Ctrl+K)" : "Search and commands (Ctrl+K)"} title={getLocale() === "he" ? "חיפוש ופקודות (Ctrl+K)" : "Search and commands (Ctrl+K)"} onClick={openPalette}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="7.5" cy="7.5" r="4.8" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M11.2 11.2 15 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <ComputerTabs host={host} />
        <UpdateButton />
        <DesignAssistant />
        <InboxBell />
        <ComputerHub online={online} status={status} icon={Icon.computer} />
      </div>
      {editMenu && <EditMenuDialog onClose={() => setEditMenu(false)} />}
      {computers && <ComputersDialog onClose={() => setComputers(false)} />}
    </header>
  );
}

/**
 * "Edit the menu" on the phone, over the whole screen. Rendered at the page's root: inside the top bar it was
 * placed against the bar (the bar's style makes "fixed" relative to it), half above the screen with Done out of
 * reach (found by Roee on his phone). Escape and the phone's Back button close it.
 */
function EditMenuDialog({ onClose }: { onClose: () => void }) {
  // The latest onClose, so the effect runs once (a new history entry per render would pile up).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    // Back on the phone: a history entry for the dialog, so Back closes it instead of leaving the page.
    history.pushState({ kesherDialog: true }, "");
    const back = () => close.current();
    addEventListener("keydown", key);
    addEventListener("popstate", back);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("popstate", back);
      if ((history.state as { kesherDialog?: boolean } | null)?.kesherDialog) history.back();
    };
  }, []);
  return createPortal(
    <div className="dialog-backdrop side-edit-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card side-edit-dialog" role="dialog" aria-modal="true" aria-label={getLocale() === "he" ? "עריכת התפריט" : "Edit the menu"} onClick={(e) => e.stopPropagation()}>
        <SidebarEdit onDone={onClose} />
      </div>
    </div>,
    document.body,
  );
}
