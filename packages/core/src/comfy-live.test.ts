import { test } from "node:test";
import assert from "node:assert/strict";
import { readComfyLive } from "./comfy-live.js";
import type { ComfyStatus } from "./comfy-manager.js";

const status = (over: Partial<ComfyStatus> = {}): ComfyStatus => ({ installed: true, managed: true, running: true, url: "http://127.0.0.1:8188", log: ["secret path"], ...over });
const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("counts the jobs running and waiting in ComfyUI's queue", async () => {
  let asked = "";
  const get = (async (url: string) => {
    asked = url;
    return { ok: true, json: async () => ({ queue_running: [[1]], queue_pending: [[2], [3]] }) };
  }) as unknown as typeof fetch;
  const live = await readComfyLive(status(), get);
  assert.equal(asked, "http://127.0.0.1:8188/queue");
  assert.deepEqual(live, { installed: true, managed: true, up: true, running: 1, pending: 2 });
  assert.equal("log" in live, false, "the chip's answer carries no log or folder");
});

test("a refused or failed call means ComfyUI is down", async () => {
  const refused = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.deepEqual(await readComfyLive(status({ running: false }), refused), { installed: true, managed: false, up: false, running: 0, pending: 0 });
  assert.equal((await readComfyLive(status(), answer({}, false))).up, false);
});

test("the user's own ComfyUI (not started by KesherAI) is up but not stoppable", async () => {
  const live = await readComfyLive(status({ installed: false, managed: false, running: false }), answer({ queue_running: [], queue_pending: "x" }));
  assert.deepEqual(live, { installed: false, managed: false, up: true, running: 0, pending: 0 });
});

test("passes the install or start phase along", async () => {
  const live = await readComfyLive(status({ running: false, phase: "starting" }), answer({}, false));
  assert.equal(live.phase, "starting");
});
