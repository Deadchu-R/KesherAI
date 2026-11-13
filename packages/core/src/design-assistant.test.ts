import { test } from "node:test";
import assert from "node:assert/strict";
import { menuTool, runDesigner, type MenuStore } from "./design-assistant.js";
import type { Shortcut } from "./menu-shortcuts.js";
import type { ModelTurn } from "@kesher/agent";

function store(): MenuStore & { p: string[] | null; s: Shortcut[] } {
  const st = {
    p: null as string[] | null,
    s: [{ id: "a", label: "Self-work", href: "#/self-work" }] as Shortcut[],
    pins: () => st.p,
    setPins: async (n: string[]) => void (st.p = n),
    shortcuts: () => st.s,
    setShortcuts: async (n: Shortcut[]) => void (st.s = n),
  };
  return st;
}
const PAGES = [{ href: "#/images", label: "Images" }, { href: "#/models", label: "Models" }, { href: "#/knowledge", label: "Knowledge" }];
const ctx = { signal: new AbortController().signal } as never;

test("change_menu pins only real pages, in the order given, and manages shortcuts", async () => {
  const st = store();
  const tool = menuTool(st, PAGES, ["#/images"]);
  const r = await tool.run({ pins: ["#/models", "#/images", "#/nope", "javascript:alert(1)"] }, ctx);
  assert.deepEqual(st.p, ["#/models", "#/images"]);
  assert.match(String(r.output), /Models, Images/);
  assert.match(String(r.output), /left out/);
  await tool.run({ addShortcuts: [{ label: "GitHub", href: "https://github.com", icon: "🐙" }, { label: "Bad", href: "javascript:alert(1)" }, { label: "Again", href: "#/self-work" }] }, ctx);
  assert.deepEqual(st.s.map((x) => x.label), ["Self-work", "GitHub"]);
  await tool.run({ shortcutOrder: ["github"] }, ctx);
  assert.deepEqual(st.s.map((x) => x.label), ["GitHub", "Self-work"]);
  await tool.run({ removeShortcuts: ["Self-work"] }, ctx);
  assert.deepEqual(st.s.map((x) => x.label), ["GitHub"]);
  assert.match(String((await tool.run({}, ctx)).output), /Nothing to change/);
});

test("the design assistant uses its tools and answers shortly; other tools are not there", async () => {
  const st = store();
  let turns = 0;
  const model: ModelTurn = async (req) => {
    turns++;
    assert.deepEqual(req.tools.map((t) => t.name).filter((n) => n !== "ask_user" && n !== "request_access").sort(), ["change_menu"]);
    if (turns === 1) return { text: "", toolCalls: [{ id: "1", name: "change_menu", arguments: { pins: ["#/knowledge", "#/models"] } }] };
    return { text: "<think>done</think>Knowledge is first now.", toolCalls: [] };
  };
  const r = await runDesigner({ text: "put Knowledge first", tools: [menuTool(st, PAGES, [])], modelId: "m", model, state: "", hebrew: false, signal: new AbortController().signal });
  assert.equal(r.reply, "Knowledge is first now.");
  assert.deepEqual(r.used, ["change_menu"]);
  assert.deepEqual(st.p, ["#/knowledge", "#/models"]);
});
