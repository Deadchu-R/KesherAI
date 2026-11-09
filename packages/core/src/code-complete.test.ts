import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInline, inlinePrompt } from "./code-complete.js";

test("inline suggestions: the prompt marks the cursor; the answer loses fences, repeats and extra lines", () => {
  assert.match(inlinePrompt({ language: "csharp", path: "A.cs", prefix: "void Start() {\n    rb.", suffix: "\n}" }), /rb\.<CURSOR>\n\}/);
  assert.equal(cleanInline("```csharp\nAddForce(Vector3.up);\n```", "    rb.", ""), "AddForce(Vector3.up);");
  assert.equal(cleanInline("rb.AddForce(Vector3.up);", "    rb.", ""), "AddForce(Vector3.up);");
  assert.equal(cleanInline("<think>hmm</think>velocity = Vector3.zero;", "rb.", ""), "velocity = Vector3.zero;");
  assert.equal(cleanInline("}", "x = 1;\n", "\n}"), "");
  assert.equal(cleanInline(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"), "", "").split("\n").length, 12);
});
