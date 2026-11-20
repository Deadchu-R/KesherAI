import type React from "react";
import { useState } from "react";
import { CodeView } from "./ide/CodeView";
import { getLocale, he$ } from "./i18n";
import { withToken } from "./api";
import { AssetEmbed } from "./MediaView";
import { assetIdOf } from "./chat/chat-inline";
import { ChartView } from "./ChartView";
import { MathView, MermaidView } from "./MathMermaid";
import { FunctionGraph } from "./FunctionGraph";
import { artifactKey, isArtifact, openArtifact } from "./ArtifactPanel";
import { parseChart } from "./chart";
import { parseGraph } from "@kesher/shared";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A picture's address a reply may show: the web (https) or KesherAI's own files. */
const imageSrc = (src: string) => (/^https:\/\/[^\s"'<>]+$/i.test(src) || /^\/api\/(assets|files)\/[\w./?=&%-]+$/.test(src) ? src : undefined);

const GREEK: Record<string, string> = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", omega: "ω", Omega: "Ω", cdot: "·", times: "×", div: "÷", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", infty: "∞", to: "→", rightarrow: "→", sum: "∑", int: "∫", partial: "∂", nabla: "∇", in: "∈" };
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "n": "ⁿ", "-": "⁻", "+": "⁺" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "i": "ᵢ", "n": "ₙ", "x": "ₓ" };

/**
 * Simple TeX as readable text (no math library): Greek letters and symbols, \frac{a}{b} → (a)/(b), \sqrt{x} → √(x),
 * x^2 → x², x_1 → x₁. Anything else stays as written.
 *
 * @example texText("\\Delta x / \\Delta t") → "Δx / Δt"
 */
export function texText(tex: string): string {
  return tex
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
    .replace(/\\(?:left|right|,|;|!|quad)/g, "")
    .replace(/\\([A-Za-z]+)\s?/g, (m, w: string) => GREEK[w] ?? m)
    .replace(/\^\{?([0-9n+-]+)\}?/g, (m, d: string) => ([...d].every((c) => SUP[c]) ? [...d].map((c) => SUP[c]).join("") : m))
    .replace(/_\{?([0-9inx]+)\}?/g, (m, d: string) => ([...d].every((c) => SUB[c]) ? [...d].map((c) => SUB[c]).join("") : m));
}

/** Inline Markdown: **bold**, *italic*, ~~struck~~, `code`, $math$, [links](https://…), pictures and bare https links. */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~|!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\((?:https?:\/\/|\/api\/assets\/)[^)\s]+\)|\$[^$\s\d][^$\n]*?[=^_\\][^$\n]*?\$|https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="inline-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("~~")) out.push(<s key={k}>{tok.slice(2, -2)}</s>);
    else if (tok.startsWith("$")) out.push(<MathView key={k} tex={tok.slice(1, -1)} fallback={texText(tok.slice(1, -1))} />);
    else if (tok.startsWith("![")) {
      const [, alt, src] = /!\[([^\]]*)\]\(([^)]+)\)/.exec(tok)!;
      const ok = imageSrc(src!);
      out.push(ok ? <AnswerImage key={k} src={ok} alt={alt ?? ""} /> : alt);
    } else if (/^https?:/.test(tok)) out.push(<a key={k} href={tok} target="_blank" rel="noreferrer" dir="ltr">{tok}</a>);
    else if (tok.startsWith("[")) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      // KesherAI's own file (inside a sentence): the link carries the token, so it opens from the phone too.
      out.push(<a key={k} href={assetIdOf(href!) ? withToken(`/api/assets/${assetIdOf(href!)}`) : href} target="_blank" rel="noreferrer">{label}</a>);
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A table row's cells ("| a | b |" or "a | b"); a "\\|" stays in its cell. */
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Whether a line is a table's line under its header: "|---|:---:|--:|". */
export function isTableRule(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes("|");
}

/**
 * A Markdown table (GitHub's way, which models write): a header row, the "|---|" line (":" sets alignment),
 * then rows. Scrolls sideways on a narrow screen instead of squeezing.
 */
