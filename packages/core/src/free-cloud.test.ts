import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig, ProviderRegistry } from "@kesher/providers";
import { FreeCloudPool, FreeCloudUnavailable, CircuitBreaker, RateLimiter, FreeOnlyProvider, parseDuration, redact, retryAfterMs, type FreeCloudSettings } from "./free-cloud.js";
import { freeBaseUrl, paidModelReason, parseModelList } from "./free-cloud-catalog.js";

const KEY = "gsk_SecretSecretSecret1234567890";

/** A registry of fake providers: `calls` records who was asked; `fail` makes one answer with an HTTP error. */
function setup(over: Partial<FreeCloudSettings> = {}) {
  let now = Date.UTC(2026, 10, 22, 10, 0, 0);
  const calls: string[] = [];
  const fail: Record<string, { status: number; headers?: Record<string, string>; message?: string } | undefined> = {};
  const ids = ["fc-groq", "fc-openrouter", "fc-mistral"];
  const configs: ProviderConfig[] = ids.map((id) => ({ id, type: "free-cloud", apiKey: id === "fc-groq" ? KEY : `key-${id}-abcdefgh`, baseUrl: "https://x" }));
  const provider = (id: string) => ({
    id,
    async chatWithTools() {
      calls.push(id);
      const f = fail[id];
      if (f) throw Object.assign(new Error(f.message ?? `POST https://x → ${f.status} err: ${KEY}`), { status: f.status, rateHeaders: f.headers ?? {} });
      return { text: `from ${id}`, toolCalls: [] };
    },
  });
  const registry = { list: () => configs.map((config) => ({ config, provider: provider(config.id) })), get: (id: string) => (ids.includes(id) ? provider(id) : undefined) } as unknown as ProviderRegistry;
  const settings: FreeCloudSettings = { order: ["fc-groq", "fc-openrouter", "fc-mistral"], disabled: [], chatFallback: false, backgroundFallback: true, models: {}, ...over };
  const pool = new FreeCloudPool({ registry, settings: () => settings, now: () => now });
  const ask = () => pool.run("background", async (id) => (await registry.get(id)!.chatWithTools!({ providerModelId: "m", messages: [], tools: [] })).text);
  return { pool, calls, fail, ask, settings, advance: (ms: number) => (now += ms) };
}

test("a model with a price above zero is refused, a :free one is allowed", () => {
  assert.match(paidModelReason("fc-openrouter", "openai/gpt-4o") ?? "", /not a :free/);
  assert.equal(paidModelReason("fc-openrouter", "meta-llama/llama-3.3-70b-instruct:free"), undefined);
  assert.equal(paidModelReason("fc-openrouter", "openrouter/free"), undefined);
  // A :free id whose listing shows a price is still refused.
  assert.match(paidModelReason("fc-openrouter", "x/y:free", { priced: true }) ?? "", /costs money/);
  assert.match(paidModelReason("fc-zhipu", "glm-4-plus") ?? "", /Flash/);
  assert.equal(paidModelReason("fc-zhipu", "glm-4-flash"), undefined);
  const list = parseModelList("fc-openrouter", { data: [{ id: "a/b:free", pricing: { prompt: "0", completion: "0" } }, { id: "a/c", pricing: { prompt: "0.000002", completion: "0.000004" } }, { id: "a/d:free", pricing: { prompt: "0.1", completion: "0" } }] });
  assert.deepEqual(list.map((m) => [m.id, m.free]), [["a/b:free", true], ["a/c", false], ["a/d:free", false]]);
});

test("the pool refuses a paid model the user typed, and goes on to the next provider", async () => {
  const t = setup({ models: { "fc-groq": "x", "fc-openrouter": "openai/gpt-4o" } });
  assert.equal((await t.ask()).providerId, "fc-groq");
  t.settings.order = ["fc-openrouter", "fc-mistral"];
  const r = await t.ask();
  assert.equal(r.providerId, "fc-mistral");
  assert.ok(!t.calls.includes("fc-openrouter"), "the paid model was never called");
  assert.match(t.pool.status().find((s) => s.id === "fc-openrouter")?.lastError ?? "", /Refused/);
});

test("a 429 backs off by Retry-After and by the provider's reset header, and grows without one", () => {
  assert.equal(parseDuration("2m59.56s"), 179_560);
  assert.equal(parseDuration("120ms"), 120);
  assert.equal(retryAfterMs({ "retry-after": "7" }, "", 0), 7000);
  assert.equal(retryAfterMs({ "x-ratelimit-reset-requests": "1m30s" }, "", 0), 90_000);
  assert.equal(retryAfterMs({}, "Rate limit. Please try again in 7.5s.", 0), 7500);
  const l = new RateLimiter({ rpm: 0, rpd: 0 });
  assert.equal(l.rejected({ "retry-after": "10" }, "", 1000), 11_000);
  assert.equal(l.check(5000).ok, false);
  assert.equal(l.check(11_000).ok, true);
  const g = new RateLimiter({ rpm: 0, rpd: 0 });
  assert.equal(g.rejected({}, "", 0), 30_000);
  assert.equal(g.rejected({}, "", 30_000), 30_000 + 60_000);
  // A per-day limit waits for the next 00:00 UTC.
  const noon = Date.UTC(2026, 10, 22, 12);
  assert.equal(new RateLimiter({ rpm: 0, rpd: 0 }).rejected({}, "free-models-per-day limit", noon), Date.UTC(2026, 10, 23));
});

