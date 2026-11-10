import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@kesher/shared";
import { Notifier } from "./notify.js";

const settings = { ntfy: { enabled: true, server: "https://ntfy.example", topic: "kesher-abc" }, desktop: true, minSeconds: 0, includeText: false, waiting: true, approveButtons: true, waitingSeconds: 60 };
const ev = (e: Record<string, unknown>) => ({ seq: 1, at: "", ...e }) as AgentEvent;

test("long work ends: one notification to the phone and the desktop, title only by default", async () => {
  const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const shown: string[] = [];
  const n = new Notifier(() => settings, {
    desktop: (x) => (shown.push(x.title), true),
    publicUrl: () => "https://abc.trycloudflare.com",
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  n.onConversationEvent("c1", () => "שיחה על Unity", ev({ type: "status", status: "running" }), () => "secret answer");
  n.onConversationEvent("c1", () => "שיחה על Unity", ev({ type: "status", status: "idle" }), () => "secret answer");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "https://ntfy.example/kesher-abc");
  assert.match(posts[0]!.headers.Title!, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(posts[0]!.headers.Title!.slice(10, -2), "base64").toString(), "Done: שיחה על Unity");
  assert.equal(posts[0]!.headers.Click, "https://abc.trycloudflare.com/#/c/c1");
  assert.doesNotMatch(posts[0]!.body, /secret/);
  assert.deepEqual(shown, ["Done: שיחה על Unity"]);
  // Idle without a start (e.g. opening a conversation) sends nothing.
  n.onConversationEvent("c2", () => "x", ev({ type: "status", status: "idle" }), () => undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.length, 1);
  n.close();
});

test("short work and channels that are off send nothing", async () => {
  let posts = 0;
  const n = new Notifier(() => ({ ...settings, minSeconds: 60, desktop: false }), { fetch: (async () => (posts++, new Response(""))) as unknown as typeof fetch });
  n.onConversationEvent("c", () => "t", ev({ type: "status", status: "running" }), () => undefined);
  n.onConversationEvent("c", () => "t", ev({ type: "status", status: "idle" }), () => undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts, 0);
  assert.equal(Notifier.newTopic().length > 20, true);
});

test("an approval waiting: Approve / Deny buttons that work once", async () => {
  const posts: Array<{ url: string; body: string }> = [];
  const decided: string[] = [];
  const n = new Notifier(() => ({ ...settings, waitingSeconds: 0 }), {
    publicUrl: () => "https://abc.trycloudflare.com",
    decide: async (c, r, d) => (decided.push(`${c}/${r}/${d}`), true),
    fetch: (async (url: string, init: RequestInit) => (posts.push({ url, body: String(init.body) }), new Response("{}"))) as unknown as typeof fetch,
  });
  n.onConversationEvent("c1", () => "Build", ev({ type: "approval_request", requestId: "r1", callId: "x", name: "run_command", input: {}, preview: "rm -rf build" }), () => undefined);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "https://ntfy.example");
  const j = JSON.parse(posts[0]!.body) as { topic: string; message: string; actions: Array<{ label: string; url: string; method: string }> };
  assert.equal(j.topic, "kesher-abc");
  assert.match(j.message, /run_command/);
  assert.doesNotMatch(j.message, /rm -rf/);
  assert.deepEqual(j.actions.map((a) => [a.label, a.method]), [["Approve", "POST"], ["Deny", "POST"]]);
  const code = /quick-approve\/([\w-]{32})\?d=allow$/.exec(j.actions[0]!.url)![1]!;
  assert.equal(await n.quickDecide(code, "allow"), true);
  assert.deepEqual(decided, ["c1/r1/allow"]);
  // Used once: the same code (or a made-up one) does nothing.
  assert.equal(await n.quickDecide(code, "deny"), false);
  assert.equal(await n.quickDecide("x".repeat(32), "allow"), false);
  n.close();
});

test("the button's address needs no token, only a code that is waiting", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKesherServer } = await import("./server.js");
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-quick-")), autodetect: false, pluginRoots: [] });
  try {
    const app = server.app;
    const bad = await app.inject({ method: "POST", url: `/api/quick-approve/${"a".repeat(32)}?d=allow`, remoteAddress: "192.168.1.9" });
    assert.equal(bad.statusCode, 410);
    const get = await app.inject({ method: "GET", url: `/api/quick-approve/${"a".repeat(32)}?d=allow`, remoteAddress: "192.168.1.9" });
    assert.equal(get.statusCode, 401, "only POST is open");
    const other = await app.inject({ method: "POST", url: "/api/system/restart", remoteAddress: "192.168.1.9" });
    assert.equal(other.statusCode, 401);
  } finally {
    await server.close();
  }
});

test("the last notifications are kept in a file for the notifications page, without the Approve / Deny codes", async () => {
  const { mkdtemp, readFile: rf } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = await mkdtemp(j(tmpdir(), "kesher-notes-"));
  const file = j(dir, "notifications.json");
  const settings = { ntfy: { enabled: false, server: "https://ntfy.sh", topic: "t" }, desktop: false, minSeconds: 0, includeText: false, waiting: true, approveButtons: true, waitingSeconds: 60 };
  const a = new Notifier(() => settings as never, { history: file });
  await a.send({ title: "Done", body: "b", path: "#/c/1", actions: [{ label: "Allow", path: "/api/quick/SECRETCODE" }] });
  await new Promise((r) => setTimeout(r, 1200));
  const saved = await rf(file, "utf8");
  assert.ok(saved.includes("Done") && !saved.includes("SECRETCODE"));
  const b = new Notifier(() => settings as never, { history: file });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(b.sent[0]?.title, "Done");
});

test("a waiting note is marked answered, opens the chat, and a stopped run is not called Done", async () => {
  const n = new Notifier(() => ({ ...settings, waitingSeconds: 0, desktop: false }), { fetch: (async () => new Response("")) as unknown as typeof fetch });
  n.onConversationEvent("c9", () => "x", ev({ type: "status", status: "running" }), () => undefined);
  n.onConversationEvent("c9", () => "x", ev({ type: "approval_request", requestId: "r1", name: "run_command", preview: "git status" }), () => undefined);
  await new Promise((r) => setTimeout(r, 30));
  const waiting = n.sent.find((s) => s.title.startsWith("Waiting for you"))!;
  assert.equal(waiting.path, "#/c/c9", "the chat, where its card is");
  assert.equal(waiting.resolved, undefined);
  n.onConversationEvent("c9", () => "x", ev({ type: "approval_result", requestId: "r1", decision: "allow" }), () => undefined);
  assert.equal(waiting.resolved, "approved");
  n.onConversationEvent("c9", () => "x", ev({ type: "note", text: "Stopped." }), () => undefined);
  n.onConversationEvent("c9", () => "x", ev({ type: "status", status: "idle" }), () => undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!n.sent.some((s) => s.title.startsWith("Done")), "stopped by the user: no Done");
  n.close();
});
