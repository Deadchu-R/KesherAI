/**
 * One menu for the whole app (Roee: "a unified menu between the computer and the phone"). Every menu draws its
 * entries from `useAppMenu`, so the computer's sidebar, the phone's menu drawer, the top bar's ☰ menu and the home
 * screen show the same things in the same order: the main actions, the pinned tools, and the user's shortcuts.
 * Pins and shortcuts are kept on the computer, so every device shows the same ones.
 */
import { NEW_CODE_EVENT } from "./AppBar";
import { t } from "./i18n";
import { NAV_ICONS, useNavItems, usePins } from "./Sidebar";
import { useShortcuts } from "./SidebarShortcuts";

/** One entry of the menu. `href` opens a page (or, for http/https, a site outside); `run` does an action. */
export interface MenuEntry { key: string; label: string; icon: string; href?: string; run?: () => void; external?: boolean; tool?: boolean }

/** The menu's three parts, in their order. */
export interface AppMenu { main: MenuEntry[]; pinned: MenuEntry[]; shortcuts: MenuEntry[] }

/** The app's menu entries (the same for every menu and every device). */
export function useAppMenu(): AppMenu {
  const nav = useNavItems();
  const [pins] = usePins();
  const shortcuts = useShortcuts();
  return {
    main: [
      { key: "new-chat", label: t("newChat"), icon: "+", href: "#/" },
      { key: "new-code", label: t("newCode"), icon: "</>", run: () => dispatchEvent(new Event(NEW_CODE_EVENT)) },
      { key: "all-tools", label: t("allTools"), icon: "▦", href: "#/apps" },
    ],
    pinned: pins.flatMap((href) => {
      const n = nav.find((x) => x.href === href);
      return n ? [{ key: href, label: n.label, icon: NAV_ICONS[href] ?? "•", href, tool: true }] : [];
    }),
    shortcuts: shortcuts.map((s) => ({ key: `sc:${s.id}`, label: s.label, icon: s.image ? "🌐" : s.icon ?? "⭐", href: s.href, external: /^https?:/i.test(s.href) })),
  };
}
