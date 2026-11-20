import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHunk, parseDiff } from "./diff-review.js";

const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 changed
 line 3
@@ -15,3 +15,4 @@ ctx
 line 15
 line 16
+new line
 line 17
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Hi
+there
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test("parseDiff splits a git diff into files and hunks", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((f) => [f.path, f.kind, f.hunks.length]), [["src/a.ts", "modify", 2], ["new.md", "add", 1], ["old.txt", "delete", 1]]);
  assert.equal(files[0]!.hunks[1]!.oldStart, 15);
  const cut = parseDiff(DIFF.slice(0, DIFF.indexOf("+new line")));
  assert.equal(cut[0]!.hunks.length, 1);
  assert.equal(cut[0]!.cut, true, "a hunk cut short is left out");
});

test("applyHunk applies each hunk alone, in any order, and refuses a changed file", () => {
  const [a, made, gone] = parseDiff(DIFF);
  const second = applyHunk(before, a!, a!.hunks[1]!);
  assert.deepEqual(second, { ok: true, text: before.replace("line 16\n", "line 16\nnew line\n") });
  const both = applyHunk((second as { text: string }).text, a!, a!.hunks[0]!);
  assert.equal((both as { text: string }).text, before.replace("line 2\n", "line 2 changed\n").replace("line 16\n", "line 16\nnew line\n"));
  assert.deepEqual(applyHunk((both as { text: string }).text, a!, a!.hunks[0]!), { ok: true, text: (both as { text: string }).text, already: true });
  // Lines moved by an edit above still match (nearest place).
  assert.equal((applyHunk(`top\n${before}`, a!, a!.hunks[1]!) as { text: string }).text, `top\n${before.replace("line 16\n", "line 16\nnew line\n")}`);
  const changed = applyHunk(before.replace("line 2\n", "line two\n"), a!, a!.hunks[0]!);
  assert.equal(changed.ok, false);
  assert.deepEqual(applyHunk(null, made!, made!.hunks[0]!), { ok: true, text: "# Hi\nthere" });
  assert.equal(applyHunk("other", made!, made!.hunks[0]!).ok, false);
  assert.deepEqual(applyHunk("bye\n", gone!, gone!.hunks[0]!), { ok: true, text: null });
  assert.equal(applyHunk("bye now\n", gone!, gone!.hunks[0]!).ok, false);
});
