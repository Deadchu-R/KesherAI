import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { appLinkRoutes } from "./live-quiz.js";

test("/open: a page that hands the key in the # to the phone app, with its own script only", async () => {
  const app = Fastify();
  await appLinkRoutes(app);
  const r = await app.inject({ url: "/open" });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers["content-security-policy"]), /script-src 'nonce-[^']+'/);
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.match(r.body, /scheme=kesherai;package=dev\.kesherai\.app/);
  // The key is never in what the server sends or logs: only the page's script reads location.hash.
  assert.match(r.body, /location\.hash/);
  await app.close();
});
