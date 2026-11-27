import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUNDED_COOLDOWN_MS, GROUNDED_DAILY_CAP, ResearchSearchError, failuresOf, researchSearch } from "./research-search.js";

const sig = new AbortController().signal;
const HIT = { title: "A", url: "https://a.example/x", snippet: "s" };
const webFails = async () => {
  throw Object.assign(new Error("Web search failed on every backend."), { failures: ["duckduckgo: Search answered 202 (a bot check or rate limit).", "bing: Irrelevant results (0 of 9 match the query), likely a bot page."] });
};

test("researchSearch: the web first; grounding only when every backend failed, with the query through the leak guard", async () => {
  const grounded: string[] = [];
  const toWeb: string[] = [];
  let web = async () => [HIT];
  const search = researchSearch({ web: (q) => (toWeb.push(q), web()), grounded: () => async (q) => (grounded.push(q), [HIT]), redact: (q) => q.replace("secret", "[hidden]") });
  assert.deepEqual(await search("q", sig), [HIT]);
  assert.equal(grounded.length, 0);
  web = webFails as typeof web;
  assert.deepEqual(await search("about secret", sig), [HIT]);
  assert.deepEqual(grounded, ["about [hidden]"]);
  // The web search gets the guarded query too (scan 2026-11-27).
  assert.deepEqual(toWeb, ["q", "about [hidden]"]);
});

test("researchSearch: every reason is kept; no grounding without a Gemini key", async () => {
  const search = researchSearch({ web: webFails, grounded: () => undefined });
  const e = await search("q", sig).catch((x: unknown) => x);
  assert.ok(e instanceof ResearchSearchError);
  assert.deepEqual(failuresOf(e).map((l) => l.split(":")[0]), ["duckduckgo", "bing"]);
  assert.deepEqual(failuresOf(new Error("plain")), ["plain"]);
});

test("researchSearch: a grounding limit answer rests it for an hour, and the daily cap holds", async () => {
  let now = Date.UTC(2026, 10, 27, 12);
  let calls = 0;
  let fail = true;
  const search = researchSearch({ web: webFails, now: () => now, grounded: () => async () => (calls++, fail ? Promise.reject(new Error("Gemini search: the free limit is used up (429).")) : [HIT]) });
  let e = await search("q", sig).catch((x: unknown) => x);
  assert.match(failuresOf(e).at(-1)!, /^gemini-search: the free limit is used up \(429\)/);
  e = await search("q", sig).catch((x: unknown) => x);
  assert.match(failuresOf(e).at(-1)!, /^gemini-search: Resting after a limit answer/);
  assert.equal(calls, 1, "no request while resting");
  now += GROUNDED_COOLDOWN_MS + 1;
  fail = false;
  for (let i = 1; i < GROUNDED_DAILY_CAP; i++) await search("q", sig);
  e = await search("q", sig).catch((x: unknown) => x);
  assert.match(failuresOf(e).at(-1)!, /Today's 60 searches are used/);
  assert.equal(calls, GROUNDED_DAILY_CAP);
  now += 24 * 60 * 60_000;
  assert.deepEqual(await search("q", sig), [HIT], "a new UTC day");
});
