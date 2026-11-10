import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { NEW_CODE_EVENT } from "./AppBar";
import { useLibrary } from "./library";
import { t } from "./i18n";

type Item = { key: string; label: string; icon: string; go: () => void };

/**
 * "Jump to": the app's Menu (press and hold, slide over the places, let go to
 * open one; a quick tap opens it to click; arrow keys and Enter work too).
 */
export function QuickMenu() {
  const { conversations } = useLibrary();

  const nav = (hash: string) => () => {
    location.hash = hash;
  };
  const items: Item[] = [
    { key: "chat", label: t("newChat"), icon: "+", go: nav("#/") },
    { key: "code", label: t("newCode"), icon: "</>", go: () => dispatchEvent(new Event(NEW_CODE_EVENT)) },
    { key: "models", label: t("models"), icon: "◈", go: nav("#/models") },
    { key: "images", label: t("images"), icon: "◐", go: nav("#/images") },
    { key: "community", label: t("communityNav"), icon: "✦", go: nav("#/community") },
    { key: "usage", label: t("usageNav"), icon: "≋", go: nav("#/usage") },
    { key: "settings", label: t("settings"), icon: "⚙", go: nav("#/settings") },
    ...conversations.slice(0, 5).map((c) => ({ key: c.id, label: c.title, icon: c.kind === "code" ? "</>" : "•", go: nav(`#/c/${c.id}`) })),
  ];

  const places = items.slice(0, 7);
  const recent = items.slice(7);
  return (
    <Menu
      className="qm"
      popClassName="qm-pop"
      triggerClassName="qm-btn"
      title={t("qmHint")}
      aria-label={t("qmLabel")}
      trigger={<>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="4" r="1.6" fill="currentColor" /><circle cx="12" cy="4" r="1.6" fill="currentColor" />
          <circle cx="4" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" />
        </svg>
        <span>{t("qmLabel")}</span>
        <kbd className="qm-hint">{t("qmHold")}</kbd>
      </>}
    >
      {places.map((it) => <MenuItem key={it.key} icon={it.icon} onSelect={it.go}>{it.label}</MenuItem>)}
      {recent.length > 0 && <MenuSeparator />}
      {recent.map((it) => <MenuItem key={it.key} icon={it.icon} dir="auto" onSelect={it.go}>{it.label}</MenuItem>)}
    </Menu>
  );
}
