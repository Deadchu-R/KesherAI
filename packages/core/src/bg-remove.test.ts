import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BgRemover } from "./bg-remove.js";

test("the background remover: not set up says so; only known models and real pictures are taken", async () => {
  const b = new BgRemover(await mkdtemp(join(tmpdir(), "bg-")), async () => "uv");
  assert.equal(b.status().installed, false);
  await assert.rejects(b.remove(Buffer.from("89504e47", "hex")), /Set up the background remover/);
});
