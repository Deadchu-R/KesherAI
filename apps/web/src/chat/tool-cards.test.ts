import { test } from "node:test";
import assert from "node:assert/strict";
import { callDuration, errorLine, formatDuration, groupCalls, groupTitle, maskSecrets, paramSummary, prettyOutput, searchHits, toolInfo, toolLabel } from "./tool-cards.js";

test("known tools have a friendly name in both languages, unknown ones keep their raw name", () => {
  assert.equal(toolLabel("web_search", true), "חיפוש ברשת");
  assert.equal(toolLabel("web_search", false), "Web search");
  assert.equal(toolLabel("make_music", false), "Make music");
  assert.equal(toolLabel("my_custom_tool", true), "my_custom_tool");
  assert.equal(toolInfo("my_custom_tool").icon, "🛠️");
  assert.equal(toolLabel("unity_create_gameobject", false), "Unity · create gameobject");
  assert.equal(toolLabel("browser_open", true), "דפדפן · open");
});

test("group titles use the plural, or fall back to N× name", () => {
  assert.equal(groupTitle("web_search", 3, false), "3 web searches");
  assert.equal(groupTitle("web_search", 3, true), "3 חיפושים ברשת");
  assert.equal(groupTitle("check_tools", 2, false), "2× Check tools");
});

test("paramSummary picks the main parameter and cuts long text", () => {
  assert.equal(paramSummary({ query: "unity rigidbody  jump" }), "unity rigidbody jump");
  assert.equal(paramSummary({ prompt: "x".repeat(200) }).length, 80);
  assert.ok(paramSummary({ prompt: "x".repeat(200) }).endsWith("…"));
  assert.equal(paramSummary({ path: `src/${"a/".repeat(60)}file.ts` }).endsWith("file.ts"), true);
  assert.equal(paramSummary({ unrelated: 1 }), "");
  assert.equal(paramSummary(undefined), "");
});

test("paramSummary never shows secrets", () => {
  assert.equal(paramSummary({ token: "abc", query: "cats" }), "cats");
  assert.equal(paramSummary({ command: "curl -H 'Authorization: Bearer abcdef123456789' https://x.io" }).includes("abcdef123456789"), false);
  assert.equal(paramSummary({ command: "deploy --api_key=SuperSecret123" }).includes("SuperSecret123"), false);
  assert.equal(paramSummary({ url: "https://bob:hunter2@example.com/a" }).includes("hunter2"), false);
  assert.equal(maskSecrets("key sk-abcdefghijklmnop1234 and ghp_abcdefgh12345678"), "key sk-••• and ghp_•••");
  assert.equal(maskSecrets("hello world"), "hello world");
});

test("groupCalls joins consecutive calls of one tool only", () => {
  const s = (name: string) => ({ call: { name } });
  const runs = groupCalls([s("web_search"), s("web_search"), s("read_file"), s("web_search"), s("ask_member"), s("ask_member")]);
  assert.deepEqual(runs.map((r) => [r.name, r.steps.length]), [["web_search", 2], ["read_file", 1], ["web_search", 1], ["ask_member", 1], ["ask_member", 1]]);
  assert.deepEqual(groupCalls([]), []);
});

test("durations", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 10, 0, s)).toISOString();
  assert.equal(callDuration({ at: at(0) }, { at: at(12) }, 0), 12_000);
  assert.equal(callDuration({ at: at(0) }, undefined, Date.parse(at(5))), 5000);
  assert.equal(callDuration({}, undefined, 1), undefined);
  assert.equal(formatDuration(800), "0.8s");
  assert.equal(formatDuration(12_400), "12s");
  assert.equal(formatDuration(65_000), "1m 05s");
});

test("searchHits reads the numbered list of a web search", () => {
  const out = "1. Unity Rigidbody\n   https://docs.unity3d.com/rb\n   Snippet one\n2. Jump guide\n   https://example.com/jump\n   Snippet\n\n(Answered by: x.)";
  assert.deepEqual(searchHits(out), [{ title: "Unity Rigidbody", url: "https://docs.unity3d.com/rb" }, { title: "Jump guide", url: "https://example.com/jump" }]);
  assert.deepEqual(searchHits("No results."), []);
  assert.deepEqual(searchHits("1. Bad\n   javascript:alert(1)\n"), []);
});

test("prettyOutput formats JSON and keeps text; errorLine is one line", () => {
  assert.equal(prettyOutput('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyOutput("plain\ntext"), "plain\ntext");
  assert.equal(prettyOutput("{broken"), "{broken");
  assert.ok(prettyOutput("x".repeat(9000)).length < 6010);
  assert.equal(errorLine("Error: file not found\nstack…"), "file not found");
  assert.equal(errorLine("\n\nboom"), "boom");
});

test("maskSecrets stays fast on long key-like text (no quadratic backtracking) and still masks", () => {
  const t0 = Date.now();
  maskSecrets("key".repeat(60_000));
  assert.ok(Date.now() - t0 < 500);
  assert.equal(maskSecrets("hf_token=abc123 and api_key: zzz"), "hf_token=••• and api_key: •••");
});
