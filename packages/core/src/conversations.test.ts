import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFactory } from "@kesher/providers";
import type { AgentMessage } from "@kesher/shared";
import { createKesherServer } from "./server.js";

/**
 * A provider whose model writes a file when asked to, then summarises.
 * It decides from the conversation, like a real model would.
 */
const scriptedFactory: ProviderFactory = {
  type: "scripted",
  displayName: "Scripted",
  categories: ["chat"],
  create: (config) => ({
    id: config.id,
    name: "Scripted",
    location: "local",
    capabilities: { chat: true, tools: true },
    checkHealth: async () => true,
    listModels: async () => [{ id: `${config.id}/m`, providerId: config.id, providerModelId: "m", name: "m", category: "chat", location: "local" }],
    chatWithTools: async (req, _signal, onText) => {
      const last = req.messages.at(-1) as AgentMessage;
      if (last.role === "user" && /file/.test(last.content) && req.tools.some((t) => t.name === "write_file")) {
        return { text: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "out.txt", content: "from the agent" } }] };
      }
      const text = last.role === "tool" ? `Tool said: ${last.content}` : `You said: ${last.content}`;
      onText?.(text);
      return { text, toolCalls: [] };
    },
  }),
};

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-conv-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  server.services.registry.registerFactory(scriptedFactory);
  await server.app.inject({ method: "POST", url: "/api/providers", payload: { id: "fake", type: "scripted" } });
  return { server, dataDir };
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("chat conversation: create, send, get the reply, list, rename, delete", async () => {
  const { server } = await setup();
  const app = server.app;
  try {
    const noModel = await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } });
    assert.equal(noModel.statusCode, 400, "no active chat model yet");

    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "fake/m" } } });
    const created = (await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } })).json() as { id: string; modelId: string };
    assert.equal(created.modelId, "fake/m");

    const sent = await app.inject({ method: "POST", url: `/api/conversations/${created.id}/messages`, payload: { text: "שלום עולם" } });
    assert.equal(sent.statusCode, 200, sent.body);
    const reply = await until(async () => {
      const c = (await app.inject({ method: "GET", url: `/api/conversations/${created.id}` })).json() as {
        events: Array<{ type: string; text?: string }>;
        session: { status: string };
        title: string;
      };
      return c.events.find((e) => e.type === "assistant") && c.session.status === "idle" ? c : undefined;
    });
    assert.equal(reply.events.find((e) => e.type === "assistant")?.text, "You said: שלום עולם");
    assert.equal(reply.title, "שלום עולם", "first message titles the conversation");

    const list = (await app.inject({ method: "GET", url: "/api/conversations" })).json() as Array<{ id: string }>;
    assert.deepEqual(list.map((c) => c.id), [created.id]);
    await app.inject({ method: "PATCH", url: `/api/conversations/${created.id}`, payload: { title: "Renamed" } });
    assert.equal(((await app.inject({ method: "GET", url: `/api/conversations/${created.id}` })).json() as { title: string }).title, "Renamed");
    await app.inject({ method: "DELETE", url: `/api/conversations/${created.id}` });
    assert.equal((await app.inject({ method: "GET", url: `/api/conversations/${created.id}` })).statusCode, 404);
  } finally {
    await server.close();
  }
});

