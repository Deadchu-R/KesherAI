import { Fragment } from "react";
import { PHONE_TABS, type PhoneTab } from "@kesher/shared";
import { t } from "./i18n";
import { useAppearance } from "./appearance";
import { GLYPHS } from "./ui/Glyph";

/** Line icons for the bar (one stroke weight, like the phone's own). */
const I = {
  chats: <path d="M4 5h16v11H9l-5 4z" />,
  new: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  tools: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></>,
  settings: <>{GLYPHS.gear!.map((d) => <path key={d} d={d} />)}</>,
};
const icon = (k: keyof typeof I) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[k]}</svg>
);

/**
 * The phone's bottom bar (thumb reach, like phone apps): chats, a new chat,
 * all tools, settings. Hidden inside a chat, where the message box is.
 */
export function PhoneTabs({ hash, onChats }: { hash: string; onChats: () => void }) {
  // The user's order (Settings → Appearance → Phone bar).
  const order = useAppearance().tabsOrder;
  if (hash.startsWith("#/c/") || hash.startsWith("#/p/") || hash === "#/nodes") return null;
  const tab = (href: string, k: keyof typeof I, label: string) => (
    <a href={href} className="tab" aria-current={hash === href || (href === "#/settings" && hash.startsWith("#/settings")) ? "page" : undefined}>
      {icon(k)}
      <small>{label}</small>
    </a>
  );
  const parts: Record<PhoneTab, React.ReactNode> = {
    chats: (
      <button key="chats" type="button" className="tab" onClick={onChats}>
        {icon("chats")}
        <small>{t("tabChats")}</small>
      </button>
    ),
    new: <Fragment key="new">{tab("#/", "new", t("tabNew"))}</Fragment>,
    tools: <Fragment key="tools">{tab("#/apps", "tools", t("tabTools"))}</Fragment>,
    settings: <Fragment key="settings">{tab("#/settings", "settings", t("settings"))}</Fragment>,
  };
  return (
    <nav className="phone-tabs" aria-label="Main" data-slide-bar>
      {(order ?? PHONE_TABS).map((k) => parts[k])}
    </nav>
  );
}
