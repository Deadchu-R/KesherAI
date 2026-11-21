import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "../server.js";

/**
 * The chat queue's routes (chat-queue.ts): moving a queued message, and Stop with "send next" or "clear".
 * The model answers only when the turn is stopped or `release` is called, so the chat stays busy while the test types.
 */
let release: () => void = () => undefined;
const heard: string[] = [];
const slowFactory: ProviderFactory = {
  type: "slow",
  displayName: "Slow",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Slow",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
    chatWithTools: async (req, signal) => {
      const last = req.messages.at(-1) as AgentMessage;
      if (last.role === "user" && last.content.startsWith("You keep a memory about the user")) return { text: '{"add":[],"forget":[]}', toolCalls: [] };
      if (last.role === "user") heard.push(last.content);
      await new Promise<void>((done, fail) => {
        release = done;
        signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
      });
      return { text: "ok", toolCalls: [] };
    },
  }),
};

async function until<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("queue: move reorders, bad moves are refused, Stop and send next sends the new first message", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-queue-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(slowFactory);
  const app = server.app;
  try {
    await app.inject({ method: "POST", url: "/api/providers", payload: { id: "slow", type: "slow" } });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "slow/m" } } });
    const { id } = (await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } })).json() as { id: string };
    const queued = async () => ((await app.inject({ method: "GET", url: `/api/conversations/${id}` })).json() as { session: { queued: Array<{ id: string; text: string }> } }).session.queued;

    await app.inject({ method: "POST", url: `/api/conversations/${id}/messages`, payload: { text: "first" } });
    await until(async () => (heard.includes("first") ? true : undefined));
    for (const text of ["a", "b", "c"]) await app.inject({ method: "POST", url: `/api/conversations/${id}/messages`, payload: { text } });
    const q = await queued();
    assert.deepEqual(q.map((m) => m.text), ["a", "b", "c"]);

    const moved = await app.inject({ method: "POST", url: `/api/conversations/${id}/queue/${q[2]!.id}/move`, payload: { to: 0 } });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.deepEqual((await queued()).map((m) => m.text), ["c", "a", "b"]);
    assert.equal((await app.inject({ method: "POST", url: `/api/conversations/${id}/queue/${q[2]!.id}/move`, payload: { to: "x" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/conversations/${id}/queue/nope/move`, payload: { to: 1 } })).statusCode, 404);

    // "Stop and send next": the stopped answer ends and "c" (now first) is sent at once; the rest wait their turn.
    await app.inject({ method: "POST", url: `/api/conversations/${id}/stop`, payload: { after: "next" } });
    await until(async () => (heard.includes("c") ? true : undefined));
    assert.deepEqual((await queued()).map((m) => m.text), ["a", "b"]);

    // "Stop and clear queue": nothing waits and nothing more is sent.
    await app.inject({ method: "POST", url: `/api/conversations/${id}/stop`, payload: { after: "clear" } });
    assert.deepEqual(await queued(), []);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!heard.includes("a") && !heard.includes("b"), "cleared messages are never sent");
  } finally {
    release();
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
