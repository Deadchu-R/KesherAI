import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { beaconSecret, beaconTopic, openLink, sealLink } from "./link-beacon.js";

test("link beacon: the phone's key opens what the computer sealed; another key does not", async () => {
  const secret = await beaconSecret("kd_phone-key");
  const sealed = await sealLink(secret, { url: "https://a-b-c.trycloudflare.com", name: "PC", t: 5 });
  assert.deepEqual(await openLink(secret, sealed), { url: "https://a-b-c.trycloudflare.com", name: "PC", t: 5 });
  assert.equal(await openLink(await beaconSecret("kd_other"), sealed), undefined);
  assert.equal(await openLink(secret, `${sealed.slice(0, -4)}AAAA`), undefined);
  assert.match(await beaconTopic(secret), /^kai[0-9a-f]{40}$/);
  // Not an https address (a page could try to send the phone somewhere else): refused.
  assert.equal(await openLink(secret, await sealLink(secret, { url: "http://evil.example/x?y", t: 1 })), undefined);
  // Not a plain host (a page could try to send the phone to a specific path): refused.
  assert.equal(await openLink(secret, await sealLink(secret, { url: "https://example.com/path", t: 1 })), undefined);
});

test("link beacon: the phone app's copy (www/link-beacon.js) agrees with this one", async () => {
  const src = await readFile(new URL("../../../apps/android/www/link-beacon.js", import.meta.url), "utf8");
  const ctx: Record<string, unknown> = { crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, fetch: async () => ({ ok: false }), AbortSignal };
  ctx.globalThis = ctx;
  runInNewContext(src, ctx);
  const phone = ctx.KesherBeacon as { secretOf: (k: string) => Promise<string>; topicOf: (s: string) => Promise<string>; open: (s: string, x: string) => Promise<unknown> };
  const secret = await beaconSecret("kd_phone-key");
  assert.equal(await phone.secretOf("kd_phone-key"), secret);
  assert.equal(await phone.topicOf(secret), await beaconTopic(secret));
  const opened = (await phone.open(secret, await sealLink(secret, { url: "https://pc.tail1.ts.net/", t: 9 }))) as { url: string; t: number };
  assert.equal(opened.url, "https://pc.tail1.ts.net");
  assert.equal(opened.t, 9);
});