function table(lines: string[], k: string): React.ReactNode {
  const head = cells(lines[0]!);
  const align = cells(lines[1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "end" : c.startsWith(":") ? "start" : undefined));
  const rows = lines.slice(2).map(cells);
  return (
    <div key={k} className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>{head.map((c, i) => <th key={i} dir="auto" style={align[i] ? { textAlign: align[i] } : undefined}>{inline(c, `${k}h${i}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, j) => (
            <tr key={j}>
              {head.map((_, i) => <td key={i} dir="auto" style={align[i] ? { textAlign: align[i] } : undefined}>{inline(r[i] ?? "", `${k}r${j}c${i}`)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders a reply's Markdown: headings, lists, tables, bold, code blocks and inline code. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose) {
      const lines = prose.split("\n");
      let list: { ordered: boolean; items: React.ReactNode[] } | null = null;
      const flush = (k: string) => {
        if (!list) return;
        out.push(list.ordered ? <ol key={k} dir="auto">{list.items}</ol> : <ul key={k} dir="auto">{list.items}</ul>);
        list = null;
      };
      let skip = 0;
      lines.forEach((line, j) => {
        const k = `${i}-${j}`;
        if (skip) {
          skip--;
          return;
        }
        // A table: this line has "|", the next is the "|---|" line; the rows go on while lines have "|".
        if (line.includes("|") && lines[j + 1] !== undefined && isTableRule(lines[j + 1]!)) {
          let end = j + 2;
          while (end < lines.length && lines[end]!.includes("|") && lines[end]!.trim()) end++;
          flush(`l${k}`);
          out.push(table(lines.slice(j, end), `t${k}`));
          skip = end - j - 1;
          return;
        }
        // A quote: lines starting with ">" go together.
        if (/^\s*>/.test(line)) {
          let end = j;
          while (end < lines.length && /^\s*>/.test(lines[end]!)) end++;
          flush(`l${k}`);
          out.push(<blockquote key={k} dir="auto" className="md-quote">{lines.slice(j, end).map((q, n) => <p key={n}>{inline(q.replace(/^\s*>\s?/, ""), `${k}q${n}`)}</p>)}</blockquote>);
          skip = end - j - 1;
          return;
        }
        // Math on its own lines: $$ … $$.
        if (line.trim().startsWith("$$")) {
          let end = j;
          const one = line.trim().length > 4 && line.trim().endsWith("$$");
          if (!one) while (end + 1 < lines.length && !lines[end + 1]!.includes("$$")) end++;
          const body = (one ? line.trim().slice(2, -2) : lines.slice(j, Math.min(end + 2, lines.length)).join("\n").replace(/\$\$/g, "")).trim();
          flush(`l${k}`);
          out.push(<MathView key={k} display tex={body} fallback={texText(body)} />);
          skip = one ? 0 : Math.min(end + 1, lines.length - 1) - j;
          return;
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flush(`l${k}`);
          out.push(<hr key={k} className="md-hr" />);
          return;
        }
        // A line that is only a link to (or a picture of) a file KesherAI made: its player and chips (Download, Drive, editor).
        const own = /^\s*!?\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
        if (own && assetIdOf(own[2]!)) {
          flush(`l${k}`);
          out.push(<AssetEmbed key={k} href={own[2]!} label={own[1] || own[2]!} />);
          return;
        }
        // A line that is only a link: a card with the site's name.
        const only = /^\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/.exec(line);
        if (only) {
          flush(`l${k}`);
          out.push(<LinkCard key={k} href={only[1]!} />);
          return;
        }
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (h) {
          flush(`l${k}`);
          out.push(<p key={k} dir="auto" className={`md-h md-h${h[1]!.length}`}>{inline(h[2]!, k)}</p>);
        } else if (li) {
          const ordered = !!li[2];
          if (!list || list.ordered !== ordered) {
            flush(`l${k}`);
            list = { ordered, items: [] };
          }
          list.items.push(<li key={k} dir="auto" {...(ordered ? { value: Number(li[2]) } : {})}>{inline(li[3]!, k)}</li>);
        } else {
          flush(`l${k}`);
          if (line.trim()) out.push(<p key={k} dir="auto">{inline(line, k)}</p>);
        }
      });
      flush(`l${i}-end`);
    }
    if (parts[i + 2] !== undefined) {
      // A block written inside a list is indented: the code itself starts at its own left edge.
      parts[i + 2] = dedent(parts[i + 2]!);
      // A ```chart block with complete JSON is drawn; while it is still being written (or if it is not a chart) it shows as code.
      const chart = parts[i + 1] === "chart" ? parseChart(parts[i + 2]!) : undefined;
      const graph = parts[i + 1] === "graph" || parts[i + 1] === "plot" ? parseGraph(parts[i + 2]!) : undefined;
      const code = <CodeBlock key={`c${i}`} code={parts[i + 2]!} language={parts[i + 1] || undefined} />;
      out.push(graph ? <FunctionGraph key={`c${i}`} spec={graph} /> : chart ? <ChartView key={`c${i}`} spec={chart} /> : parts[i + 1] === "mermaid" ? <MermaidView key={`c${i}`} code={parts[i + 2]!} fallback={code} /> : code);
    }
  }
  return <div className="msg-text">{out}</div>;
}


/** A link on its own line, as a card: the site's name and the address (nothing is fetched from the site). */
function LinkCard({ href }: { href: string }) {
  let host = "";
  try {
    host = new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return <p dir="ltr">{href}</p>;
  }
  return (
    <a className="md-link-card" href={href} target="_blank" rel="noreferrer">
      <span className="md-link-icon" aria-hidden>🔗</span>
      <span className="md-link-text"><strong>{host}</strong><span className="muted small" dir="ltr">{href.replace(/^https?:\/\//, "").slice(0, 90)}</span></span>
    </a>
  );
}

/** A code block with its language and a copy button above it. */
function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const live = isArtifact(language, code);
  const copy = () => void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  return (
    <div className="md-code" {...(live ? { "data-artifact": artifactKey(code) } : {})}>
      <div className="md-code-bar"><span className="muted small" dir="ltr">{language || L("קוד", "code")}</span><span className="row" style={{ gap: 4 }}>{live && <button type="button" className="primary small" onClick={() => openArtifact(code)}>{L("פתח חי ▸", "Open live ▸")}</button>}<button type="button" className="ghost small" onClick={copy}>{copied ? L("הועתק ✓", "Copied ✓") : L("העתק", "Copy")}</button></span></div>
      <CodeView code={code} language={language} />
    </div>
  );
}

/**
 * A picture in an answer. KesherAI's own pictures show at once; a picture from another site waits for a tap (an
 * address the model wrote could carry data out to that site, the known Markdown-image leak).
 */
function AnswerImage({ src, alt }: { src: string; alt: string }) {
  const own = src.startsWith("/api/");
  const [show, setShow] = useState(own);
  let host = "";
  try {
    host = own ? "" : new URL(src).hostname;
  } catch {
    return <>{alt}</>;
  }
  if (!show) return <button type="button" className="md-img-ask" onClick={() => setShow(true)}>🖼️ {L(`תמונה מ-${host}: הצג`, `A picture from ${host}: show`)}{alt ? ` · ${alt}` : ""}</button>;
  // The app loads pictures only from itself: another site's picture comes through KesherAI (on this tap only).
  const shown = own ? src : withToken(`/api/web/image?url=${encodeURIComponent(src)}`);
  return <a href={src} target="_blank" rel="noreferrer"><img className="md-img" src={shown} alt={alt} loading="lazy" referrerPolicy="no-referrer" /></a>;
}

/** Code without the indentation every line shares (a block written inside a list item). */
export function dedent(code: string): string {
  const lines = code.replace(/\s+$/, "").split("\n");
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return pad > 0 && Number.isFinite(pad) ? `${lines.map((l) => l.slice(pad)).join("\n")}\n` : code;
}
