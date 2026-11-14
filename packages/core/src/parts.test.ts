import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHidden, partOn } from "@kesher/shared";
import { createKesherServer } from "./server.js";

test("parts: off ones hide their pages, chat-only and everything presets", async () => {
  assert.equal(partOn({}, "voice"), true);
  assert.equal(partOn({ voice: false }, "voice"), false);
  assert.equal(pageHidden({ images: false }, "#/batch"), true);
  assert.equal(pageHidden({ images: false }, "#/models"), false);
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-parts-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    const app = server.app;
    const get = async () => ((await app.inject({ method: "GET", url: "/api/parts" })).json() as { parts: Array<{ id: string; on: boolean }> }).parts;
    assert.ok((await get()).every((p) => p.on));
    await app.inject({ method: "PUT", url: "/api/parts", payload: { parts: { compare: false, nope: false } } });
    assert.deepEqual(server.services.config.parts, { compare: false });
    await app.inject({ method: "PUT", url: "/api/parts", payload: { preset: "chat" } });
    assert.ok((await get()).every((p) => !p.on));
    // With pictures off, chats get no picture tool.
    assert.equal(server.services.conversations.mediaTools().tools.some((t) => t.spec.name === "generate_image"), false);
    await app.inject({ method: "PUT", url: "/api/parts", payload: { parts: { compare: true } } });
    assert.equal((await get()).find((p) => p.id === "compare")!.on, true);
    await app.inject({ method: "PUT", url: "/api/parts", payload: { preset: "all" } });
    assert.deepEqual(server.services.config.parts, {});
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
