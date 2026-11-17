import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkWatch } from "./link-watch.js";

test("a changed anywhere address is told once, with its key; the first one and the same one are not", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "link-")), "anywhere-link.json");
  let url: string | undefined = "https://a-b-c-d.trycloudflare.com";
  const told: string[] = [];
  const w = new LinkWatch(file, () => url, async (link) => { told.push(link); }, () => "k 1");
  await w.start(1e9);
  assert.deepEqual(told, []);
  assert.equal(await w.check(), false);
  url = "https://e-f-g-h.trycloudflare.com";
  assert.equal(await w.check(), true);
  assert.deepEqual(told, ["https://e-f-g-h.trycloudflare.com/?token=k%201"]);
  url = undefined;
  assert.equal(await w.check(), false);
  w.stop();
  // After a restart it remembers the last address told.
  const again = new LinkWatch(file, () => "https://e-f-g-h.trycloudflare.com", async (link) => { told.push(link); }, () => "k");
  await again.start(1e9);
  assert.equal(told.length, 1);
  again.stop();
});
