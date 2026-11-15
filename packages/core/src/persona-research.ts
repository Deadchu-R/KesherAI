import type { ModelTurn } from "@kesher/agent";
import type { WebPrefs } from "@kesher/shared";

/**
 * Web research for the persona builder: the model picks up to three searches
 * from the description (a real person's style, a field's terms, a game's
 * rules…), KesherAI runs them and reads the best pages, and the notes go into
 * the persona's instructions. Like LobeHub's and Character.AI's "generate from
 * a description", plus the research a person would do first.
 */

/** A page the builder read. */
export interface ResearchSource {
  title: string;
  url: string;
}

/** What the web helpers do (injected, so tests need no network). */
export interface ResearchDeps {
  search: (query: string, prefs: WebPrefs | undefined, signal: AbortSignal) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  read: (url: string, signal: AbortSignal) => Promise<string>;
}

/**
 * Reads the model's search plan: `{"queries": [...]}`; at most three short queries.
 * @param text - The model's reply.
 */
export function parseQueries(text: string): string[] {
  const m = /\{[\s\S]*\}/.exec(text.replace(/<think>[\s\S]*?<\/think>/gi, ""));
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]) as { queries?: unknown };
    return (Array.isArray(j.queries) ? j.queries : [])
      .filter((q): q is string => typeof q === "string" && !!q.trim())
      .map((q) => q.trim().slice(0, 120))
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Plans the searches, runs them and reads the top pages.
 * @param model - The model that plans the searches.
 * @param description - What the user asked for.
 * @param deps - Search and read.
 * @param prefs - The user's web filter (blocked sites, safe search).
 * @param signal - Stops it.
 * @returns Notes for the builder (data, not instructions) and the pages read.
 */
export async function researchPersona(model: ModelTurn, description: string, deps: ResearchDeps, prefs: WebPrefs | undefined, signal: AbortSignal): Promise<{ notes: string; sources: ResearchSource[] }> {
  const plan = await model(
    {
      messages: [
        {
          role: "system",
          content: `You prepare web research for writing an assistant persona. Reply with JSON only: {"queries": [up to 3 short web search queries]}. Search for facts the persona needs: a real person's or character's way of speaking and views, a field's terms and best practices, a tool's or game's rules. If nothing needs looking up, reply {"queries": []}.`,
        },
        { role: "user", content: description },
      ],
      tools: [],
    },
    signal,
    () => undefined,
  );
  const queries = parseQueries(plan.text);
  if (!queries.length) return { notes: "", sources: [] };
  const results = (await Promise.all(queries.map((q) => deps.search(q, prefs, signal).catch(() => [])))).flat();
  const seen = new Set<string>();
  const unique = results.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
  // The two best pages from different searches are read in full (each cut to 3,000 characters); the rest by snippet.
  const pages = await Promise.all(
    unique.slice(0, 2).map(async (r) => ({ r, text: await deps.read(r.url, signal).catch(() => "") })),
  );
  const read = pages.filter((p) => p.text.trim());
  const notes = [
    ...read.map((p) => `## ${p.r.title} (${p.r.url})\n${p.text.replace(/\s+/g, " ").slice(0, 3000)}`),
    ...unique.slice(2, 8).map((r) => `- ${r.title}: ${r.snippet}`),
  ].join("\n\n");
  return { notes, sources: [...read.map((p) => p.r), ...unique.slice(2, 5)].map((r) => ({ title: r.title.slice(0, 120), url: r.url })) };
}
