import type { ReactNode } from "react";

/**
 * Code, a command or an id inside a sentence: always left to right and isolated, so in a Hebrew sentence the
 * punctuation around it stays where it belongs (docs/DESIGN_RESEARCH.md §4).
 *
 * @param p.children - The code.
 */
export function Code(p: { children: ReactNode; className?: string }) {
  return (
    <code dir="ltr" className={`bidi-iso${p.className ? ` ${p.className}` : ""}`}>
      {p.children}
    </code>
  );
}

/**
 * A file or folder path inside a sentence: left to right and isolated, like {@link Code}, in the normal font.
 *
 * @param p.children - The path.
 */
export function Path(p: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={`bidi-iso path${p.className ? ` ${p.className}` : ""}`}>
      {p.children}
    </bdi>
  );
}