test("the minute and day counters stop a provider before it hits the limit", () => {
  const l = new RateLimiter({ rpm: 2, rpd: 3 });
  const t0 = Date.UTC(2026, 10, 22, 10);
  l.note(t0);
  l.note(t0 + 1000);
  const c = l.check(t0 + 2000);
  assert.deepEqual(c.ok === false && c.why, "minute");
  assert.equal(l.check(t0 + 61_000).ok, true);
  l.note(t0 + 61_000);
  const d = l.check(t0 + 62_000);
  assert.equal(d.ok === false && d.why, "day");
});

test("the circuit breaker opens after repeated errors, tries again later, and a bad key opens it at once", () => {
  const b = new CircuitBreaker(3, 10 * 60_000);
  b.failure(0);
  b.failure(0);
  assert.equal(b.allow(1), true);
  b.failure(0);
  assert.equal(b.allow(1), false);
  assert.equal(b.allow(10 * 60_000), true, "one trial after the pause");
  b.success();
  b.failure(0, true);
  assert.equal(b.allow(59 * 60_000), false);
});

test("fallback goes down the user's order, skips a limited provider and an erroring one", async () => {
  const t = setup();
  assert.equal((await t.ask()).providerId, "fc-groq");
  t.fail["fc-groq"] = { status: 429, headers: { "retry-after": "60" } };
  assert.equal((await t.ask()).providerId, "fc-openrouter");
  // Groq is now waiting: it is not asked again until the time passes.
  t.calls.length = 0;
  assert.equal((await t.ask()).providerId, "fc-openrouter");
  assert.deepEqual(t.calls, ["fc-openrouter"]);
  assert.equal(t.pool.status()[0]?.state, "limited");
  t.advance(61_000);
  t.fail["fc-groq"] = undefined;
  assert.equal((await t.ask()).providerId, "fc-groq");
  // 3 errors in a row pause a provider; the next one answers.
  t.fail["fc-groq"] = { status: 503 };
  for (let i = 0; i < 3; i++) await t.ask();
  assert.equal(t.pool.status()[0]?.state, "paused");
  t.calls.length = 0;
  await t.ask();
  assert.ok(!t.calls.includes("fc-groq"));
});

test("when every provider is at its limit the error is a quota error with a retry time", async () => {
  const t = setup();
  for (const id of ["fc-groq", "fc-openrouter", "fc-mistral"]) t.fail[id] = { status: 429, headers: { "retry-after": "300" } };
  await assert.rejects(t.ask(), (e: Error) => e instanceof FreeCloudUnavailable && /limit reached \(429\)/.test(e.message) && /retry in 5m/i.test(e.message));
});

test("uses are gated by the settings: chat fallback is off by default, background is on", async () => {
  const t = setup();
  assert.deepEqual(t.pool.candidates("chat"), []);
  assert.equal(t.pool.candidates("background").length, 3);
  assert.equal(t.pool.candidates("pick").length, 3);
  t.settings.chatFallback = true;
  assert.equal(t.pool.candidates("chat").length, 3);
  t.settings.disabled = ["fc-groq"];
  assert.equal(t.pool.candidates("chat")[0], "fc-openrouter");
});

test("a key is never echoed: errors, status and redaction leave it out", async () => {
  const t = setup();
  t.fail["fc-groq"] = { status: 500 };
  await t.ask();
  const status = JSON.stringify(t.pool.status());
  assert.ok(!status.includes(KEY) && !status.includes("SecretSecret"));
  t.fail["fc-groq"] = { status: 401 };
  t.advance(11 * 60_000);
  await t.ask();
  assert.ok(!JSON.stringify(t.pool.status()).includes(KEY));
  assert.equal(redact(`bad key ${KEY} and Bearer abcdefghijklmnop12345`, KEY), "bad key [key] and Bearer [key]");
  assert.equal(redact("Incorrect API key: sk-abcdefghijklmnopqrstuv"), "Incorrect API key: [key]");
  // The provider wrapper strips a key an error quotes.
  const p = new FreeOnlyProvider({ id: "fc-groq", type: "free-cloud", baseUrl: "http://127.0.0.1:1/v1", apiKey: KEY });
  await assert.rejects(p.chatWithTools({ providerModelId: "llama", messages: [], tools: [] }), (e: Error) => !e.message.includes(KEY));
});

test("the paid-model guard also stops a call made straight on the provider", async () => {
  const p = new FreeOnlyProvider({ id: "fc-openrouter", type: "free-cloud", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k-abcdefgh" });
  await assert.rejects(p.chatWithTools({ providerModelId: "openai/gpt-4o", messages: [], tools: [] }), /never uses a paid model/);
  assert.equal(freeBaseUrl("fc-cloudflare", {}), undefined);
  assert.match(freeBaseUrl("fc-cloudflare", { accountId: "abcdef0123456789" }) ?? "", /accounts\/abcdef0123456789\/ai\/v1$/);
  assert.equal(freeBaseUrl("fc-cloudflare", { accountId: "../evil" }), undefined);
});
