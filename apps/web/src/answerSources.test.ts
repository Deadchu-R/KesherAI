import { test } from "node:test";
import assert from "node:assert/strict";
import { answerSources, parseSearchOutput } from "./answerSources.js";

test("search output is read into title, address and snippet", () => {
  assert.deepEqual(parseSearchOutput("1. Unreal 5.6 notes\n   https://dev.epicgames.com/a\n   What changed\n2. Bad\n   not a link"), [{ title: "Unreal 5.6 notes", url: "https://dev.epicgames.com/a", snippet: "What changed" }]);
});

test("each answer's sources: read pages first, search results after, same page once; by the turn's last answer", () => {
  const ev = (seq: number, e: object) => ({ seq, at: "2026-11-14T00:00:00Z", ...e }) as never;
  const events = [
    ev(1, { type: "user", text: "q" }),
    ev(2, { type: "tool_call", callId: "a", name: "web_search", input: { query: "ue 5.6" } }),
    ev(3, { type: "tool_result", callId: "a", name: "web_search", ok: true, output: "1. Notes\n   https://www.epic.com/n?x=1\n   s1\n2. Blog\n   https://blog.dev/b\n   s2" }),
    ev(4, { type: "assistant", text: "Let me read it." }),
    ev(5, { type: "tool_call", callId: "b", name: "web_fetch", input: { url: "https://www.epic.com/n" } }),
    ev(6, { type: "tool_result", callId: "b", name: "web_fetch", ok: true, output: "https://www.epic.com/n\n\ntext" }),
    ev(7, { type: "assistant", text: "Answer." }),
    ev(8, { type: "user", text: "thanks" }),
    ev(9, { type: "assistant", text: "Sure." }),
  ];
  const m = answerSources(events);
  assert.deepEqual([...m.keys()], [7], "only the turn's last answer, and none for a turn without web");
  const s = m.get(7)!;
  assert.deepEqual(s.queries, ["ue 5.6"]);
  assert.deepEqual(s.sources.map((x) => [x.domain, x.read, x.title]), [["epic.com", true, "Notes"], ["blog.dev", false, "Blog"]]);
});
