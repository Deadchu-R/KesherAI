import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { lensPrompt, lensRoutes } from "./lens.js";
import type { KesherServices } from "../services.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("lens: a picture is kept and served, only PNGs, capture only from this computer, the prompts", async () => {
  const app = Fastify();
  await lensRoutes(app, { config: { activeModels: {} }, screen: undefined } as unknown as KesherServices);
  const r = await app.inject({ method: "POST", url: "/api/lens/shot", payload: { data: PNG.toString("base64") } });
  const id = (r.json() as { id: string }).id;
  const g = await app.inject({ url: `/api/lens/shot/${id}` });
  assert.equal(g.headers["content-type"], "image/png");
  assert.equal(g.rawPayload.length, PNG.length);
  assert.equal((await app.inject({ method: "POST", url: "/api/lens/shot", payload: { data: Buffer.from("GIF89a....").toString("base64") } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/lens/capture", remoteAddress: "10.0.0.5" })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/lens/act", payload: { image: PNG.toString("base64"), action: "summarize" } })).statusCode, 400);
  assert.match(lensPrompt("translate", "", true), /Hebrew into English/);
  assert.match(lensPrompt("ask", "מה זה?", true), /^מה זה\? Answer in Hebrew/);
  await app.close();
});

test("lens: Windows OCR lines (one or many) are read and checked", async () => {
  const { parseOcr } = await import("./lens.js");
  assert.deepEqual(parseOcr('{"t":"Hello","x":1,"y":2,"w":30,"h":10}'), [{ t: "Hello", x: 1, y: 2, w: 30, h: 10 }]);
  assert.equal(parseOcr('[{"t":"  ","x":1}]'), undefined);
  assert.equal(parseOcr("not json"), undefined);
  assert.equal(parseOcr('[{"t":"a"},{"t":"b","x":"5"}]')![1]!.x, 5);
});
