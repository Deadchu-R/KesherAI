import type { AgentEvent } from "@kesher/shared";

/** One source of an answer: a page the model read, or a result it only saw in a web search. */
export interface AnswerSource {
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  /** Read (web_fetch, opened in the browser) rather than only found in search results. */
  read: boolean;
}

/** An answer's sources and the searches it ran. */
export interface AnswerSources {
  sources: AnswerSource[];
  queries: string[];
}

type Ev = AgentEvent & { seq: number };

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** web_search's output: "1. Title\n   https://…\n   snippet". */
export function parseSearchOutput(out: string): Array<{ title: string; url: string; snippet: string }> {
  const items: Array<{ title: string; url: string; snippet: string }> = [];
  for (const block of out.split(/\n(?=\d+\.\s)/)) {
    const lines = block.split("\n").map((l) => l.trim());
    const title = lines[0]?.replace(/^\d+\.\s*/, "") ?? "";
    const url = lines[1] ?? "";
    if (/^https?:\/\//.test(url)) items.push({ title, url, snippet: lines.slice(2).join(" ") });
  }
  return items;
}

/**
 * The sources of each answer, by the seq of the last assistant message of its turn (the one that shows the
 * Sources button): pages read first, then search results; the same address once.
 */
export function answerSources(events: Ev[]): Map<number, AnswerSources> {
  const out = new Map<number, AnswerSources>();
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  let found = new Map<string, AnswerSource>();
  let queries: string[] = [];
  let lastAssistant = -1;
  const flush = () => {
    if (lastAssistant >= 0 && found.size) {
      const list = [...found.values()].sort((a, b) => Number(b.read) - Number(a.read));
      out.set(lastAssistant, { sources: list, queries });
    }
    found = new Map();
    queries = [];
    lastAssistant = -1;
  };
  const add = (s: AnswerSource) => {
    const key = s.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    const was = found.get(key);
    found.set(key, was ? { ...was, read: was.read || s.read, title: was.title || s.title, snippet: was.snippet ?? s.snippet } : s);
  };
  for (const e of events) {
    if (e.type === "user") flush();
    else if (e.type === "tool_call") calls.set(e.callId, { name: e.name, input: e.input });
    else if (e.type === "tool_result" && e.ok) {
      const call = calls.get(e.callId);
      if (e.name === "web_search") {
        if (typeof call?.input.query === "string") queries.push(call.input.query);
        for (const r of parseSearchOutput(e.output)) add({ url: r.url, title: r.title, domain: domainOf(r.url), snippet: r.snippet, read: false });
      } else if (e.name === "web_fetch") {
        const url = e.output.split("\n")[0]?.trim() || String(call?.input.url ?? "");
        if (/^https?:\/\//.test(url)) add({ url, title: "", domain: domainOf(url), read: true });
      } else if (e.name === "browser_open" || e.name === "browser_read") {
        // The browser's page text starts with its title and address.
        const [title = "", url = ""] = e.output.split("\n");
        if (/^https?:\/\//.test(url.trim())) add({ url: url.trim(), title: title.trim(), domain: domainOf(url.trim()), read: true });
      }
    } else if (e.type === "assistant") lastAssistant = e.seq;
  }
  flush();
  return out;
}
