import { PluginFrame, usePluginUi } from "../plugins";
import { t } from "../i18n";
import { pageInput } from "../page-input";

/**
 * A page a plugin adds (`#/p/<plugin>/<page>`), shown full size.
 *
 * @param props.route - The part after `#/p/`; `?c=<chat>&f=<file>` opens it with a chat's file (the image editor's
 *   "Edit" on a chat's picture).
 */
export function PluginPage({ route }: { route: string }) {
  const { pages } = usePluginUi();
  const [place, query = ""] = route.split("?");
  const [pluginId, id] = place!.split("/");
  const page = pages.find((p) => p.pluginId === pluginId && p.id === id);
  const input = pageInput(query, page?.uses);
  if (!page) return <div className="page"><p className="muted">{t("plPageMissing")}</p></div>;
  return (
    <div className={page.layout === "app" ? "plugin-page plugin-app" : "plugin-page"}>
      <PluginFrame pluginId={page.pluginId} file={page.file} title={page.title} uses={page.uses ?? []} input={input} />
    </div>
  );
}
