import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewHunks } from "./helper-review.js";

const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 changed
 line 3
@@ -15,3 +15,4 @@
 line 15
 line 16
+new line
 line 17
diff --git a/b.txt b/b.txt
new file mode 100644
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+made
`;

test("reviewHunks applies one hunk, rejects another, keeps decided ones, and reports conflicts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kesher-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.txt"), before);
  const one = await reviewHunks({ root, shown: DIFF, full: DIFF, request: { path: "a.txt", hunks: [1], decision: "accepted" } });
  assert.deepEqual(one.decisions, { "a.txt": { 1: "accepted" } });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), before.replace("line 16\n", "line 16\nnew line\n"));
  assert.deepEqual(one.written, [{ path: join(root, "a.txt"), before }]);
  assert.match(one.summary, /kept and applied.*a\.txt \(1\)/);

  // The user edits the first hunk's lines meanwhile: Accept all keeps the file and reports the conflict.
  writeFileSync(join(root, "a.txt"), readFileSync(join(root, "a.txt"), "utf8").replace("line 2\n", "line two\n"));
  const all = await reviewHunks({ root, shown: DIFF, full: DIFF, done: one.decisions, request: { decision: "accepted" } });
  assert.deepEqual(all.conflicts.map((c) => [c.path, c.hunk]), [["a.txt", 0]]);
  assert.deepEqual(all.decisions, { "b.txt": { 0: "accepted" } });
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "made\n");

  const no = await reviewHunks({ root, shown: DIFF, full: DIFF, done: { ...one.decisions, ...all.decisions }, request: { path: "a.txt", decision: "rejected" } });
  assert.deepEqual(no.decisions, { "a.txt": { 0: "rejected" } });
  assert.match(no.summary, /rejected: a\.txt \(1\)/);
});

test("reviewHunks never writes outside the project or into .git", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kesher-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evil = "diff --git a/../out.txt b/../out.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../out.txt\n@@ -0,0 +1 @@\n+x\n";
  await assert.rejects(reviewHunks({ root, shown: evil, full: evil, request: { decision: "accepted" } }));
  assert.equal(existsSync(join(root, "..", "out.txt")), false);
  const git = "diff --git a/.git/hooks/x b/.git/hooks/x\nnew file mode 100644\n--- /dev/null\n+++ b/.git/hooks/x\n@@ -0,0 +1 @@\n+x\n";
  await assert.rejects(reviewHunks({ root, shown: git, full: git, request: { decision: "accepted" } }), /\.git/);
});
