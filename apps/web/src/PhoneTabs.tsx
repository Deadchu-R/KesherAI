import { t } from "./i18n";

/** Line icons for the bar (one stroke weight, like the phone's own). */
const I = {
  chats: <path d="M4 5h16v11H9l-5 4z" />,
  new: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  tools: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
};
const icon = (k: keyof typeof I) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[k]}</svg>
);

/**
 * The phone's bottom bar (thumb reach, like phone apps): chats, a new chat,
 * all tools, settings. Hidden inside a chat, where the message box is.
 */
export function PhoneTabs({ hash, onChats }: { hash: string; onChats: () => void }) {
  if (hash.startsWith("#/c/") || hash.startsWith("#/p/") || hash === "#/nodes") return null;
  const tab = (href: string, k: keyof typeof I, label: string) => (
    <a href={href} className="tab" aria-current={hash === href || (href === "#/settings" && hash.startsWith("#/settings")) ? "page" : undefined}>
      {icon(k)}
      <small>{label}</small>
    </a>
  );
  return (
    <nav className="phone-tabs" aria-label="Main">
      <button type="button" className="tab" onClick={onChats}>
        {icon("chats")}
        <small>{t("tabChats")}</small>
      </button>
      {tab("#/", "new", t("tabNew"))}
      {tab("#/apps", "tools", t("tabTools"))}
      {tab("#/settings", "settings", t("settings"))}
    </nav>
  );
}
