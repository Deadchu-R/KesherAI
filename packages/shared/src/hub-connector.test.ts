import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_LIMITS, fitConnectorAnswer, mapConnectorText, parseConnectorAnswer, parseConnectorQuery } from "./hub-connector.js";
import { DEFAULT_OPT_IN, cleanOptIn, parseSealedBody } from "./hub-protocol.js";

test("connector queries: only the listed ops and the hub page's actions; ids and fields checked", () => {
  assert.deepEqual(parseConnectorQuery({ queryId: "q1", op: "tasks", filter: "weird" }), { queryId: "q1", op: "tasks", filter: "all" });
  assert.equal(parseConnectorQuery({ queryId: "q1", op: "approve" }), null);
  assert.equal(parseConnectorQuery({ queryId: "q1", op: "settings" }), null);
  assert.equal(parseConnectorQuery({ queryId: "q 1", op: "tasks" }), null);
  assert.equal(parseConnectorQuery({ queryId: "q1", op: "task", taskId: "../x" }), null);
  assert.equal(parseConnectorQuery({ queryId: "q1", op: "action", taskId: "r-1", action: "inbox-asknext" }), null);
  assert.equal(parseConnectorQuery({ queryId: "q1", op: "action", taskId: "r-1", action: "assign" }), null, "assign needs who");
  assert.deepEqual(parseConnectorQuery({ queryId: "q1", op: "action", taskId: "r-1", action: "assign", to: "local", confirm: true }), { queryId: "q1", op: "action", taskId: "r-1", action: "assign", to: "local", confirm: true });
  assert.deepEqual(parseConnectorQuery({ queryId: "q1", op: "add", title: " T ", goal: "line 1\nline 2\u0007", executor: "shell" }), { queryId: "q1", op: "add", title: "T", goal: "line 1\nline 2", executor: "auto" });
  assert.equal(parseConnectorQuery({ queryId: "q1", op: "add", title: "" }), null);
});

test("connector kinds: sealed bodies are checked by kind; the opt-in is off by default", () => {
  assert.equal(DEFAULT_OPT_IN.connector, false);
  assert.equal(cleanOptIn({}).connector, false);
  assert.equal(cleanOptIn({ connector: true }).connector, true);
  assert.equal(parseSealedBody({ type: "connector_query", queryId: "q1", op: "approve" }, "connector_query"), null);
  assert.equal(parseSealedBody({ type: "connector_answer", queryId: "q1", ok: true }, "connector_query"), null, "a kind cannot be swapped");
  assert.deepEqual(parseSealedBody({ type: "connector_answer", queryId: "q1", ok: true, at: 5, extra: "dropped" }, "connector_answer"), { type: "connector_answer", queryId: "q1", ok: true, at: 5 });
});

test("connector answers: rows capped, fitted under the envelope cap, text mapped", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ taskId: `r-${i}`, title: "t".repeat(300), state: "done", executor: "local" }));
  const a = parseConnectorAnswer({ queryId: "q", ok: true, at: 1, tasks: rows })!;
  assert.equal(a.tasks!.length, CONNECTOR_LIMITS.tasks);
  assert.equal(a.tasks![0]!.title.length, CONNECTOR_LIMITS.titleChars);
  const fit = fitConnectorAnswer({ ...a, tasks: Array.from({ length: 200 }, (_, i) => ({ taskId: `r-${i}`, title: "x".repeat(120), state: "done", executor: "local" })) });
  assert.ok(JSON.stringify(fit).length <= CONNECTOR_LIMITS.answerChars);
  assert.equal(fit.tasks!.at(-1)!.taskId, "r-199", "the newest stay");
  assert.match(fit.text!, /left out/);
  const m = mapConnectorText({ queryId: "q", ok: true, at: 1, text: "a", task: { taskId: "r", title: "b", state: "done", executor: "x", result: "c", stepLog: [{ tool: "d", target: "e", at: 1 }] } }, (s) => s.toUpperCase());
  assert.deepEqual([m.text, m.task!.title, m.task!.result, m.task!.stepLog[0]!.target, m.task!.taskId], ["A", "B", "C", "E", "r"]);
});
