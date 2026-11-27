/**
 * Google Search grounding on the Gemini API (ai.google.dev/gemini-api/docs/google-search): one `generateContent`
 * request with `tools: [{ google_search: {} }]`, whose `groundingMetadata` lists the web pages Google found. KesherAI
 * uses it only as research's last search backend, on the user's free AI Studio key, when every web search engine
 * failed. The request goes to the native API (the OpenAI-compatible endpoint returns no grounding metadata).
 *
 * Only the pages are used (`groundingChunks[].web` uri and title, with the answer's sentences that cite each one as
 * its snippet); the model's own answer and `searchEntryPoint` are not.
 */

/** One page Google Search found. */
export interface GroundedHit {
  title: string;
  url: string;
  snippet: string;
}

/** The models tried, in order (aliases Google keeps on the newest Flash; both have grounding on the free tier). */
export const GROUNDING_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"] as const;

/** The host of Google's grounding redirect links (each page's address is behind one). */
export const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

/**
 * The request body for one search.
 *
 * @param query - The search query (research's sub-question, already safe to send).
 * @returns The JSON body.
 */
export function groundingBody(query: string): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: `Search the web with Google Search for: ${query}\nAnswer in 3-5 short sentences, citing the pages you found.` }] }],
    tools: [{ google_search: {} }],
    // A short answer: only the found pages are used, so the free quota's tokens are not spent on text.
    generationConfig: { maxOutputTokens: 512, temperature: 0 },
  };
}

/** The parts of a `generateContent` answer that grounding uses. */
interface GroundingAnswer {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      groundingSupports?: Array<{ segment?: { text?: string }; groundingChunkIndices?: number[] }>;
    };
  }>;
}

/**
 * Reads the found pages out of a `generateContent` answer.
 *
 * @param json - The answer's body (text).
 * @returns The pages, in Google's order, each with the answer's sentences that cite it as the snippet (at most 300
 *   characters); empty when the model did not search or the body is not JSON.
 */
export function parseGrounding(json: string): GroundedHit[] {
  let a: GroundingAnswer;
  try {
    a = JSON.parse(json) as GroundingAnswer;
  } catch {
    return [];
  }
  const meta = a.candidates?.[0]?.groundingMetadata;
  const chunks = meta?.groundingChunks ?? [];
  const cites = chunks.map(() => [] as string[]);
  for (const s of meta?.groundingSupports ?? []) {
    const text = s.segment?.text?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const i of s.groundingChunkIndices ?? []) if (cites[i] && !cites[i].includes(text)) cites[i].push(text);
  }
  const out: GroundedHit[] = [];
  chunks.forEach((c, i) => {
    const url = c.web?.uri?.trim() ?? "";
    if (!/^https:\/\//i.test(url) || out.some((h) => h.url === url)) return;
    out.push({ title: (c.web?.title ?? "").trim() || new URL(url).hostname, url, snippet: cites[i]!.join(" ").slice(0, 300) });
  });
  return out;
}

/**
 * A plain reason for a failed grounding request, without addresses or the key: the free limit (429), a key or model
 * that needs billing for grounding, or the status.
 *
 * @param status - The HTTP status.
 * @param body - The error body (Google's JSON error).
 * @returns The reason.
 */
export function groundingError(status: number, body: string): string {
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(body)) return "Gemini search: the free limit is used up (429).";
  if (/billing|FAILED_PRECONDITION|free tier|paid plan|upgrade/i.test(body)) return "Gemini search: Google search grounding needs billing on this key, which KesherAI never turns on.";
  if (status === 401 || status === 403) return `Gemini search: the key was refused (${status}).`;
  return `Gemini search answered ${status}.`;
}