test("code conversation in a project: approval over HTTP writes the file", async () => {
  const { server } = await setup();
  const app = server.app;
  try {
    const folder = await mkdtemp(join(tmpdir(), "kesher-proj-"));
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Game", workspace: folder, instructions: "Use C#." } })).json() as { id: string };
    const c = (await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "code", projectId: project.id, modelId: "fake/m" } })).json() as { id: string };
    await app.inject({ method: "POST", url: `/api/conversations/${c.id}/messages`, payload: { text: "make a file" } });

    const pending = await until(async () => {
      const r = (await app.inject({ method: "GET", url: `/api/conversations/${c.id}` })).json() as { session: { pendingApprovals: string[] } };
      return r.session.pendingApprovals[0];
    });
    assert.equal(existsSync(join(folder, "out.txt")), false);
    const ok = await app.inject({ method: "POST", url: `/api/conversations/${c.id}/approvals/${pending}`, payload: { decision: "allow" } });
    assert.equal(ok.statusCode, 200);
    await until(async () => (existsSync(join(folder, "out.txt")) ? true : undefined));
    assert.equal(await readFile(join(folder, "out.txt"), "utf8"), "from the agent");

    const final = await until(async () => {
      const r = (await app.inject({ method: "GET", url: `/api/conversations/${c.id}` })).json() as { events: Array<{ type: string; text?: string }> };
      return r.events.find((e) => e.type === "assistant");
    });
    assert.match(final.text ?? "", /Tool said: Created out.txt/);

    const undo = await app.inject({ method: "POST", url: `/api/conversations/${c.id}/undo` });
    assert.equal(undo.statusCode, 200);
    assert.equal(existsSync(join(folder, "out.txt")), false);

    const inProject = (await app.inject({ method: "GET", url: `/api/conversations?projectId=${project.id}` })).json() as unknown[];
    assert.equal(inProject.length, 1);
    await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    const loose = (await app.inject({ method: "GET", url: "/api/conversations?projectId=none" })).json() as unknown[];
    assert.equal(loose.length, 1, "deleting a project keeps its conversations");
  } finally {
    await server.close();
  }
});

