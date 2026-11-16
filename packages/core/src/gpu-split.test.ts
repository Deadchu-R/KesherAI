import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";

test("two cards: the work split needs two different real cards; \"all together\" clears it", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-gpu-split-")), autodetect: false, pluginRoots: [] });
  try {
    const same = await server.app.inject({ method: "PUT", url: "/api/engines/gpu-split", payload: { chat: 0, comfy: 0 } });
    assert.equal(same.statusCode, 400);
    const missing = await server.app.inject({ method: "PUT", url: "/api/engines/gpu-split", payload: { chat: 7, comfy: 8 } });
    assert.equal(missing.statusCode, 400);
    const all = (await server.app.inject({ method: "PUT", url: "/api/engines/gpu-split", payload: { chat: null, comfy: null } })).json() as { ok: boolean; chat: unknown; comfy: unknown };
    assert.deepEqual({ ok: all.ok, chat: all.chat, comfy: all.comfy }, { ok: true, chat: null, comfy: null });
  } finally {
    await server.close();
  }
});
