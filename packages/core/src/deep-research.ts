import type { AgentTool, ModelTurn } from "@kesher/agent";
import type { HelperPlanRef, HelperRunInfo } from "@kesher/shared";
import { HELPER_STEPS } from "./agents.js";
import { helperWork, newPlanId, type DelegateOptions, type HelperModel, type HelperResume } from "./delegate.js";
import { failuresOf, NO_SEARCH_START } from "./research-search.js";

/**
 * Deep research in the chat (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", A16; like Gemini's and
 * ChatGPT's Deep Research and Claude's Research): the lead splits a question into a few sub-questions, research
 * sub-agents look into them at the same time (the web, and pages in the browser), and the lead's model writes one
 * report from their findings, with headings and a numbered Sources list with links. The report is a document of the
 * chat (docs.ts), so it opens in the side panel beside the chat with its versions; the progress shows on the chat's
 * Plan card (the plan's `research` kind, its stage, and the report when done).
 *
 * Caps: at most RESEARCH_PARTS sub-agents and RESEARCH_MINUTES for the whole research; what is found by then is
 * written up. The sub-agents run on the research role's model (Settings > Agents), the report on the chat's model.
 */

/** The most sub-questions (research sub-agents) one deep research runs. */
export const RESEARCH_PARTS = 5;
/** The whole research stops after this long, and the report is written from what was found. */
export const RESEARCH_MINUTES = 15;
/** The most sources listed in one report. */
const MAX_SOURCES = 40;
/** The findings handed to the writer, per sub-agent (about 2,000 tokens). */
const FINDING_CHARS = 8000;

/** One source a sub-agent used. */
export interface Source {
  /** Its number in the report ([1], [2]…). */
  n: number;
  url: string;
  title: string;
}

/** @returns Whether the text is mostly meant for a Hebrew reader (it has Hebrew letters). */
export const isHebrew = (text: string): boolean => /[֐-׿]/.test(text);

/**
 * The task of one research sub-agent.
 *
 * @param question - The whole question (for context).
 * @param sub - Its own sub-question.
 * @returns The instruction it gets.
 */
export function researchTask(question: string, sub: string): string {
  return [
    `Research this sub-question: ${sub}`,
    `(It is part of a bigger question: ${question})`,
    "Search the web (web_search) and read the best 2 to 4 sources in full (web_fetch, or browser_read for a page that needs a browser). Prefer primary and recent sources; note dates.",
    "Report: the findings as short bullet points with exact facts, numbers and quotes; say where sources disagree.",
    "End with a line \"Sources:\" and one line per source you used: \"- Title — https://full.url\". Only pages you actually read.",
  ].join("\n");
}

/** A URL's form for comparing (no fragment, no trailing slash or punctuation). */
function urlKey(url: string): string {
  return url.replace(/#.*$/, "").replace(/[/.,;:)]+$/, "").toLowerCase();
}

/**
 * The sources in the sub-agents' reports, numbered in order of first mention, without repeats: Markdown links,
 * "Title — URL" lines and bare links.
 *
 * @param texts - The reports.
 * @returns At most MAX_SOURCES sources (http and https only).
 */
export function collectSources(texts: string[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string) => {
    const clean = url.replace(/[)\].,;:'"»]+$/, "");
    if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(clean) || out.length >= MAX_SOURCES) return;
    const key = urlKey(clean);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ n: out.length + 1, url: clean, title: title.replace(/\s+/g, " ").trim().slice(0, 160) || new URL(clean).hostname });
  };
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const md = [...line.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)];
      for (const m of md) add(m[2]!, m[1]!);
      const rest = line.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g, "");
      for (const m of rest.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
        // "- Title — URL": the words before the dash are its title; a link inside a sentence gets its site's name.
        const head = rest.slice(0, m.index);
        const titled = /\s[—–:-]\s*$/.test(head) && !/https?:\/\//.test(head);
        add(m[0], titled ? head.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\s*[—–:-]\s*$/, "").replace(/^sources?:\s*/i, "") : "");
      }
    }
  }
  return out;
}

