import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPromptFields, promptFields } from "./prompt-fields.js";

test("fields: plain and typed, once each, {{input}} left out", () => {
  const t = 'Write to {{name}} in a {{tone | select:options=["formal","casual"]:default="formal":required}} tone about {{input}}. {{name}} again. {{n | number:min=1:max=5}} {{more | checkbox:label="Add a summary"}}';
  assert.deepEqual(promptFields(t), [
    { name: "name", type: "text" },
    { name: "tone", type: "select", options: ["formal", "casual"], default: "formal", required: true },
    { name: "n", type: "number", min: 1, max: 5 },
    { name: "more", type: "checkbox", label: "Add a summary" },
  ]);
  assert.equal(fillPromptFields(t, { name: "Dana", n: "3", more: true }), "Write to Dana in a formal tone about {{input}}. Dana again. 3 Add a summary");
  assert.equal(fillPromptFields(t, { name: "Dana", tone: "casual", more: false }), "Write to Dana in a casual tone about {{input}}. Dana again.  ");
});

test("a select with a broken list, an unknown type and a prompt without fields", () => {
  assert.deepEqual(promptFields("{{a | select:options=[oops}} {{b | weird}}"), [{ name: "a", type: "text" }, { name: "b", type: "text" }]);
  assert.deepEqual(promptFields("Summarise {{input}}"), []);
  assert.equal(fillPromptFields("Plain text", {}), "Plain text");
});
