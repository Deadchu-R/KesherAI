import type { ReactNode } from "react";
import { useAppearance } from "../appearance";
import { GLYPHS, glyphName } from "./glyphs";

export { GLYPHS, glyphName };

/**
 * KesherAI's own line icons (drawn for this app, 24 × 24, one stroke width, round ends), as Claude, Linear and
 * VS Code draw their menus: thin and the colour of the text, so a menu reads calmly instead of as a row of
 * colourful emoji. Every place that shows an icon from a string (menus, the sidebar, the palette, All tools) passes
 * it through `Glyph`: a known emoji or page becomes its line drawing, anything else stays as it is. Settings →
 * Appearance → "Emoji icons" brings the emoji back.
 */

/**
 * One line icon by name.
 *
 * @param props.name - A key of GLYPHS.
 * @param props.size - Width and height in px (default 18).
 */
export function LineIcon({ name, size = 18 }: { name: string; size?: number }) {
  const paths = GLYPHS[name];
  if (!paths) return null;
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/**
 * An icon from a string: its line drawing when there is one (and the look is not "emoji"), else the string itself.
 *
 * @param props.of - The emoji, sign, or a ready element.
 * @param props.href - The page it stands for (picks the right drawing for two pages with one emoji).
 * @param props.size - In px.
 */
export function Glyph({ of, href, size }: { of: ReactNode; href?: string; size?: number }) {
  const style = useAppearance().iconStyle ?? "line";
  const name = style === "line" ? glyphName(of, href) : undefined;
  return name ? <LineIcon name={name} {...(size ? { size } : {})} /> : <>{of}</>;
}
