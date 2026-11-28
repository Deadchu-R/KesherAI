import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterDecision, askMessage, buildFileTree, codeFileFromResult, diffPath, diffStats, findInText, highlightLines, outlineOf, pairRows, parseDiff, rejectHunk } from "./code-surface.js";
import { sameRoute } from "./ArtifactPanel.js";
import { BUILT_IN, buildSurfaces, itemFromResult, openTarget } from "./surfaces.js";

const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const lines = before.split("\n");
lines[2] = "line 3 changed";
lines.splice(20, 1);
const after = lines.join("\n");
const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,6 +1,6 @@
 line 1
 line 2
-line 3
+line 3 changed
 line 4
 line 5
 line 6
@@ -18,7 +18,6 @@
 line 18
 line 19
 line 20
-line 21
 line 22
 line 23
 line 24
`;

test("a write_file / edit_file result opens the code surface; other files and tools do not", () => {
  const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });
  assert.deepEqual(itemFromResult(list, "write_file", true, "Created src/app.ts (12 lines)."), { surface: "code", kind: "code", id: "src/app.ts", path: "src/app.ts", title: "app.ts" });
  assert.equal(itemFromResult(list, "edit_file", true, "Edited game/Player.cs.")?.path, "game/Player.cs");
  assert.equal(itemFromResult(list, "write_file", true, "Wrote notes/x.png (3 lines)."), undefined);
  assert.equal(itemFromResult(list, "write_file", false, "Created a.ts (1 lines)."), undefined);
  assert.equal(codeFileFromResult("run_command", true, "Created a.ts."), undefined);
  assert.equal(openTarget(BUILT_IN, list, "src/x.py")?.surface.id, "code");
  assert.notEqual(openTarget(BUILT_IN, list, "photo.png")?.surface.id, "code");
});

test("hunks parse, count lines and carry the file's path", () => {
  const h = parseDiff(DIFF);
  assert.equal(h.length, 2);
  assert.deepEqual(diffStats(h), { added: 1, removed: 2 });
  assert.equal(diffPath(DIFF), "src/a.ts");
  const rows = pairRows(h[0]!);
  assert.equal(rows.find((r) => r.l?.t === "-")?.r?.text, "line 3 changed");
});

test("Reject puts one change back and moves the later hunks; Accept only drops it", () => {
  const h = parseDiff(DIFF);
  const one = rejectHunk(after, h[0]!)!;
  assert.equal(one.split("\n")[2], "line 3");
  assert.ok(!one.includes("line 21"), "the other change stays");
  const rest = afterDecision(h, 0, true);
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.newStart, 18);
  const both = rejectHunk(one, rest[0]!)!;
  assert.equal(both, before);
  assert.equal(afterDecision(h, 0, false)[0]!.newStart, 18);
  assert.equal(rejectHunk("something else\n", h[0]!), undefined, "edited since: no guess");
});

test("a hunk that moved is found again, a new file rejects to empty", () => {
  const h = parseDiff(DIFF);
  assert.equal(rejectHunk("top\ntop\n" + after, h[0]!)?.split("\n")[4], "line 3");
  const created = parseDiff("--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.equal(rejectHunk("a\nb", created[0]!), "");
});

test("selection becomes the ask message with path:lines", () => {
  const m = askMessage({ path: "src/a.ts", selection: "let x = 1;\n", from: 4, to: 6, instruction: "why?", change: false, he: false });
  assert.match(m, /^In src\/a\.ts:4-6, about these lines:\n```ts\nlet x = 1;\n```\n\nwhy\?$/);
  assert.match(askMessage({ path: "a.py", selection: "x", from: 2, to: 2, instruction: "קצר", change: true, he: true }), /^בקובץ a\.py:2, לשנות את השורות האלה:[\s\S]*edit_file/);
  assert.ok(askMessage({ path: "a.ts", selection: "x".repeat(5000), from: 1, to: 9, instruction: "q", change: false, he: false }).length < 3300);
});

test("outline of TS, Python, C# and C++", () => {
  const names = (t: string, l: string) => outlineOf(t, l).map((s) => s.name);
  assert.deepEqual(names("export class A {}\nexport const f = (x) => 1;\nfunction g() {}\nif (x) {\n}\ninterface I {}", "typescript"), ["A", "f", "g", "I"]);
  assert.deepEqual(names("class P:\n    def go(self):\n        pass\nasync def run():", "python"), ["P", "go", "run"]);
  assert.deepEqual(names("public class Hero : Mono {\n  public void Jump(int h) {\n  }\n  if (x) {\n}", "csharp"), ["Hero", "Jump"]);
  assert.deepEqual(names("class AHero {\n};\nvoid AHero::Tick(float dt)\n{\n}\nwhile (x) {", "cpp"), ["AHero", "AHero::Tick"]);
  assert.deepEqual(outlineOf("a: 1", "yaml"), []);
});

test("search in file, the folder tree, route and highlighting", () => {
  assert.deepEqual(findInText("a\nFoo bar\nfoo", "FOO").map((f) => f.line), [2, 3]);
  const t = buildFileTree(["b.ts", "src/z.ts", "src/a.ts"]);
  assert.deepEqual(t.map((n) => n.name), ["src", "b.ts"]);
  assert.deepEqual(t[0]!.children!.map((n) => n.name), ["a.ts", "z.ts"]);
  assert.ok(sameRoute("#/c/c8", "#/c/c8?file=a.ts") && sameRoute("#/c/c8/", "#/c/c8") && !sameRoute("#/c/c8", "#/c/c9"));
  const hl = highlightLines("/* a\nb */\nconst s = \"<x>\"; // hi\nclass Foo {}", "typescript");
  assert.equal(hl.length, 4);
  assert.match(hl[0]!, /^<span class="tk-c">\/\* a<\/span>$/);
  assert.match(hl[2]!, /tk-k">const.*tk-s">&quot;|tk-s">"&lt;x&gt;"/);
  assert.match(hl[3]!, /tk-k">class<\/span> <span class="tk-t">Foo/);
  assert.ok(!hl.join("").includes("<x>"), "the text is escaped");
});

test("Monaco and the full editor are not in the panel's first load", () => {
  const panel = readFileSync(new URL("./CodePanel.tsx", import.meta.url), "utf8");
  const statics = panel.split("\n").filter((l) => /^import .* from /.test(l));
  assert.ok(!statics.some((l) => /monaco|CodeEditor|MonacoEditor|colorize/.test(l)), "no static import of the editor");
  assert.match(panel, /lazy\(\(\) => import\("\.\/ide\/CodeEditor"\)\)/);
  assert.ok(!/monaco/.test(readFileSync(new URL("./code-surface.ts", import.meta.url), "utf8").replace(/Monaco/g, "")), "the helpers do not use it");
  const reg = readFileSync(new URL("./surfaces.ts", import.meta.url), "utf8");
  assert.ok(!/^import .*CodePanel/m.test(reg), "the registry loads the panel with import()");
  assert.ok(BUILT_IN.find((s) => s.id === "code")?.phone === "edit");
});
