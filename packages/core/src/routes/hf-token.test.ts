import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { KesherServices } from "../services.js";
import { hfTokenRoutes } from "./hf-token.js";

const TOKEN = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345";

async function setup() {
  const config: { huggingFaceToken?: string } = {};
  let saves = 0;
  const app = Fastify();
  await hfTokenRoutes(app, { config, saveConfig: async () => void saves++ } as unknown as KesherServices);
  await app.ready();
  return { app, config, saves: () => saves };
}

test("the Hugging Face token is saved from this computer and never sent back", async () => {
  const { app, config, saves } = await setup();
  assert.deepEqual((await app.inject({ url: "/api/hf-token" })).json(), { set: false });
  const put = await app.inject({ method: "PUT", url: "/api/hf-token", payload: { token: `  ${TOKEN} ` } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { set: true });
  assert.equal(config.huggingFaceToken, TOKEN);
  assert.equal(saves(), 1);
  const get = await app.inject({ url: "/api/hf-token" });
  assert.deepEqual(get.json(), { set: true });
  assert.ok(!put.body.includes(TOKEN) && !get.body.includes(TOKEN));
  // A malformed token is refused, and the answer does not repeat it.
  const bad = await app.inject({ method: "PUT", url: "/api/hf-token", payload: { token: "not a token\nsecret" } });
  assert.equal(bad.statusCode, 400);
  assert.ok(!bad.body.includes("secret"));
  assert.equal(config.huggingFaceToken, TOKEN);
  // Remove.
  assert.deepEqual((await app.inject({ method: "PUT", url: "/api/hf-token", payload: { token: null } })).json(), { set: false });
  assert.equal(config.huggingFaceToken, undefined);
  await app.close();
});

test("the Hugging Face token cannot be changed from another device", async () => {
  const { app, config } = await setup();
  const r = await app.inject({ method: "PUT", url: "/api/hf-token", remoteAddress: "203.0.113.7", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.7" }, payload: { token: TOKEN } });
  assert.equal(r.statusCode, 403);
  assert.equal(config.huggingFaceToken, undefined);
  assert.ok(!r.body.includes(TOKEN));
  await app.close();
});

test("the token is stored encrypted in the config file", async () => {
  const { withSecrets } = await import("../config.js");
  const box = { seal: (v: string) => Buffer.from(v).toString("base64"), unseal: (v: string) => Buffer.from(v, "base64").toString() };
  const sealed = withSecrets({ huggingFaceToken: TOKEN }, "seal", box);
  assert.ok(String(sealed.huggingFaceToken).startsWith("enc:v1:"));
  assert.ok(!JSON.stringify(sealed).includes(TOKEN));
  assert.equal(withSecrets(sealed, "unseal", box).huggingFaceToken, TOKEN);
});
