import { test } from "node:test";
import assert from "node:assert/strict";
import { blueprintToCode, codeText, type CodeNode } from "./blueprint-code.js";

const exec = (dir: "in" | "out", name: string, links?: string[]) => ({ name, dir, type: "exec", ...(links ? { links } : {}) });

test("a Blueprint graph reads as code, line by line with its node", () => {
  const nodes: CodeNode[] = [
    { id: "E", title: "Event BeginPlay", class: "K2Node_Event", x: 0, y: 0, pins: [exec("out", "then", ["B:execute"])] },
    { id: "B", title: "Branch", class: "K2Node_IfThenElse", x: 300, y: 0, pins: [exec("in", "execute"), { name: "Condition", dir: "in", type: "bool" }, exec("out", "then", ["P:execute"]), exec("out", "else")] },
    { id: "G", title: "Get IsOpen", class: "K2Node_VariableGet", x: 100, y: 200, pins: [{ name: "IsOpen", dir: "out", type: "bool", links: ["B:Condition"] }] },
    { id: "P", title: "Print String", class: "K2Node_CallFunction", x: 600, y: 0, pins: [exec("in", "execute"), { name: "InString", label: "In String", dir: "in", type: "string", default: "Open!" }, { name: "bPrintToScreen", label: "Print to Screen", dir: "in", type: "bool", default: "true" }, exec("out", "then")] },
    { id: "X", title: "Destroy Actor", class: "K2Node_CallFunction", x: 0, y: 500, pins: [exec("in", "execute"), exec("out", "then")] },
  ];
  const lines = blueprintToCode(nodes);
  const text = codeText(lines);
  assert.match(text, /^on BeginPlay\(\):/);
  assert.match(text, /Branch\(Condition=GetIsOpen\(\)\)/);
  assert.match(text, /then:\n {12}PrintString\(InString="Open!", PrinttoScreen=true\)/);
  assert.match(text, /not connected to an event:\n {4}DestroyActor\(\)/);
  assert.equal(lines.find((l) => l.text.startsWith("PrintString"))?.node, "P");
  assert.equal(lines[0]!.node, "E");
});
