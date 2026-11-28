import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import { createKesherServer } from "../server.js";
import { media } from "./media-prep.js";
import type { PrepRunner } from "../media-prep.js";

const idle: ProviderFactory = {
  type: "idle",
  displayName: "Idle",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Idle",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
    chatWithTools: async () => ({ text: "ok", toolCalls: [] }),
  }),
};

test("media prep routes: path guard, cache hit, Range, and the phone needs its key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-mp-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(idle);
  const app = server.app;
  let runs = 0;
  media.runner = {
    probe: async () => "Duration: 00:00:02.00\n  Stream #0:0: Video: h264, 640x360, 25 fps\n  Stream #0:1: Audio: aac, 44100 Hz",
    run: async (args) => {
      runs++;
      await writeFile(args.at(-1)!, "0123456789");
    },
    stream: async (a, onData) => {
      if (a.includes("-filter_complex")) await writeFile(a.at(-1)!, "rendered");
      else onData(Buffer.alloc(1024));
    },
  } satisfies PrepRunner;
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "idle", type: "idle" } });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "idle/m" } } });
    const made = await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } });
    const { id } = made.json() as { id: string };
    const folder = ((await app.inject({ url: `/api/conversations/${id}/files` })).json() as { folder: string }).folder;
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "clip.mp4"), "video bytes");
    await writeFile(join(dataDir, "outside.mp4"), "no");
    const post = (path: string, conversation = id) => app.inject({ method: "POST", url: "/api/media/prep", payload: { conversation, path } });

    // Path guard: outside the chat's folder, missing, and no chat.
    for (const bad of ["../outside.mp4", join(dataDir, "outside.mp4")]) assert.equal((await post(bad)).statusCode, 400, bad);
    assert.equal((await post("nope.mp4")).statusCode, 404);
    assert.equal((await post("clip.mp4", "missing")).statusCode, 404);

    const first = (await post("clip.mp4")).json() as { id: string; state: string };
    assert.match(first.id, /^[a-f0-9]{40}$/);
    let st = { state: first.state } as { state: string; ready?: { proxy: boolean } };
    for (let i = 0; i < 100 && st.state !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      st = (await app.inject({ url: `/api/media/prep/${first.id}` })).json();
    }
    assert.equal(st.state, "done");
    assert.equal(runs, 2);

    // Cache hit: the same file is answered done at once, FFmpeg does not run again.
    const again = (await post("clip.mp4")).json() as { state: string };
    assert.equal(again.state, "done");
    assert.equal(runs, 2);

    // Range.
    const part = await app.inject({ url: `/api/media/${first.id}/proxy`, headers: { range: "bytes=2-5" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, "2345");
    assert.equal(part.headers["content-range"], "bytes 2-5/10");
    assert.equal((await app.inject({ url: `/api/media/${first.id}/proxy` })).body, "0123456789");
    assert.equal((await app.inject({ url: `/api/media/${first.id}/proxy`, headers: { range: "bytes=50-" } })).statusCode, 416);
    assert.equal((await app.inject({ url: `/api/media/${first.id}/peaks` })).rawPayload.length, 4);
    assert.equal((await app.inject({ url: `/api/media/${first.id}/sprite.json` })).json<{ cols: number }>().cols, 20);

    // Export: ids only (a path is refused), the edit is checked, the render lands in the chat's shared/ folder.
    const exp = (body: object) => app.inject({ method: "POST", url: "/api/media/export", payload: { conversation: id, ...body } });
    const edit = { v: 1, video: [{ src: 0, from: 0, to: 1.5 }], lanes: [] };
    assert.equal((await exp({ sources: [join(folder, "clip.mp4")], edit })).statusCode, 400);
    assert.equal((await exp({ sources: ["c".repeat(40)], edit })).statusCode, 404);
    assert.equal((await exp({ sources: [first.id], edit: { v: 1, video: [{ src: 5, from: 0, to: 1 }], lanes: [] } })).statusCode, 400);
    const rendered = await exp({ sources: [first.id], edit, height: 720 });
    assert.equal(rendered.statusCode, 200);
    const { job } = rendered.json() as { job: string };
    let ex = { state: "running" } as { state: string; path?: string };
    for (let i = 0; i < 100 && ex.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ex = (await app.inject({ url: `/api/media/export/${job}` })).json();
    }
    assert.equal(ex.state, "done");
    assert.match(ex.path ?? "", /^shared\/clip-edit\.mp4$/);

    // Ids and parts are never paths.
    assert.equal((await app.inject({ url: "/api/media/..%2F..%2Fsecret/proxy" })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/media/${first.id}/secret` })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/media/${"b".repeat(40)}/proxy` })).statusCode, 404);

    // From the phone: refused without the device key.
    const far = { remoteAddress: "100.64.1.2", headers: { host: "100.64.1.1:7420" } };
    const refused = await app.inject({ url: `/api/media/${first.id}/proxy`, ...far });
    assert.ok(refused.statusCode === 401 || refused.statusCode === 403, `phone without a key: ${refused.statusCode}`);
  } finally {
    media.runner = undefined;
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
});