/**
 * The finished report: the writer's text without a sources section of its own, then the numbered Sources list.
 *
 * @param body - The writer's Markdown.
 * @param sources - The numbered sources.
 * @param he - Hebrew headings.
 * @returns The document's body.
 */
export function assembleReport(body: string, sources: Source[], he: boolean): string {
  // The list is built here from the links the sub-agents read, so a writer's own (maybe made-up) list is dropped.
  const own = /^#{1,6}\s*(sources|references|מקורות)\s*$/im.exec(body);
  const text = (own ? body.slice(0, own.index) : body).trim();
  if (!sources.length) return text;
  const list = sources.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, "")}](${s.url})`).join("\n");
  return `${text}\n\n## ${he ? "מקורות" : "Sources"}\n\n${list}`;
}

/**
 * What the lead's model reads to write the report.
 *
 * @param question - The question.
 * @param findings - Each sub-question and its sub-agent's report (or why it has none).
 * @param sources - The numbered sources.
 * @param want - The length and sections the question asks for ({@link reportWants}).
 * @returns The system and user messages.
 */
export function writerMessages(question: string, findings: Array<{ sub: string; text: string }>, sources: Source[], want: ReportWants = {}): Array<{ role: "system" | "user"; content: string }> {
  const extra = [
    want.words ? ` Keep it to about ${want.words} words, and finish every section: never stop in the middle of a sentence or leave a heading empty.` : " Finish every section: never stop in the middle of a sentence or leave a heading empty.",
    want.tasks ? " The question asks for tasks: after the conclusion write a `## Tasks` section (every finding the project should act on, as tasks: for each an id like T1, a title, what to build in 2-5 lines, size S/M/L); write `no tasks` with the reason only if nothing applies. Always write it, in English headings." : "",
  ].join("");
  return [
    {
      role: "system",
      content:
        "You write research reports from the findings of research agents. Write in the language of the question. Markdown: a # title line, a short summary (3-5 lines) first, then ## sections by theme (not by agent), with the facts, numbers and where sources disagree, and a short ## conclusion. Cite sources by their number in square brackets, like [2], right after the fact. Use only the findings given; say what is unknown. Cite only the numbered sources you were given, and never invent a source or write placeholders such as [Findings N]. Do not write a sources list (it is added after your text)." + extra,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nSources (cite by number):\n${sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n") || "(none)"}\n\n${findings.map((f, i) => `### Findings ${i + 1}: ${f.sub}\n${f.text.slice(0, FINDING_CHARS)}`).join("\n\n")}`,
    },
  ];
}

/** @returns The report's title: its first `# ` line, else the question. */
export function reportTitle(body: string, question: string): string {
  const h = /^#\s+(.+)$/m.exec(body);
  return (h?.[1] ?? question).replace(/[*_`]/g, "").trim().slice(0, 160);
}

/**
 * The lead's `deep_research` tool.
 *
 * @param o - The chat's side, as for delegate (its runs and chat id are needed; `report` saves the document).
 * @returns The tool.
 */
export function deepResearchTool(o: DelegateOptions): AgentTool {
  return {
    risk: "safe",
    spec: {
      name: "deep_research",
      description: `Deep research: research sub-agents look into 2 to ${RESEARCH_PARTS} sub-questions at the same time (the web and pages in the browser), then a report with headings, findings and a numbered Sources list with links is written as a document the user sees beside the chat. Use it when the user asks to research a topic deeply, compare options from many sources, or picks "Research deeply". Plan the sub-questions yourself: each one separate and specific, together covering the question. Takes a few minutes (up to ${RESEARCH_MINUTES}). Afterwards tell the user in 2-3 lines what it found; do not repeat the report.`,
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The whole question, in the user's language." },
          parts: { type: "array", maxItems: RESEARCH_PARTS, items: { type: "string" }, description: `2 to ${RESEARCH_PARTS} sub-questions, each complete on its own.` },
        },
        required: ["question", "parts"],
      },
    },
    run: async (input, ctx) => {
      const runs = o.runs;
      const chatId = o.chatId;
      if (!runs || !chatId) throw new Error("Deep research runs only in a chat.");
      const question = typeof input.question === "string" ? input.question.replace(/\s+/g, " ").trim().slice(0, 600) : "";
      if (!question) throw new Error("Give the question.");
      const subs = [...new Set((Array.isArray(input.parts) ? input.parts : []).filter((p): p is string => typeof p === "string").map((p) => p.replace(/\s+/g, " ").trim().slice(0, 400)).filter(Boolean))].slice(0, RESEARCH_PARTS);
      if (!subs.length) subs.push(question);
      const lead = o.currentModel();
      const limits = o.limits?.() ?? {};
      const minutes = Math.min(limits.minutes ?? 10, RESEARCH_MINUTES);
      const maxSteps = limits.steps?.research ?? HELPER_STEPS.research;
      const plan: HelperPlanRef = { id: newPlanId(), kind: "research", goal: question, phase: "researching" };
      const ids: string[] = [];
      for (const sub of subs) {
        // The research role's model from Settings (the user's choice), else the chat's.
        const m: HelperModel | undefined = o.modelFor ? await o.modelFor({ kind: "research" }) : lead ? { modelId: lead, label: lead.split("/").pop() ?? lead, local: false } : undefined;
        if (!m) throw new Error("No model to research with.");
        const task = researchTask(question, sub);
        const info = runs.start({
          chatId,
          kind: "research",
          title: sub.slice(0, 120),
          ...(ctx.callId ? { callId: ctx.callId } : {}),
          background: false,
          maxSteps,
          timeMs: minutes * 60_000,
          local: m.local,
          model: m.label,
          ...(m.note ? { modelNote: m.note } : {}),
          ...(m.noteHe ? { modelNoteHe: m.noteHe } : {}),
          ...(m.cloud ? { cloud: true } : {}),
          plan,
          resume: { task, kind: "research", maxSteps, write: false } satisfies HelperResume,
          run: helperWork(o, { task, title: sub.slice(0, 120), kind: "research", model: m, maxSteps, write: false }, (text) => ctx.progress?.(text)),
        });
        ids.push(info.id);
      }
      // The chat's Stop stops the research; the whole research's time cap stops what still runs (queued ones too).
      const stopAll = () => ids.forEach((id) => runs.stop(id));
      ctx.signal.addEventListener("abort", stopAll, { once: true });
      const cap = setTimeout(stopAll, RESEARCH_MINUTES * 60_000);
      try {
        await runs.wait(ids);
      } finally {
        clearTimeout(cap);
        ctx.signal.removeEventListener("abort", stopAll);
      }
      if (ctx.signal.aborted) {
        runs.revisePlan(chatId, plan.id, { phase: "failed" });
        throw new Error("Stopped.");
      }
      const ended = ids.map((id) => runs.get(id)).filter((r): r is HelperRunInfo & { chatId: string; full?: string } => !!r);
      const found = ended.filter((r) => r.state === "done" && (r.full ?? r.report)?.trim());
      if (!found.length) {
        runs.revisePlan(chatId, plan.id, { phase: "failed" });
        return { output: `No sub-agent found anything (${ended.map((r) => `${r.title}: ${r.error ?? r.state}`).join("; ")}). Tell the user, and offer to try again or narrow the question.` };
      }
      const findings = ended.map((r) => ({ sub: r.title, text: r.state === "done" ? (r.full ?? r.report ?? "") : `(no findings: ${r.error ?? r.state})` }));
      const sources = collectSources(found.map((r) => r.full ?? r.report ?? ""));
      runs.revisePlan(chatId, plan.id, { phase: "writing" });
      ctx.progress?.("Writing the report…\n");
      let body: string;
      try {
        if (!lead) throw new Error("No model to write the report.");
        const r = await o.turnFor(lead)({ messages: writerMessages(question, findings, sources), tools: [] }, ctx.signal, () => undefined);
        body = r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
        if (!body) throw new Error("The model wrote no report.");
      } catch (err) {
        runs.revisePlan(chatId, plan.id, { phase: "failed" });
        throw err;
      }
      const he = isHebrew(question);
      const title = reportTitle(body, question);
      const text = assembleReport(body, sources, he);
      const doc = await o.report?.(title, text).catch(() => undefined);
      runs.revisePlan(chatId, plan.id, { phase: "done", ...(doc ? { doc: { id: doc.id, title, ver: doc.ver } } : {}) });
      const tally = `${found.length} of ${ended.length} sub-agents, ${sources.length} sources`;
      // "Saved … #/docs/<id>": the chat shows the document's card and opens it beside the chat (doc-items.ts).
      if (doc) return { output: `Saved v${doc.ver} (${text.split(/\s+/).filter(Boolean).length} words). The user sees it at #/docs/${doc.id}.\n(${tally}.) The report, for your short answer (do not repeat it):\n\n${body.slice(0, 1500)}` };
      return { output: `(${tally}; this chat keeps no documents, so give the user the report below as your answer.)\n\n${text}` };
    },
  };
}

/** What a question asks of its report: a word limit and a `## Tasks` section. */
export interface ReportWants {
  /** The most words asked for ("up to 1,500 words"). */
  words?: number;
  /** A `## Tasks` section is required. */
  tasks?: boolean;
}

/** Marks a report that stayed incomplete after the extra passes; the task inbox removes it and notes a warning. */
export const REPORT_INCOMPLETE = "<!-- kesher:report-incomplete -->";

/** The default length the writer aims at when the question gives none, in words. */
const DEFAULT_WORDS = 1200;

/** Extra writer passes after the first one (a continuation or the missing Tasks section). */
const EXTRA_PASSES = 2;

/**
 * What the question asks for: a length ("up to 1,500 words") and a `## Tasks` section.
 *
 * @param question - The task's text (title, goal, acceptance).
 */
export function reportWants(question: string): ReportWants {
  const w = /(\d[\d,.]{2,6})\s*(?:words|מילים)/i.exec(question)?.[1]?.replace(/[,.]/g, "");
  const words = w ? Number(w) : 0;
  return { ...(words >= 100 && words <= 8000 ? { words } : {}), ...(/##\s*Tasks\b/i.test(question) ? { tasks: true } : {}) };
}

/**
 * The output budget for the writer: the report's tokens (about 1.4 per English word, 3 per Hebrew word, with a margin)
 * plus room for a thinking model's thoughts, which count against the same limit.
 *
 * @param words - The words aimed at.
 * @param he - A Hebrew question.
 */
export function writerBudget(words: number, he: boolean): number {
  return Math.min(24_000, Math.max(6000, Math.ceil(words * (he ? 3.5 : 2)) + 3500));
}

/** Words a sentence cannot end on: a last line that ends with one was cut off. */
const DANGLING = /\b(to|the|a|an|and|or|of|in|on|for|with|by|as|is|are|that|from|at|into|using)$/i;

/**
 * Whether a report's last line stops in the middle of a sentence (ends with a comma, colon, dash, an open bracket or a
 * word no sentence ends on).
 *
 * @param body - The report's Markdown.
 */
export function endsCut(body: string): boolean {
  const last = body.trimEnd().split(/\r?\n/).pop()?.trim() ?? "";
  if (!last || /^#{1,6}\s/.test(last)) return false;
  return /[,;:([\-–—]$/.test(last) || DANGLING.test(last);
}

/**
 * The `##` headings that have no text under them (the writer gave a title and stopped).
 *
 * @param body - The report's Markdown.
 */
export function emptySections(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!/^##\s+\S/.test(l.trim())) return;
    const next = lines.slice(i + 1).find((x) => x.trim());
    if (!next || /^#{1,6}\s/.test(next.trim())) out.push(l.replace(/^#+\s*/, "").trim());
  });
  return out;
}

/** What {@link researchReport} needs (injected, so tests need no network or model). */
export interface ReportDeps {
  /** The research and writer model (the task inbox gives the user's free "gemini" provider). */
  model: ModelTurn;
  search: (query: string, signal: AbortSignal) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  read: (url: string, signal: AbortSignal) => Promise<string>;
}

export { NO_SEARCH_START };
/** The note of a task whose searches returned nothing (no report is written then), when no reason is known. */
export const NO_SEARCH_NOTE = `${NO_SEARCH_START}; no report written`;

/**
 * One search failure's reason, safe to show and log: an address becomes its host, a key or token value is dropped.
 *
 * @param x - The "backend: why" line.
 */
export function cleanReason(x: string): string {
  return x
    .replace(/https?:\/\/([^/\s?#]+)\S*/g, "$1")
    .replace(/\b(key|token|api[_-]?key|access_token|auth)=\S+/gi, "$1=…")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The short "why" of a research that found nothing: each backend's reason, without addresses (a host stays), keys or
 * tokens, at most 70 characters each and 260 in all.
 *
 * @param failures - The "backend: why" lines, one per backend (the first one of each backend is kept).
 * @returns `Web search returned nothing (duckduckgo: …; bing: …); no report written`, or {@link NO_SEARCH_NOTE}.
 */
export function noSearchNote(failures: readonly string[]): string {
  const parts = failures.map(cleanReason).filter(Boolean).map((x) => (x.length > 70 ? `${x.slice(0, 69)}…` : x));
  if (!parts.length) return NO_SEARCH_NOTE;
  let why = parts.join("; ");
  if (why.length > 260) why = `${why.slice(0, 259)}…`;
  return `${NO_SEARCH_START} (${why}); no report written`;
}

/** The most sub-questions of the small, automatic research (a chat's deep research has {@link RESEARCH_PARTS}). */
const SMALL_PARTS = 3;

/**
 * Small research without a chat, for the task inbox's free-Gemini route: the model splits the question into at most
 * three sub-questions, each is searched and its best two pages read (one after the other, to stay inside a free
 * key's rate limit), and the same model writes one report with a numbered Sources list. Errors of the model (a quota
 * or rate limit) are thrown as they are: the caller decides, and never retries in a loop.
 *
 * @param question - The task's question.
 * @param deps - The model, search and page reading.
 * @param signal - Stops it.
 * @returns The report's Markdown.
 */
export async function researchReport(question: string, deps: ReportDeps, signal: AbortSignal): Promise<string> {
  const run = async (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, maxTokens: number) => {
    const r = await deps.model({ messages, tools: [], maxTokens }, signal, () => undefined);
    return { text: r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim(), cut: !!r.truncated };
  };
  const ask = async (system: string, user: string) => (await run([{ role: "system", content: system }, { role: "user", content: user }], 1024)).text;
  const planned = await ask(`Split the research question into at most ${SMALL_PARTS} separate, specific web-search queries. Reply with JSON only: {"parts": ["...", "..."]}.`, question);
  let parts: string[] = [];
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(planned)?.[0] ?? "{}") as { parts?: unknown };
    parts = (Array.isArray(j.parts) ? j.parts : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.replace(/\s+/g, " ").trim().slice(0, 200));
  } catch {
    /* not JSON: the whole question is searched */
  }
  parts = [...new Set(parts)].slice(0, SMALL_PARTS);
  if (!parts.length) parts = [question.replace(/\s+/g, " ").trim().slice(0, 200)];
  const findings: Array<{ sub: string; text: string; read: boolean }> = [];
  // Why searches failed, one line per backend (the first reason of each), logged once per run (KesherAI's main log).
  const failed = new Map<string, string>();
  const noteFailures = (e: unknown) => {
    for (const line of failuresOf(e)) {
      const name = /^([\w.-]+):/.exec(line)?.[1] ?? "search";
      if (failed.has(name)) continue;
      failed.set(name, line);
      console.info(`[research] search failed: ${cleanReason(line).slice(0, 300)}`);
    }
  };
  for (const sub of parts) {
    signal.throwIfAborted();
    const results = await deps.search(sub, signal).catch((e: unknown) => (noteFailures(e), []));
    const pages: string[] = [];
    for (const r of results.slice(0, 2)) {
      const text = await deps.read(r.url, signal).catch(() => "");
      if (text.trim()) pages.push(`## ${r.title}\n${text.replace(/\s+/g, " ").slice(0, 6000)}`);
    }
    const list = results.slice(0, 8).map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet}`);
    findings.push({ sub, read: pages.length > 0, text: `${pages.join("\n\n")}\n\nSources:\n${list.join("\n")}` });
  }
  const sources = collectSources(findings.map((f) => f.text));
  // Nothing usable (no page read, no result): a report would be made up, so there is none.
  if (!sources.length || !findings.some((f) => f.read)) {
    if (sources.length) failed.set("pages", "pages: None of the results could be read.");
    throw new Error(noSearchNote([...failed.values()]));
  }
  const he = isHebrew(question);
  const want = reportWants(question);
  const budget = writerBudget(want.words ?? DEFAULT_WORDS, he);
  const base = writerMessages(question, findings, sources, { ...want, words: want.words ?? DEFAULT_WORDS });
  const first = await run(base, budget);
  if (!first.text) throw new Error("The model wrote no report.");
  let body = first.text;
  let cut = first.cut;
  let flaw = "";
  // A report that stops (token limit or a cut sentence), lacks the Tasks the question asks for, or has empty sections gets
  // up to EXTRA_PASSES more asks; what is still wrong after that is marked, never passed off as complete.
  for (let pass = 0; ; pass++) {
    const empty = emptySections(body);
    const stopped = cut || endsCut(body);
    const noTasks = !!want.tasks && !/^##\s*Tasks\b/im.test(body);
    flaw = stopped ? "it stops in the middle" : noTasks ? "no Tasks section" : empty.length ? `empty sections (${empty.slice(0, 3).join(", ")})` : "";
    if (!flaw || pass >= EXTRA_PASSES) break;
    const ask2 = stopped
      ? "Your report stopped before the end. Continue exactly from where it stopped (finish the sentence, no repeating, no new title), complete the remaining sections" + (want.tasks ? " and end with the `## Tasks` section." : ".")
      : noTasks
        ? "The report has no `## Tasks` section. Write only that section now, starting with the line `## Tasks`."
        : `These sections are empty: ${empty.join(", ")}. Write only those sections, each starting with its \`##\` heading and filled with the facts from the findings.`;
    const more = await run([...base, { role: "assistant", content: body }, { role: "user", content: ask2 }], budget);
    if (!more.text) break;
    if (stopped) {
      // Continues the cut text: a new line, or a space where the cut left a finished word.
      body += /^\s/.test(more.text) || /\s$/.test(body) || /^[.,;:!?)]/.test(more.text) ? more.text : /[\w.,;:!?)\]]$/.test(body) && /^[\w([`*]/.test(more.text) ? ` ${more.text}` : more.text;
    } else if (!noTasks && empty.length) {
      // The empty headings are dropped; the new text brings them back with their text.
      body = `${body.split(/\r?\n/).filter((l) => !empty.includes(l.replace(/^#+\s*/, "").trim()) || !/^##\s/.test(l.trim())).join("\n").trim()}\n\n${more.text}`;
    } else body = `${body}\n\n${more.text}`;
    cut = more.cut;
  }
  const report = assembleReport(body, sources, he);
  return flaw ? `${report}\n\n${REPORT_INCOMPLETE} ${flaw}` : report;
}
