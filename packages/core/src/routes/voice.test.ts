import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { voiceRoutes } from "./voice.js";
import type { KesherServices } from "../services.js";

/** Services with only what the voice routes touch: one chat, and a voice model or none. */
function fake(voiceModel: { modelId: string; label: string } | undefined, text = "SAY: On it.\nHANDOFF: Build the level"): KesherServices {
  return {
    conversations: { helpers: { voiceModel: async () => voiceModel } },
    library: { getConversation: async (id: string) => (id === "c1" ? { id, events: [{ type: "user", text: "hi" }, { type: "assistant", text: "Hello" }] } : undefined) },
    registry: { resolve: () => ({ provider: { location: "local", chat: async () => ({ text }) }, model: { providerModelId: "m" } }) },
  } as unknown as KesherServices;
}

test("without a small voice model the routes ask for the fallback, and the summary is read shortened", async () => {
  const app = Fastify();
  voiceRoutes(app, fake(undefined));
  assert.deepEqual((await app.inject({ url: "/api/voice/c1/status" })).json(), { fallback: true });
  const turn = await app.inject({ method: "POST", url: "/api/voice/c1/turn", payload: { text: "build the level" } });
  assert.equal(turn.statusCode, 409);
  assert.equal(turn.json().fallback, true);
  const sum = await app.inject({ method: "POST", url: "/api/voice/c1/summary", payload: { text: "**Done.** Built 3 rooms." } });
  assert.equal(sum.statusCode, 409);
  assert.equal(sum.json().say, "Done. Built 3 rooms.");
});

test("a turn needs words and a known chat", async () => {
  const app = Fastify();
  voiceRoutes(app, fake({ modelId: "llamacpp/small", label: "Small" }));
  assert.equal((await app.inject({ method: "POST", url: "/api/voice/c1/turn", payload: { text: " " } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/voice/nope/turn", payload: { text: "hi" } })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: "/api/voice/c1/status" })).json(), { model: "Small", fallback: false });
});
