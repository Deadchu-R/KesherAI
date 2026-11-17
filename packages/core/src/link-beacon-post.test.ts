import { test } from "node:test";
import assert from "node:assert/strict";
import { beaconSecret, beaconTopic, openLink } from "@kesher/shared";
import { LinkBeaconPoster } from "./link-beacon-post.js";

test("the address goes to each phone's topic, sealed for its key; again only when it changes or hours pass", async () => {
  const secret = await beaconSecret("kd_phone");
  const sent: Array<{ topic: string; body: string }> = [];
  let url: string | undefined = "https://one.trycloudflare.com";
  const p = new LinkBeaconPoster(() => url, async () => [secret, secret], () => "PC", async (topic, body) => void sent.push({ topic, body }), 3600_000);
  assert.equal(await p.check(1000), 1);
  assert.equal(sent[0]!.topic, await beaconTopic(secret));
  assert.equal((await openLink(secret, sent[0]!.body))?.url, "https://one.trycloudflare.com");
  assert.equal(await p.check(2000), 0);
  url = "https://two.trycloudflare.com";
  assert.equal(await p.check(3000), 1);
  assert.equal(await p.check(3000 + 3600_000), 1);
  url = undefined;
  assert.equal(await p.check(9e9), 0);
});