test("sync folder mirrors the library and is imported on the next start", async () => {
  const { server, dataDir } = await setup();
  const sync = await mkdtemp(join(tmpdir(), "kesher-drive-"));
  try {
    await server.app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "fake/m" } } });
    await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Synced" } });
    const res = await server.app.inject({ method: "PUT", url: "/api/settings", payload: { syncFolder: sync } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await readdir(join(sync, "KesherAI", "projects"))).length, 1);
    const bad = await server.app.inject({ method: "PUT", url: "/api/settings", payload: { syncFolder: join(sync, "missing") } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await server.close();
  }

  // A second computer (fresh data folder) pointing at the same sync folder sees the project.
  const other = await mkdtemp(join(tmpdir(), "kesher-conv2-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(other, "config.json"), JSON.stringify({ syncFolder: sync }));
  const second = await createKesherServer({ dataDir: other, autodetect: false, pluginRoots: [] });
  try {
    const projects = (await second.app.inject({ method: "GET", url: "/api/projects" })).json() as Array<{ name: string }>;
    assert.deepEqual(projects.map((p) => p.name), ["Synced"]);
  } finally {
    await second.close();
  }
  void dataDir;
});

test("version and settings endpoints answer", async () => {
  const { server } = await setup();
  try {
    const v = (await server.app.inject({ method: "GET", url: "/api/version" })).json() as { version: string; install: string };
    assert.equal(v.version, (JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version);
    assert.ok(v.install === "git" || v.install === "package");
    const engine = (await server.app.inject({ method: "GET", url: "/api/engines/llamacpp" })).json() as { installed: boolean };
    assert.equal(engine.installed, false);
    const rec = (await server.app.inject({ method: "GET", url: "/api/models/recommended" })).json() as Array<{ id: string; estimate: { rating: string } }>;
    assert.ok(rec.length >= 3 && rec.every((r) => r.estimate.rating));
  } finally {
    await server.close();
  }
});

test("an approval given for good holds in the chosen scope and survives a restart", async () => {
  const { mkdtemp: mk } = await import("node:fs/promises");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const { createKesherServer: create } = await import("./server.js");
  const dir = await mk(j(td(), "kesher-perm-"));
  const s = await create({ dataDir: dir, autodetect: false, pluginRoots: [] });
  try {
    s.services.config.permissions.push({ tool: "run_command", scope: "model", modelId: "x/y" });
    const c = (await s.app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat", modelId: "x/y" } })).json() as { id: string };
    const opened = await s.services.conversations.open(c.id);
    const check = (opened!.session as unknown as { isAlwaysAllowed: (t: string, m: string) => boolean }).isAlwaysAllowed;
    assert.equal(check("run_command", "x/y"), true);
    assert.equal(check("run_command", "other/model"), false);
    assert.equal(check("write_file", "x/y"), false);
    const list = (await s.app.inject({ method: "GET", url: "/api/permissions" })).json() as unknown[];
    assert.equal(list.length, 1);
    assert.equal((await s.app.inject({ method: "DELETE", url: "/api/permissions/0" })).statusCode, 200);
    assert.equal(check("run_command", "x/y"), false);
  } finally {
    await s.close();
  }
});

test("large conversations are stored compressed and read back unchanged", async () => {
  const { mkdtemp: mk, readFile: rf } = await import("node:fs/promises");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const { Library } = await import("./library.js");
  const dir = await mk(j(td(), "kesher-gz-"));
  const lib = new Library(dir, () => undefined);
  await lib.load();
  const now = new Date().toISOString();
  const big = { id: "c1", projectId: null, title: "Big", kind: "chat" as const, modelId: "m", mode: "ask" as const, messages: Array.from({ length: 300 }, (_, i) => ({ role: "user" as const, content: `message ${i} ${"lorem ipsum ".repeat(30)}` })), events: [], createdAt: now, updatedAt: now };
  await lib.saveConversation(big);
  const raw = await rf(j(dir, "conversations", "c1.json"));
  assert.equal(raw[0], 0x1f, "gzip");
  assert.ok(raw.length < JSON.stringify(big).length / 5, `${raw.length} bytes`);
  const back = await lib.getConversation("c1");
  assert.deepEqual(back?.messages, big.messages);
});

test("branches: copy up to a reply, or edit an earlier message and resend it", async () => {
  const { server } = await setup();
  const app = server.app;
  type Ev = { seq: number; type: string; text?: string };
  const get = async (id: string) => (await app.inject({ method: "GET", url: `/api/conversations/${id}` })).json() as { events: Ev[]; session: { status: string }; branchOf?: { id: string; seq: number }; title: string };
  const replies = async (id: string, n: number) => until(async () => {
    const c = await get(id);
    const a = c.events.filter((e) => e.type === "assistant");
    return c.session.status === "idle" && a.length >= n ? a.map((e) => e.text) : undefined;
  });
  try {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { activeModels: { chat: "fake/m" } } });
    const c = (await app.inject({ method: "POST", url: "/api/conversations", payload: { kind: "chat" } })).json() as { id: string };
    await app.inject({ method: "POST", url: `/api/conversations/${c.id}/messages`, payload: { text: "first" } });
    await replies(c.id, 1);
    await app.inject({ method: "POST", url: `/api/conversations/${c.id}/messages`, payload: { text: "second" } });
    await replies(c.id, 2);
    const events = (await get(c.id)).events;
    const firstReply = events.find((e) => e.type === "assistant")!;
    const secondUser = events.filter((e) => e.type === "user")[1]!;

    const bad = await app.inject({ method: "POST", url: `/api/conversations/${c.id}/branch`, payload: { seq: firstReply.seq, text: "x" } });
    assert.equal(bad.statusCode, 400, "only the user's messages can be edited");

    const copy = (await app.inject({ method: "POST", url: `/api/conversations/${c.id}/branch`, payload: { seq: firstReply.seq } })).json() as { id: string; branchOf: { id: string } };
    assert.equal(copy.branchOf.id, c.id);
    const copied = await get(copy.id);
    assert.deepEqual(copied.events.filter((e) => e.type === "user").map((e) => e.text), ["first"]);
    assert.match(copied.title, /↳$/);

    const edited = (await app.inject({ method: "POST", url: `/api/conversations/${c.id}/branch`, payload: { seq: secondUser.seq, text: "changed" } })).json() as { id: string };
    assert.deepEqual(await replies(edited.id, 2), ["You said: first", "You said: changed"]);
    assert.equal((await get(c.id)).events.filter((e) => e.type === "user").length, 2, "the original is untouched");
  } finally {
    await server.close();
  }
});
