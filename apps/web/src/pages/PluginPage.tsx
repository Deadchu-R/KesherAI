import { PluginFrame, usePluginUi } from "../plugins";
import { t } from "../i18n";

/**
 * A page a plugin adds (`#/p/<plugin>/<page>`), shown full size.
 *
 * @param props.route - The part after `#/p/`.
 */
export function PluginPage({ route }: { route: string }) {
  const { pages } = usePluginUi();
  const [pluginId, id] = route.split("/");
  const page = pages.find((p) => p.pluginId === pluginId && p.id === id);
  if (!page) return <div className="page"><p className="muted">{t("plPageMissing")}</p></div>;
  return (
    <div className={page.layout === "app" ? "plugin-page plugin-app" : "plugin-page"}>
      <PluginFrame pluginId={page.pluginId} file={page.file} title={page.title} uses={page.uses ?? []} />
    </div>
  );
}
