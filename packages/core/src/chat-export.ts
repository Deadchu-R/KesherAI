import type { Conversation } from "@kesher/shared";

/**
 * A chat as a file to keep or share: Markdown, or a print-ready HTML page
 * (which the desktop app turns into a PDF). What the user saw is exported:
 * their messages, the answers, and one short line per tool the agent used.
 */

const who = (role: "user" | "assistant", he: boolean) => (role === "user" ? (he ? "אני" : "You") : "KesherAI");

/** Whether the chat is mostly in Hebrew or Arabic (the page is right to left). */
function rtl(text: string): boolean {
  // Code is in English whatever the chat's language: leave it out.
  text = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const r = (text.match(/[֐-׿؀-ۿ]/g) ?? []).length;
  const l = (text.match(/[A-Za-z]/g) ?? []).length;
  return r > l;
}

/** The chat's turns, in order. */
function turns(c: Conversation): Array<{ role: "user" | "assistant"; text: string; at: string; tools: string[] }> {
  const out: Array<{ role: "user" | "assistant"; text: string; at: string; tools: string[] }> = [];
  let tools: string[] = [];
  for (const e of c.events) {
    if (e.type === "user" || e.type === "answer") {
      out.push({ role: "user", text: e.text, at: e.at, tools: [] });
      tools = [];
    } else if (e.type === "tool_call") tools.push(e.name);
    else if (e.type === "assistant" && e.text.trim()) {
      out.push({ role: "assistant", text: e.text, at: e.at, tools });
      tools = [];
    }
  }
  return out;
}

/**
 * @param c - The conversation (with its events).
 * @returns The chat as Markdown.
 */
export function conversationMarkdown(c: Conversation): string {
  const list = turns(c);
  const he = rtl(list.map((t) => t.text).join(" "));
  const lines = [`# ${c.title}`, "", `_${new Date(c.createdAt).toLocaleString(he ? "he-IL" : "en-GB")} · ${c.modelId || "KesherAI"}_`, ""];
  for (const t of list) {
    lines.push(`### ${who(t.role, he)}`, "");
    if (t.tools.length) lines.push(`> ${he ? "כלים" : "Tools"}: ${[...new Set(t.tools)].join(", ")}`, "");
    lines.push(t.text.trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown: code, bold, italic, links. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Markdown to HTML, enough for chat answers: headings, lists, quotes, code
 * blocks, tables as text, paragraphs.
 *
 * @param md - Markdown.
 * @returns HTML.
 */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let list: "ul" | "ol" | undefined;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p dir="auto">${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      flush();
      close();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(`<pre dir="ltr"><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)/.exec(line);
    const li = /^\s*[-*+]\s+(.*)/.exec(line);
    const oli = /^\s*\d+[.)]\s+(.*)/.exec(line);
    if (h) {
      flush();
      close();
      const n = Math.min(6, h[1]!.length + 1);
      out.push(`<h${n} dir="auto">${inline(h[2]!)}</h${n}>`);
    } else if (li || oli) {
      flush();
      const kind = li ? "ul" : "ol";
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((li ?? oli)![1]!)}</li>`);
    } else if (/^>\s?/.test(line)) {
      flush();
      close();
      out.push(`<blockquote dir="auto">${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    } else if (!line.trim()) {
      flush();
      close();
    } else {
      close();
      para.push(line);
    }
  }
  flush();
  close();
  return out.join("\n");
}

/**
 * @param c - The conversation.
 * @param print - Open the print dialog when the page loads (Save as PDF).
 * @returns A self-contained, print-ready HTML page.
 */
export function conversationHtml(c: Conversation, print = false): string {
  const list = turns(c);
  const he = rtl(list.map((t) => t.text).join(" "));
  const body = list
    .map(
      (t) => `<section class="turn ${t.role}">
<div class="who">${esc(who(t.role, he))}${t.tools.length ? ` <span class="tools">· ${esc([...new Set(t.tools)].join(", "))}</span>` : ""}</div>
${markdownToHtml(t.text)}
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="${he ? "he" : "en"}" dir="${he ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 15px/1.6 "Segoe UI", "Noto Sans Hebrew", Arial, sans-serif; color: #1b1d21; background: #fff; max-width: 760px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
  .turn { margin: 0 0 22px; break-inside: avoid-page; }
  .who { font-weight: 600; font-size: 13px; color: #4b5563; margin-bottom: 4px; }
  .tools { font-weight: 400; color: #9ca3af; }
  .turn.user { background: #f3f4f6; border-radius: 10px; padding: 10px 14px; }
  p { margin: 0 0 10px; }
  pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 13px; white-space: pre-wrap; text-align: left; }
  code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 0.92em; }
  blockquote { border-inline-start: 3px solid #d1d5db; margin: 0 0 10px; padding-inline-start: 10px; color: #4b5563; }
  a { color: #2563eb; }
  @media print { body { margin: 0 auto; } a { color: inherit; } }
</style>
</head>
<body>
<h1 dir="auto">${esc(c.title)}</h1>
<div class="meta">${esc(new Date(c.createdAt).toLocaleString(he ? "he-IL" : "en-GB"))} · ${esc(c.modelId || "KesherAI")}</div>
${body}
${print ? "<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>" : ""}
</body>
</html>
`;
}

/** A file name for the chat (its title, without characters file systems refuse). */
export function exportFileName(c: Conversation, ext: string): string {
  const base = [...c.title].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? " " : ch)).join("").replace(/\s+/g, " ").trim().slice(0, 80) || "chat";
  return `${base}.${ext}`;
}
