import type { AgentTool, ModelTurn } from "@kesher/agent";
import type { HelperPlanRef, HelperRunInfo } from "@kesher/shared";
import { HELPER_STEPS } from "./agents.js";
import { helperWork, newPlanId, type DelegateOptions, type HelperModel, type HelperResume } from "./delegate.js";

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
 * @returns The system and user messages.
 */
export function writerMessages(question: string, findings: Array<{ sub: string; text: string }>, sources: Source[]): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You write research reports from the findings of research agents. Write in the language of the question. Markdown: a # title line, a short summary (3-5 lines) first, then ## sections by theme (not by agent), with the facts, numbers and where sources disagree, and a short ## conclusion. Cite sources by their number in square brackets, like [2], right after the fact. Use only the findings given; say what is unknown. Do not write a sources list (it is added after your text).",
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

/** What {@link researchReport} needs (injected, so tests need no network or model). */
export interface ReportDeps {
  /** The research and writer model (the task inbox gives the user's free "gemini" provider). */
  model: ModelTurn;
  search: (query: string, signal: AbortSignal) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  read: (url: string, signal: AbortSignal) => Promise<string>;
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
  const ask = async (system: string, user: string) => (await deps.model({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, signal, () => undefined)).text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
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
  const findings: Array<{ sub: string; text: string }> = [];
  for (const sub of parts) {
    signal.throwIfAborted();
    const results = await deps.search(sub, signal).catch(() => []);
    const pages: string[] = [];
    for (const r of results.slice(0, 2)) {
      const text = await deps.read(r.url, signal).catch(() => "");
      if (text.trim()) pages.push(`## ${r.title}\n${text.replace(/\s+/g, " ").slice(0, 6000)}`);
    }
    const list = results.slice(0, 8).map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet}`);
    findings.push({ sub, text: `${pages.join("\n\n")}\n\nSources:\n${list.join("\n")}` });
  }
  const sources = collectSources(findings.map((f) => f.text));
  const [system, user] = writerMessages(question, findings, sources);
  const body = await ask(system!.content, user!.content);
  if (!body) throw new Error("The model wrote no report.");
  return assembleReport(body, sources, isHebrew(question));
}
