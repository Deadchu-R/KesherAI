import { PluginFrame, usePluginUi } from "../plugins";
import { t } from "../i18n";
import { EDITOR_NAMES, returnChipHref, ticketOf } from "../editor-handoff";
import { getLocale } from "../i18n";
import { offerPart } from "../plugins";
import { godotSceneInput, pageInput, unitySceneInput, unrealLevelInput } from "../page-input";

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
  const godot = godotSceneInput(query, page?.uses);
  const unity = unitySceneInput(query, page?.uses);
  const unreal = unrealLevelInput(query, page?.uses);
  if (!page) return <div className="page"><p className="muted">{t("plPageMissing")}</p></div>;
  // An editor opened by another editor ("Edit in…") carries a way back: the chip leaves the result and goes back as it was.
  const ticket = ticketOf(input);
  const he = getLocale() === "he";
  const name = ticket ? (he ? EDITOR_NAMES[ticket.plugin].he : EDITOR_NAMES[ticket.plugin].en) : "";
  const goBack = () => {
    if (!ticket || !input) return;
    // The editor it came from may have been removed meanwhile: the Install window first, then the same way back.
    void offerPart(ticket.plugin, he ? "כדי לחזור" : "Going back").then((on) => { if (on) location.hash = returnChipHref(input.conversationId, ticket); });
  };
  return (
    <div className={page.layout === "app" ? "plugin-page plugin-app" : "plugin-page"}>
      {ticket && (
        <button type="button" className="return-chip" onClick={goBack} title={he ? "חזרה בלי להחזיר תוצאה" : "Go back without a result"}>
          <span aria-hidden>↩</span> {he ? `חזרה ל${name}` : `Return to ${name}`}
        </button>
      )}
      <PluginFrame pluginId={page.pluginId} file={page.file} title={page.title} uses={page.uses ?? []} input={input} godot={godot} unity={unity} unreal={unreal} />
    </div>
  );
}
