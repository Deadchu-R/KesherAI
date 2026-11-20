import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { KesherServices } from "./services.js";
import { INSTALLABLES, offerInstallTool } from "./installables.js";
import { installableRoutes } from "./routes/installables.js";

const ctx = { signal: new AbortController().signal } as Parameters<ReturnType<typeof offerInstallTool>["run"]>[1];

test("offer_install shows the button for a missing thing, says go on when it is there, refuses unknown ids", async () => {
  const tool = offerInstallTool(async (id) => id === "ffmpeg");
  assert.equal(tool.risk, "read");
  assert.match((await tool.run({ id: "image-model" }, ctx)).output, /Install button/);
  assert.match((await tool.run({ id: "ffmpeg" }, ctx)).output, /already installed/);
  await assert.rejects(() => tool.run({ id: "../etc" }, ctx), /Unknown id/);
  assert.ok(INSTALLABLES.every((i) => i.he && i.en && i.aboutHe && i.aboutEn));
});

test("the Install window's facts, and the chat continues by itself once it is installed", async () => {
  let ready = false;
  let started = 0;
  const sent: Array<[string, string]> = [];
  const s = {
    config: { activeModels: {} },
    paths: { models: "/data/models", engines: "/data/engines" },
    kokoro: { status: () => ({ ready, busy: false, sizeMb: 330, voices: [] }), prepare: async () => { started++; setTimeout(() => (ready = true), 50); } },
    comfy: { status: () => ({ installed: false }) },
    engine: { status: () => ({ installed: true }) },
    library: { summary: (id: string) => (id === "c1" ? { id } : undefined) },
    conversations: { send: async (id: string, text: string) => { sent.push([id, text]); return {}; } },
  } as unknown as KesherServices;
  const app = Fastify();
  await installableRoutes(app, s);
  assert.equal((await app.inject({ method: "GET", url: "/api/installables/nope" })).statusCode, 404);
  const v = (await app.inject({ method: "GET", url: "/api/installables/text-to-speech" })).json() as { sizeGb: number; where: string; changeHref: string; ready: boolean };
  assert.deepEqual([v.sizeGb, v.where, v.changeHref, v.ready], [0.3, "/data/engines", "#/settings/computer", false]);
  const r = await app.inject({ method: "POST", url: "/api/installables/text-to-speech/install", payload: { chatId: "c1", continueText: "Installed. Go on." } });
  assert.equal(r.statusCode, 202);
  // An unknown chat is ignored (no message goes anywhere else).
  await app.inject({ method: "POST", url: "/api/installables/text-to-speech/install", payload: { chatId: "other", continueText: "x" } });
  await new Promise((res) => setTimeout(res, 3300));
  assert.equal(started, 1);
  assert.deepEqual(sent, [["c1", "Installed. Go on."]]);
  assert.equal(await s.conversations.installReady!("text-to-speech"), true);
  await app.close();
});
