import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc, vscodeThemeToMonaco } from "./ide.js";

test("ide: VS Code settings with comments and trailing commas", () => {
  const j = parseJsonc('{\n  // my font\n  "editor.fontFamily": "Fira Code, // not a comment",\n  /* size */ "editor.fontSize": 15,\n}') as Record<string, unknown>;
  assert.equal(j["editor.fontFamily"], "Fira Code, // not a comment");
  assert.equal(j["editor.fontSize"], 15);
});

test("ide: a VS Code theme (with its parent) as a Monaco theme", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ide-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.json"), JSON.stringify({ type: "dark", colors: { "editor.background": "#101010" }, tokenColors: [{ scope: "comment", settings: { foreground: "#6A9955", fontStyle: "italic" } }] }));
  writeFileSync(join(dir, "mine.json"), '{ "include": "./base.json", // parent\n "colors": { "editor.foreground": "#EEEEEE", "editor.background": "not a color" },\n "tokenColors": [ { "scope": ["keyword.control", "storage.type.class"], "settings": { "foreground": "#C586C0" } }, ], }');
  const th = await vscodeThemeToMonaco(join(dir, "mine.json"));
  assert.equal(th.base, "vs-dark");
  assert.equal(th.colors["editor.background"], "#101010");
  assert.equal(th.colors["editor.foreground"], "#EEEEEE");
  assert.deepEqual(th.rules.find((r) => r.token === "comment"), { token: "comment", foreground: "6A9955", fontStyle: "italic" });
  assert.equal(th.rules.find((r) => r.token === "keyword")?.foreground, "C586C0");
  assert.equal(th.rules.find((r) => r.token === "type")?.foreground, "C586C0");
});

test("ide: a theme's include never reads outside its extension; bad font styles are dropped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ide-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "ext", "themes"), { recursive: true });
  writeFileSync(join(dir, "outside.json"), JSON.stringify({ colors: { "editor.background": "#ABCDEF" } }));
  writeFileSync(join(dir, "ext", "themes", "t.json"), JSON.stringify({ include: "../../outside.json", tokenColors: [{ scope: "comment", settings: { foreground: "#111111", fontStyle: "italic; color: red" } }] }));
  const th = await vscodeThemeToMonaco(join(dir, "ext", "themes", "t.json"));
  assert.equal(th.colors["editor.background"], undefined);
  assert.deepEqual(th.rules, [{ token: "comment", foreground: "111111" }]);
});
