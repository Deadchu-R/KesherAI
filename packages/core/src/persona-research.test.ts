import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelTurn } from "@kesher/agent";
import { parseQueries, researchPersona } from "./persona-research.js";

test("search plans: at most three short queries, anything else is none", () => {
  assert.deepEqual(parseQueries('{"queries": ["a", "b", "c", "d"]}'), ["a", "b", "c"]);
  assert.deepEqual(parseQueries('<think>{"queries":["x"]}</think>{"queries": []}'), []);
  assert.deepEqual(parseQueries("no json"), []);
  assert.deepEqual(parseQueries('{"queries": [1, "", " ok "]}'), ["ok"]);
});

test("research reads the top pages and keeps the sources; no plan means no searching", async () => {
  const model = (reply: string): ModelTurn => async () => ({ text: reply, toolCalls: [] });
  const searched: string[] = [];
  const deps = {
    search: async (q: string) => {
      searched.push(q);
      return [
        { title: `${q} 1`, url: `https://a.example/${q}`, snippet: "s1" },
        { title: "shared", url: "https://shared.example/", snippet: "s2" },
      ];
    },
    read: async (url: string) => `text of ${url}`,
  };
  const r = await researchPersona(model('{"queries": ["chef style", "knife skills"]}'), "a chef", deps, undefined, new AbortController().signal);
  assert.deepEqual(searched, ["chef style", "knife skills"]);
  assert.match(r.notes, /text of https:\/\/a\.example\/chef style/);
  assert.equal(new Set(r.sources.map((s) => s.url)).size, r.sources.length, "no page twice");
  assert.ok(r.sources.length >= 2);
  const none = await researchPersona(model('{"queries": []}'), "a translator", deps, undefined, new AbortController().signal);
  assert.deepEqual(none, { notes: "", sources: [] });
  assert.equal(searched.length, 2);
});
