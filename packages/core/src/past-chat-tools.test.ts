import { test } from "node:test";
import assert from "node:assert/strict";
import { around, pastChatTools, PAGE_TURNS, readPages, searchPastChats } from "./past-chat-tools.js";

const ctx = { signal: new AbortController().signal } as never;

type Conv = { id: string; title: string; projectId: string | null; updatedAt: string; incognito?: boolean; source?: string; events: Array<{ type: string; text: string; at?: string }> };

/** A stub library over a few chats (the same calls the tools make on the real one). */
function lib(convs: Conv[]) {
  return {
    listConversations: (p?: string | null) => convs.filter((c) => p === undefined || c.projectId === p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    getConversation: async (id: string) => convs.find((c) => c.id === id),
  } as never;
}

const chats: Conv[] = [
  { id: "now", title: "This chat", projectId: null, updatedAt: "2026-11-27T10:00:00Z", events: [{ type: "user", text: "dragon boss mentioned in this chat" }] },
  { id: "a", title: "Boss fight plan", projectId: null, updatedAt: "2026-11-26T10:00:00Z", events: [{ type: "user", text: "Let's decide: the dragon boss has three phases" }, { type: "assistant", text: "I suggest a fire phase first, then ice" }] },
  { id: "b", title: "Dragon notes (project)", projectId: "p1", updatedAt: "2026-11-25T10:00:00Z", events: [{ type: "user", text: "dragon boss in the project" }] },
  { id: "c", title: "Secret dragon", projectId: null, updatedAt: "2026-11-24T10:00:00Z", incognito: true, events: [{ type: "user", text: "dragon boss incognito" }] },
  { id: "d", title: "Cooking", projectId: null, updatedAt: "2026-11-23T10:00:00Z", events: [{ type: "user", text: "shakshuka recipe with eggs" }] },
];

test("past chats: scope is the non-project chats; not the current chat, incognito or another project", async () => {
  const hits = await searchPastChats({ library: lib(chats) }, { id: "now", projectId: null }, "dragon boss");
  assert.deepEqual(hits.map((h) => h.id), ["a"]);
  const inProject = await searchPastChats({ library: lib(chats) }, { id: "x", projectId: "p1" }, "dragon boss");
  assert.deepEqual(inProject.map((h) => h.id), ["b"]);
});

test("past chats: the tools are none in an incognito chat; hits carry the speaker; a hit's page opens at the match", async () => {
  const deps = { library: lib(chats) };
  assert.equal(pastChatTools(deps, () => ({ id: "now", projectId: null, incognito: true })).length, 0);
  const [search, recent, read] = pastChatTools(deps, () => ({ id: "now", projectId: null }));
  const out = (await search!.run({ query: "suggest fire phase" }, ctx)).output;
  assert.match(out, /chat:a · 2026-11-26 · assistant\n\s+assistant: "/, "the suggestion is the assistant's");
  const userHit = (await search!.run({ query: "decide dragon" }, ctx)).output;
  assert.match(userHit, /· user\n\s+user: "/);
  assert.match(userHit, /page_token: p0/);
  assert.match((await recent!.run({ n: 50 }, ctx)).output, /^[^]*Boss fight plan[^]*Cooking/);
  assert.doesNotMatch((await recent!.run({}, ctx)).output, /This chat|Secret|project/);
  assert.match((await recent!.run({ before: "2026-11-25T00:00:00Z" }, ctx)).output, /Cooking/);
  assert.doesNotMatch((await recent!.run({ after: "2026-11-25T00:00:00Z" }, ctx)).output, /Cooking/);
  assert.match((await read!.run({ id: "chat:a" }, ctx)).output, /\[1\] user.*\n\n\[2\] assistant/);
  for (const bad of ["c", "b", "now"]) assert.match((await read!.run({ id: bad }, ctx)).output, /not available/, `${bad} cannot be read`);
});

test("past chats: read_chat pages are 6 turns, at most 2 per call, with a next token", () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `t${i + 1}` }));
  const one = readPages(turns, undefined, 1);
  assert.equal(one.to - one.from + 1, PAGE_TURNS);
  assert.equal(one.next, "p6");
  const many = readPages(turns, "p6", 9);
  assert.equal(many.from, 7);
  assert.equal(many.to, 18, "9 pages asked, 2 given");
  assert.equal(many.next, "p18");
  assert.equal(readPages(turns, "p24", 2).next, undefined);
  assert.equal(readPages(turns, "p999", 1).from, 30, "a token past the end lands on the last turn");
});

test("past chats: keyword ranking (and Hebrew prefix), max is capped, an embedder re-ranks and a failing one falls back", async () => {
  const many: Conv[] = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, title: `Chat ${i}`, projectId: null, updatedAt: `2026-11-${10 + i}T10:00:00Z`, events: [{ type: "user", text: i === 3 ? "the quest quest quest system" : `quest number ${i}` }] }));
  const h = await searchPastChats({ library: lib(many) }, { id: "x", projectId: null }, "quest system", 99);
  assert.equal(h.length, 10, "at most 10 chats");
  assert.equal(h[0]!.id, "m3", "the chat with both words ranks first");
  const he = await searchPastChats({ library: lib([{ id: "h", title: "משחק", projectId: null, updatedAt: "2026-11-20T00:00:00Z", events: [{ type: "user", text: "החלטנו על מערכת הכשרונות" }] }]) }, { id: "x", projectId: null }, "בהכשרונות");
  assert.equal(he[0]?.id, "h");
  // An embedder that prefers the last candidate moves it up; one that throws leaves the keyword order.
  const vec = { id: "e", embed: async (t: string[]) => t.map((x, i) => (i === 0 ? [1, 0] : x.includes("number 9") ? [1, 0] : [0, 1])) };
  const re = await searchPastChats({ library: lib(many), embedder: () => vec }, { id: "x", projectId: null }, "quest", 3);
  assert.equal(re[0]!.id, "m9");
  const bad = await searchPastChats({ library: lib(many), embedder: () => ({ id: "e", embed: async () => { throw new Error("down"); } }) }, { id: "x", projectId: null }, "quest system", 3);
  assert.equal(bad[0]!.id, "m3");
});

test("past chats: the snippet is about 300 characters each side of the match", () => {
  const text = `${"x ".repeat(400)}needle${" y".repeat(400)}`;
  const s = around(text, "needle");
  assert.ok(s.includes("needle") && s.startsWith("…") && s.endsWith("…"));
  assert.ok(s.length <= 2 * 300 + 2 + 6 + 2);
});
