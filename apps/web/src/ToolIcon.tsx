import { withToken } from "./api";
import { useAppearance } from "./appearance";

/**
 * A tool's icon: the user's own (Settings → Appearance, or the chat), an
 * emoji or a picture from the library, else the built-in one.
 *
 * @param props.href - The tool's page.
 * @param props.fallback - The built-in icon.
 */
export function ToolIcon({ href, fallback }: { href: string; fallback: string }) {
  const own = useAppearance().icons?.[href];
  if (own && "assetId" in own) return <img className="tool-icon-img" src={withToken(`/api/assets/${own.assetId}`)} alt="" />;
  return <>{own && "emoji" in own ? own.emoji : fallback}</>;
}
