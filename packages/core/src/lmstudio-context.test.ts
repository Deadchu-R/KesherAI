import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureLmStudioContext } from "./lmstudio-context.js";

test("LM Studio context: a model loaded at 4096 is unloaded and loaded again bigger; enough is left alone; not LM Studio is undefined", async () => {
  const calls: string[] = [];
  let ctx = 4096;
  const fake = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${init.body as string}` : ""}`);
    if (path === "/api/v1/models") return new Response(JSON.stringify({ models: [{ key: "qwen/qwen3-coder-30b", max_context_length: 262144, loaded_instances: [{ id: "qwen/qwen3-coder-30b", config: { context_length: ctx } }] }] }));
    if (path === "/api/v1/models/load") {
      ctx = 65536;
      return new Response(JSON.stringify({ status: "loaded", load_config: { context_length: 65536 } }));
    }
    return new Response("{}");
  }) as typeof fetch;
  const r = await ensureLmStudioContext("http://localhost:1235/v1", "qwen/qwen3-coder-30b", 65536, undefined, fake);
  assert.deepEqual(r, { before: 4096, after: 65536, reloaded: true });
  assert.match(calls[1]!, /unload .*qwen3-coder-30b/);
  assert.match(calls[2]!, /load .*"context_length":65536/);
  assert.deepEqual(await ensureLmStudioContext("http://localhost:1235/v1", "qwen/qwen3-coder-30b", 32768, undefined, fake), { before: 65536, after: 65536, reloaded: false });
  const notLms = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  assert.equal(await ensureLmStudioContext("http://x/v1", "m", 32768, undefined, notLms), undefined);
});
