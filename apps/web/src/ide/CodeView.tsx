import { useEffect, useState } from "react";
import { languageOf } from "./languages";

/**
 * Code to read (a chat's code block, a translation, a tool's output): coloured
 * by the same editor that edits code everywhere in KesherAI (VS Code's), so
 * it looks the same wherever it shows. The editor is loaded only once some
 * code is on screen; until then (and for very long text) it is plain text.
 */
export function CodeView(p: { code: string; language?: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lang = p.language ? languageOf(p.language) : "plaintext";
  useEffect(() => {
    let live = true;
    setHtml(null);
    if (lang === "plaintext" || p.code.length > 60_000) return;
    void import("./colorize").then((m) => m.colorize(p.code, lang)).then((h) => live && setHtml(h), () => undefined);
    return () => {
      live = false;
    };
  }, [p.code, lang]);
  return html ? (
    // Monaco writes the text escaped, in spans of its own classes.
    <pre className={`code code-view ${p.className ?? ""}`} dir="ltr"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
  ) : (
    <pre className={`code ${p.className ?? ""}`} dir="ltr"><code>{p.code}</code></pre>
  );
}
