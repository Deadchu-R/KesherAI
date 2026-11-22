import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ProviderRegistry } from "@kesher/providers";
import { KesherConfigSchema } from "../config.js";
import type { KesherServices } from "../services.js";
import { FreeCloudPool, freeCloudFactory } from "../free-cloud.js";
import { FREE_PROVIDER_IDS } from "../free-cloud-catalog.js";
import { freeCloudRoutes } from "./free-cloud.js";

const KEY = "gsk_AbCdEfGhIjKlMnOpQrStUvWx123456";

async function setup() {
  const config = KesherConfigSchema.parse({});
  const registry = new ProviderRegistry();
  registry.registerFactory(freeCloudFactory);
  let saves = 0;
  const pool = new FreeCloudPool({ registry, settings: () => ({ ...config.freeCloud, order: config.freeCloud.order.length ? config.freeCloud.order : [...FREE_PROVIDER_IDS] }) });
  const s = { config, registry, freeCloud: pool, saveConfig: async () => void saves++ } as unknown as KesherServices;
  const app = Fastify();
  await freeCloudRoutes(app, s);
  await app.ready();
  return { app, config, registry, saves: () => saves };
}

test("a key is saved as the connection's key, never sent back, and can be removed", async () => {
  const { app, config, registry, saves } = await setup();
  const put = await app.inject({ method: "PUT", url: "/api/free-cloud/fc-groq/key", payload: { key: ` ${KEY} ` } });
  assert.equal(put.statusCode, 200);
  assert.ok(!put.body.includes(KEY));
  assert.equal(config.providers.find((p) => p.id === "fc-groq")?.apiKey, KEY);
  assert.ok(registry.get("fc-groq"));
  assert.equal(saves(), 1);
  const get = await app.inject({ url: "/api/free-cloud" });
  assert.ok(!get.body.includes(KEY));
  assert.equal(get.json().providers.find((p: { id: string }) => p.id === "fc-groq").status.state, "ready");
  const bad = await app.inject({ method: "PUT", url: "/api/free-cloud/fc-groq/key", payload: { key: "has spaces secret" } });
  assert.equal(bad.statusCode, 400);
  assert.ok(!bad.body.includes("secret"));
  await app.inject({ method: "PUT", url: "/api/free-cloud/fc-groq/key", payload: { key: null } });
  assert.equal(config.providers.length, 0);
  assert.equal(registry.get("fc-groq"), undefined);
  await app.close();
});

test("Cloudflare needs its account id; a paid model cannot be chosen", async () => {
  const { app, config } = await setup();
  const early = await app.inject({ method: "PUT", url: "/api/free-cloud/fc-cloudflare/key", payload: { key: "cf-token-abcdefgh" } });
  assert.equal(early.statusCode, 400, "no account id yet");
  assert.equal(config.providers.some((p) => p.id === "fc-cloudflare"), false);
  const bad = await app.inject({ method: "PUT", url: "/api/free-cloud/settings", payload: { cloudflareAccountId: "../x" } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "PUT", url: "/api/free-cloud/settings", payload: { cloudflareAccountId: "abcdef0123456789" } });
  assert.equal(ok.statusCode, 200);
  await app.inject({ method: "PUT", url: "/api/free-cloud/fc-cloudflare/key", payload: { key: "cf-token-abcdefgh" } });
  assert.match(config.providers.find((p) => p.id === "fc-cloudflare")?.baseUrl ?? "", /accounts\/abcdef0123456789\/ai\/v1/);
  const paid = await app.inject({ method: "PUT", url: "/api/free-cloud/settings", payload: { models: { "fc-openrouter": "openai/gpt-4o" } } });
  assert.equal(paid.statusCode, 400);
  assert.match(paid.json().error, /never uses a paid model/);
  const order = await app.inject({ method: "PUT", url: "/api/free-cloud/settings", payload: { order: ["fc-zhipu", "nope", "fc-groq"], chatFallback: true } });
  assert.deepEqual(order.json().settings.order.slice(0, 2), ["fc-zhipu", "fc-groq"]);
  assert.equal(config.freeCloud.chatFallback, true);
  await app.close();
});

test("settings and keys cannot be changed from another device", async () => {
  const { app } = await setup();
  for (const [method, url, payload] of [["PUT", "/api/free-cloud/fc-groq/key", { key: KEY }], ["PUT", "/api/free-cloud/settings", { chatFallback: true }], ["POST", "/api/free-cloud/fc-groq/test", {}]] as const) {
    const r = await app.inject({ method, url, payload, remoteAddress: "192.168.1.50" });
    assert.equal(r.statusCode, 403, url);
  }
  assert.equal((await app.inject({ url: "/api/free-cloud", remoteAddress: "192.168.1.50" })).statusCode, 200, "the phone can see the state");
  await app.close();
});
