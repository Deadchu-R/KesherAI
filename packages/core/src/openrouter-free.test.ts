import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchFreeUsage, nextUtcMidnight } from "./openrouter-free.js";

const answer = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("fetchFreeUsage reads free_model_daily_requests (under data, or at the top); sends only the bearer key", async () => {
  let seen: { url: string; auth?: string } | undefined;
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen = { url, auth: init?.headers?.authorization };
    return new Response(JSON.stringify({ data: { free_model_daily_requests: { used: 12, limit: 50, remaining: 38 } } }));
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchFreeUsage("k", f), { used: 12, limit: 50, remaining: 38 });
  assert.equal(seen?.url, "https://openrouter.ai/api/v1/key");
  assert.equal(seen?.auth, "Bearer k");
  assert.deepEqual(await fetchFreeUsage("k", answer({ free_model_daily_requests: { used: 3, limit: 50 } })), { used: 3, limit: 50, remaining: 47 });
});

test("fetchFreeUsage: no field, an error answer or a network failure means undefined (the caller counts locally)", async () => {
  assert.equal(await fetchFreeUsage("k", answer({ data: {} })), undefined);
  assert.equal(await fetchFreeUsage("k", answer({}, 401)), undefined);
  assert.equal(await fetchFreeUsage("k", (async () => { throw new Error("offline"); }) as unknown as typeof fetch), undefined);
});

test("nextUtcMidnight is the start of the next UTC day", () => {
  assert.equal(new Date(nextUtcMidnight(Date.UTC(2026, 10, 23, 15, 30))).toISOString(), "2026-11-24T00:00:00.000Z");
});
