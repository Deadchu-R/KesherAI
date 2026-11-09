import { test } from "node:test";
import assert from "node:assert/strict";
import { textToolCalls } from "./text-tool-calls.js";

test("reads Qwen3-Coder XML calls, with or without the opening tag", () => {
  const r = textToolCalls("Let me check.\n<function=check_tools>\n</function>\n</tool_call>");
  assert.deepEqual(r.calls.map((c) => c.name), ["check_tools"]);
  assert.equal(r.text, "Let me check.");
  const w = textToolCalls('<tool_call>\n<function=write_file>\n<parameter=path>\nSource/A.h\n</parameter>\n<parameter=content>\n#pragma once\nint x;\n</parameter>\n<parameter=n>\n3\n</parameter>\n</function>\n</tool_call>');
  assert.deepEqual(w.calls[0]!.arguments, { path: "Source/A.h", content: "#pragma once\nint x;", n: 3 });
});

test("reads Hermes JSON calls and leaves plain text alone", () => {
  const r = textToolCalls('ok <tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>');
  assert.deepEqual(r.calls[0], { id: "text_call_0", name: "read_file", arguments: { path: "a.txt" } });
  assert.deepEqual(textToolCalls("no calls here").calls, []);
  assert.equal(textToolCalls("<tool_call>not json</tool_call>").calls.length, 0);
});
