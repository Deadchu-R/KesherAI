import { useEffect, useId, useState } from "react";

/**
 * Math (KaTeX) and Mermaid diagrams in an answer, loaded only when an answer has them (both libraries are big).
 * KaTeX runs with its safe defaults (no \href, no HTML); Mermaid with securityLevel "strict" (its labels are
 * sanitized and links do nothing).
 */

let katexLoad: Promise<typeof import("katex").default> | undefined;
const katex = () => (katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default));

/** TeX drawn by KaTeX; `fallback` (readable text) is shown until it loads, or if the TeX has an error. */
export function MathView({ tex, display, fallback }: { tex: string; display?: boolean; fallback: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void katex().then((k) => {
      try {
        const out = k.renderToString(tex, { displayMode: !!display, throwOnError: true, output: "htmlAndMathml" });
        if (live) setHtml(out);
      } catch {
        if (live) setHtml(null);
      }
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [tex, display]);
  const cls = display ? "md-math md-math-block" : "md-math";
  // KaTeX's own output (its safe defaults), not the model's text.
  return html ? <span className={`${cls} md-katex`} dir="ltr" dangerouslySetInnerHTML={{ __html: html }} /> : <span className={cls} dir="ltr">{fallback}</span>;
}

let mermaidLoad: Promise<typeof import("mermaid").default> | undefined;
const mermaid = () =>
  (mermaidLoad ??= import("mermaid").then((m) => {
    const dark = document.documentElement.dataset.theme !== "light";
    m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" });
    return m.default;
  }));

/** A ```mermaid block drawn as a diagram; while it is still being written, or if it has an error, the code shows. */
export function MermaidView({ code, fallback }: { code: string; fallback: React.ReactNode }) {
  const id = `mmd-${useId().replace(/[^\w-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void mermaid().then(async (m) => {
        try {
          await m.parse(code);
          const { svg: out } = await m.render(id, code);
          if (live) setSvg(out);
        } catch {
          if (live) setSvg(null);
        }
      }, () => undefined);
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, id]);
  // Mermaid's own SVG, made with securityLevel "strict".
  return svg ? <div className="md-mermaid" dir="ltr" dangerouslySetInnerHTML={{ __html: svg }} /> : <>{fallback}</>;
}
