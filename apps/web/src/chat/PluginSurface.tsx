import { closePanel } from "../ArtifactPanel";
import { EDITOR_NAMES, isEditor } from "../editor-handoff";
import { getLocale, he$ } from "../i18n";
import { pageInput } from "../page-input";
import { PluginFrame, usePluginUi } from "../plugins";
import type { SurfacePanelProps } from "../surfaces";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * An editor plugin's page in the chat's side panel, on a chat file (surfaces.ts editor surfaces): the same sandboxed
 * frame and bridge as its own page, with the panel's bar (back to chat, full page, full screen, close). On the phone
 * the panel is full screen. Loaded only when such a file is first opened, so an editor that is off adds nothing.
 *
 * @param props - `item`: the surface (the editor's plugin id) and the chat file; `full`/`onFull`: full screen.
 */
export function PluginSurface({ item, full, onFull }: SurfacePanelProps) {
  const { pages } = usePluginUi();
  const page = pages.find((p) => p.pluginId === item.surface);
  const name = item.path?.split("/").pop() ?? item.id;
  const query = `c=${encodeURIComponent(item.convId ?? "")}&f=${encodeURIComponent(item.path ?? "")}`;
  const input = page ? pageInput(query, page.uses) : undefined;
  const editor = isEditor(item.surface) ? EDITOR_NAMES[item.surface] : undefined;
  return (
    <>
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={closePanel}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <strong className="grow" dir="auto">{name}</strong>
        {editor && <span className="muted small artifact-wide-only">{L(editor.he, editor.en)}</span>}
        {page && <button type="button" className="ghost" title={L("פתיחה בעמוד מלא", "Open full page")} aria-label={L("פתיחה בעמוד מלא", "Open full page")} onClick={() => { location.hash = `#/p/${page.pluginId}/${page.id}?${query}`; }}>↗</button>}
        <button type="button" className="ghost artifact-wide-only" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={closePanel}>✕</button>
      </div>
      {page && input ? (
        <div className="plugin-surface-body">
          <PluginFrame key={`${page.pluginId}:${item.path}`} pluginId={page.pluginId} file={page.file} title={page.title} conversationId={input.conversationId} uses={page.uses ?? []} input={input} />
        </div>
      ) : (
        <p className="muted small plugin-surface-body" role="status">{page ? L("הקובץ הזה לא נפתח בעורך הזה.", "This editor does not open this file.") : L("העורך עוד לא נטען…", "The editor is not loaded yet…")}</p>
      )}
    </>
  );
}
