import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { DocStore } from "../docs.js";
import { markdownToDocx } from "../docx-io.js";
import { docxRoutes } from "./docx.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "docx-route-"));
  const home = join(dir, "Documents");
  const chat = join(dir, "chat");
  await mkdir(home);
  await mkdir(chat);
  const docs = new DocStore(join(dir, "docs"));
  const assets = { save: async () => ({ id: "x" }) as never, get: async () => undefined };
  const app = Fastify();
  await docxRoutes(app, { docs, assets, roots: async () => [home] }, async (id) => (id === "c1" ? chat : undefined));
  const bytes = await markdownToDocx("T", "# Hello\n\nשלום עולם", async () => undefined);
  return { app, home, chat, docs, bytes };
}

test("a .docx in the chat's folder opens by chat id and file name: a chat-only copy has no file to save back to", async () => {
  const t = await setup();
  await writeFile(join(t.chat, "a.docx"), t.bytes);
  const r = await t.app.inject({ method: "POST", url: "/api/docs/import-docx", payload: { convId: "c1", file: "a.docx" } });
  assert.equal(r.statusCode, 200);
  const { id, path } = r.json() as { id: string; path?: string };
  assert.equal(path, undefined);
  assert.match((await t.docs.get(id))!.body, /^# Hello$/m);
  // With no file behind it, saving without a path is refused (the phone cannot send one), and the download works.
  assert.equal((await t.app.inject({ method: "POST", url: `/api/docs/${id}/save-docx`, payload: {} })).statusCode, 400);
  assert.equal((await t.app.inject({ url: `/api/docs/${id}/export.docx` })).statusCode, 200);
});

test("a chat file refuses other chats, other types and paths that leave the folder", async () => {
  const t = await setup();
  await writeFile(join(t.chat, "a.docx"), t.bytes);
  await writeFile(join(t.chat, "b.txt"), "x");
  const post = (convId: string, file: string) => t.app.inject({ method: "POST", url: "/api/docs/import-docx", payload: { convId, file } });
  assert.equal((await post("nope", "a.docx")).statusCode, 404);
  assert.equal((await post("c1", "b.txt")).statusCode, 400);
  assert.equal((await post("c1", "../a.docx")).statusCode, 400);
  assert.equal((await post("c1", "missing.docx")).statusCode, 404);
});

test("a chat file that is in one of the person's folders remembers it, and Save writes back with one .bak", async () => {
  const t = await setup();
  // The chat's folder is the person's own folder here (a workspace in Documents).
  const app = Fastify();
  await docxRoutes(app, { docs: t.docs, assets: { save: async () => ({ id: "x" }) as never, get: async () => undefined }, roots: async () => [t.home] }, async () => t.home);
  await writeFile(join(t.home, "plan.docx"), t.bytes);
  const r = await app.inject({ method: "POST", url: "/api/docs/import-docx", payload: { convId: "c1", file: "plan.docx" } });
  const { id, path } = r.json() as { id: string; path?: string };
  assert.ok(path?.endsWith("plan.docx"));
  const s = await app.inject({ method: "POST", url: `/api/docs/${id}/save-docx`, payload: {} });
  assert.equal(s.statusCode, 200);
  assert.equal((s.json() as { bak: boolean }).bak, true);
});
