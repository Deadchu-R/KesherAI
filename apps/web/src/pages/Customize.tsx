import { lazy, Suspense } from "react";
import { t } from "../i18n";

const ConnectionsPage = lazy(() => import("./Connections").then((m) => ({ default: m.ConnectionsPage })));
const PluginsPage = lazy(() => import("./Plugins").then((m) => ({ default: m.PluginsPage })));
const PartsPage = lazy(() => import("./PartsPage").then((m) => ({ default: m.PartsPage })));

/** The tabs, each at the address it always had (links and pins keep working). */
const TABS = [
  { href: "#/connections", label: "connections" },
  { href: "#/plugins", label: "pluginsNav" },
  { href: "#/parts", label: "partsNav" },
] as const;

/**
 * One place to make KesherAI yours (like Claude Desktop's Customize): connections (services, servers, MCP, devices),
 * plugins and mods, and which parts are on. Each tab is the page it always was, under one row of tabs, so the menu
 * and All tools carry one entry instead of three (audit 2026-11, F20).
 *
 * @param props.hash - The current address (which tab is open).
 */
export function CustomizePage({ hash }: { hash: string }) {
  const tab = TABS.find((x) => hash === x.href) ?? TABS[0];
  return (
    <div className="customize">
      <nav className="tabs customize-tabs" aria-label={t("customizeNav")}>
        {TABS.map((x) => (
          <a key={x.href} href={x.href} className={x.href === tab.href ? "on" : ""} aria-current={x.href === tab.href ? "page" : undefined}>
            {t(x.label)}
          </a>
        ))}
      </nav>
      <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
        {tab.href === "#/connections" ? <ConnectionsPage /> : tab.href === "#/plugins" ? <PluginsPage /> : <PartsPage />}
      </Suspense>
    </div>
  );
}
