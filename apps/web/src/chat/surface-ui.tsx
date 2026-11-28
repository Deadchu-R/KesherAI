import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import { openSurface } from "../ArtifactPanel";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { useParts } from "../parts";
import { offerPart, usePluginUi } from "../plugins";
import { BUILT_IN, buildSurfaces, openTarget, type ChatSurface, type SurfaceCardProps, type SurfaceItem } from "../surfaces";

/*
 * The chat's side of the surfaces (surfaces.ts): the registry built from what is installed, a surface's card in the
 * message, and "Open in chat" for a file (with the install offer when its part is off). Works the same over remote:
 * the parts and plugin pages come from the server, and the panel is full screen on the phone.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** @returns The registered surfaces: built from `/api/parts` and `/api/plugins/ui`; re-renders when they change. */
export function useSurfaces(): ChatSurface[] {
  const { parts } = useParts();
  const { pages } = usePluginUi();
  return buildSurfaces(BUILT_IN, { parts, pluginPages: pages });
}

const cards = new Map<string, LazyExoticComponent<ComponentType<SurfaceCardProps>>>();
const narrow = () => matchMedia("(max-width: 1099px)").matches;

/**
 * A surface's card in the message: its own lazy card when it has one (documents, sheets, decks), else a plain card
 * with the item's name and Open. A card that first shows while the model works opens the panel on a wide screen.
 *
 * @param props - `item` (with its surface and chat), `live`: the model is still working.
 */
export function SurfaceCard({ item, live = false }: { item: SurfaceItem; live?: boolean }) {
  const s = BUILT_IN.find((x) => x.id === item.surface);
  if (s?.card) {
    if (!cards.has(s.id)) cards.set(s.id, lazy(s.card));
    const Card = cards.get(s.id)!;
    return <Suspense fallback={null}><Card item={item} {...(item.ver ? { ver: item.ver } : {})} live={live} /></Suspense>;
  }
  return <PlainCard item={item} live={live} name={s ? L(s.title.he, s.title.en) : ""} />;
}

/** The card of a surface without its own: name, kind and Open. */
function PlainCard({ item, live, name }: { item: SurfaceItem; live: boolean; name: string }) {
  useEffect(() => {
    if (live && !narrow()) openSurface(item);
    // Only when the card first shows: closing the panel must not open it again.
  }, []);
  const title = item.title || item.path?.split("/").pop() || item.id;
  return (
    <button type="button" className="item-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${title}`}>
      <span className="item-card-text">
        <strong dir="auto">{title}</strong>
        <small className="muted">{name}{item.ver ? ` · v${item.ver}` : ""}</small>
      </span>
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * "Open in chat" for a chat file: opens it in the surface for its type in the side panel (full screen on the phone).
 * When the tool that opens it is off, the same chip offers to install it first and then opens. Nothing shows for a
 * type no tool opens.
 *
 * @param props.convId - The chat whose folder holds the file.
 * @param props.name - The file's name (its type picks the surface).
 * @param props.path - The file's path in the chat's folder, or `resolve` to get it on tap (an asset copied in first).
 * @param props.auto - Open once when first shown (the agent's `open_in_chat` while it works, on a wide screen).
 */
export function OpenInChat({ convId, name, path, resolve, auto = false }: { convId: string; name: string; path?: string; resolve?: () => Promise<string>; auto?: boolean }) {
  const list = useSurfaces();
  const target = openTarget(BUILT_IN, list, name);
  const open = async () => {
    if (!target) return;
    try {
      if ("install" in target && !(await offerPart(target.install, L("פתיחה בצ'אט", "Open in chat")))) return;
      const p = path ?? (await resolve?.());
      if (!p) return;
      openSurface({ surface: target.surface.id, kind: target.surface.kinds[0] ?? "", id: p, path: p, convId, title: name });
    } catch (e) {
      toast((e as Error).message);
    }
  };
  useEffect(() => {
    if (auto && target && !("install" in target) && !narrow()) void open();
  }, []);
  if (!target) return null;
  const tool = L(target.surface.title.he, target.surface.title.en);
  return "install" in target ? (
    <button type="button" className="chip-text" title={L(`צריך להתקין את ${tool}`, `Needs ${tool} installed`)} onClick={() => void open()}>📦 {L("התקנה ופתיחה בצ'אט", "Install and open in chat")}</button>
  ) : (
    <button type="button" className="chip-text" title={tool} onClick={() => void open()}>▣ {L("פתיחה בצ'אט", "Open in chat")}</button>
  );
}

/**
 * The card of a file the agent opened with `open_in_chat`: its name and "Open in chat" (or the install offer).
 *
 * @param props - The chat, the file's path and `live`: the model is still working (opens it once on a wide screen).
 */
export function SurfaceOpenCard({ convId, path, live = false }: { convId: string; path: string; live?: boolean }) {
  const name = path.split("/").pop() ?? path;
  return (
    <div className="item-card surface-open-card">
      <span className="item-card-text">
        <strong dir="ltr">{name}</strong>
        <small className="muted" dir="ltr">{path}</small>
      </span>
      <OpenInChat convId={convId} name={name} path={path} auto={live} />
    </div>
  );
}
