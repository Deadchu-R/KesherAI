import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow } from "./study-diagram";

test("a Mermaid flowchart becomes boxes and arrows", () => {
  const f = parseFlow("flowchart LR\n  A[Angiotensinogen] --> B[Angiotensin I] -->|ACE| C[Angiotensin II]\n  C --> D(כיווץ כלי דם)");
  assert.ok(f);
  assert.equal(f.dir, "LR");
  assert.deepEqual(f.nodes.map((n) => n.label), ["Angiotensinogen", "Angiotensin I", "Angiotensin II", "כיווץ כלי דם"]);
  assert.deepEqual(f.edges[1], { from: "B", to: "C", label: "ACE" });
  assert.equal(f.edges.length, 3);
});

test("anything else is left as text", () => {
  assert.equal(parseFlow("sequenceDiagram\nA->>B: hi"), undefined);
  assert.equal(parseFlow(""), undefined);
});
