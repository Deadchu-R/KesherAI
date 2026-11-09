import type React from "react";
import { CodeView } from "./ide/CodeView";

/** Inline Markdown: **bold**, *italic*, `code` and [links](https://…). */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="inline-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(<a key={k} href={href} target="_blank" rel="noreferrer">{label}</a>);
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders a reply's Markdown: headings, lists, bold, code blocks and inline code. */
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
        out.push(list.ordered ? <ol key={k}>{list.items}</ol> : <ul key={k}>{list.items}</ul>);
        list = null;
      };
      lines.forEach((line, j) => {
        const k = `${i}-${j}`;
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (h) {
          flush(`l${k}`);
          out.push(<p key={k} className={`md-h md-h${h[1]!.length}`}>{inline(h[2]!, k)}</p>);
        } else if (li) {
          const ordered = !!li[2];
          if (!list || list.ordered !== ordered) {
            flush(`l${k}`);
            list = { ordered, items: [] };
          }
          list.items.push(<li key={k}>{inline(li[3]!, k)}</li>);
        } else {
          flush(`l${k}`);
          if (line.trim()) out.push(<p key={k}>{inline(line, k)}</p>);
        }
      });
      flush(`l${i}-end`);
    }
    if (parts[i + 2] !== undefined) out.push(<CodeView key={`c${i}`} code={parts[i + 2]!} language={parts[i + 1] || undefined} />);
  }
  return <div className="msg-text">{out}</div>;
}

