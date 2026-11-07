import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@kesher/shared";
import { Notifier } from "./notify.js";

const settings = { ntfy: { enabled: true, server: "https://ntfy.example", topic: "kesher-abc" }, desktop: true, minSeconds: 0, includeText: false, waiting: true };
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
