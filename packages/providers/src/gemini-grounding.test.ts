import { test } from "node:test";
import assert from "node:assert/strict";
import { groundingBody, groundingError, parseGrounding } from "./gemini-grounding.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** A trimmed real-shape answer of `generateContent` with Google Search grounding. */
const ANSWER = JSON.stringify({
  candidates: [
    {
      content: { parts: [{ text: "Obsidian syncs end to end encrypted. Notion syncs through its servers." }] },
      groundingMetadata: {
        webSearchQueries: ["how obsidian notion sync"],
        searchEntryPoint: { renderedContent: "<div>…</div>" },
        groundingChunks: [
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title: "obsidian.md" } },
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", title: "notion.com" } },
          { web: { uri: "http://insecure.example/x", title: "skipped" } },
          { retrievedContext: { uri: "gs://x" } },
        ],
        groundingSupports: [
          { segment: { text: "Obsidian syncs end to end encrypted." }, groundingChunkIndices: [0] },
          { segment: { text: "Notion syncs through its servers." }, groundingChunkIndices: [1, 0] },
        ],
      },
    },
  ],
});

test("parseGrounding reads the found pages with the sentences that cite them; nothing from junk", () => {
  assert.deepEqual(parseGrounding(ANSWER), [
    { title: "obsidian.md", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", snippet: "Obsidian syncs end to end encrypted. Notion syncs through its servers." },
    { title: "notion.com", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", snippet: "Notion syncs through its servers." },
  ]);
  assert.deepEqual([parseGrounding("not json"), parseGrounding("{}"), parseGrounding('{"candidates":[{}]}')], [[], [], []]);
  assert.deepEqual((groundingBody("q") as { tools: unknown }).tools, [{ google_search: {} }]);
});

test("groundingError: the free limit, billing and a refused key get plain reasons, without addresses", () => {
  assert.match(groundingError(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}'), /free limit is used up \(429\)/);
  assert.match(groundingError(400, '{"error":{"message":"Google Search grounding requires billing to be enabled","status":"FAILED_PRECONDITION"}}'), /needs billing/);
  assert.match(groundingError(403, "{}"), /key was refused \(403\)/);
  assert.equal(groundingError(500, "x"), "Gemini search answered 500.");
});

test("webSearch exists only on a Gemini API connection with a key; it sends the key in its header and unwraps redirects", async () => {
  const other = new OpenAICompatibleProvider({ id: "groq", type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" });
  const keyless = new OpenAICompatibleProvider({ id: "gemini", type: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });
  assert.equal(other.webSearch, undefined);
  assert.equal(keyless.webSearch, undefined);
  const gem = new OpenAICompatibleProvider({ id: "gemini", type: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "test-key" });
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method} ${url} ${(init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"] ?? ""}`);
    if (init?.method === "HEAD") return new Response(null, { status: 302, headers: { location: String(url).endsWith("AAA") ? "https://obsidian.md/sync" : "https://www.notion.com/help" } });
    return new Response(ANSWER, { status: 200 });
  }) as typeof fetch;
  try {
    const hits = await gem.webSearch!("q", new AbortController().signal);
    assert.deepEqual(hits.map((h) => h.url), ["https://obsidian.md/sync", "https://www.notion.com/help"]);
    assert.equal(seen[0], "POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent test-key");
    // A limit answer stops at once (no second model, no retry against the quota).
    seen.length = 0;
    globalThis.fetch = (async (url: string) => (seen.push(String(url)), new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 }))) as typeof fetch;
    await assert.rejects(gem.webSearch!("q"), /free limit/);
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});
