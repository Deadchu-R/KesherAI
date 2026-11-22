import { test } from "node:test";
import assert from "node:assert/strict";
import { indexWithLine, publishResearch, researchPathAllowed } from "./research-publish.js";

const INDEX = "# Research index\n\nIntro.\n\n| Id | Topic | File |\n|---|---|---|\n| c-1 | Old | [c-1.md](c-1.md) |\n";

test("indexWithLine: new id first under the header, a known id replaced", () => {
  const a = indexWithLine(INDEX, "c-2", "New | topic");
  assert.match(a, /\|---\|---\|---\|\n\| c-2 \| New topic \| \[c-2\.md\]\(c-2\.md\) \|\n\| c-1 \|/);
  const b = indexWithLine(INDEX, "c-1", "Better");
  assert.equal(b.split("\n").filter((l) => l.startsWith("| c-1 |")).length, 1);
  assert.match(b, /\| c-1 \| Better \|/);
});

test("researchPathAllowed: only docs/research markdown", () => {
  assert.ok(researchPathAllowed("docs/research/c-20261122-01.md"));
  assert.ok(researchPathAllowed("docs/research/INDEX.md"));
  assert.ok(!researchPathAllowed("docs/WORK_LIST.md"));
  assert.ok(!researchPathAllowed("docs/research/../x.md"));
  assert.ok(!researchPathAllowed("packages/core/src/a.ts"));
});

/** A fake git: records calls; diff and push answers come from the test. */
function fakeGit(diff: string, pushes: Array<{ code: number; out: string }>) {
  const calls: string[] = [];
  const git = async (_cwd: string, args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "diff") return { code: 0, out: diff };
    if (args[0] === "push") return pushes.shift() ?? { code: 0, out: "" };
    if (args[0] === "rev-parse") return { code: 0, out: "abc123\n" };
    return { code: 0, out: "" };
  };
  return { git, calls };
}

test("publishResearch: commits the report and the index, pushes HEAD to main, retries a rejected push", async () => {
  const files: Record<string, string> = { "docs/research/INDEX.md": INDEX };
  const { git, calls } = fakeGit("docs/research/c-9.md\ndocs/research/INDEX.md\n", [{ code: 1, out: "! [rejected] (fetch first)" }, { code: 0, out: "" }]);
  const sha = await publishResearch(git, "/wt", { id: "c-9", title: "Nine", text: "# Nine" }, [], async (p, t) => { files[p] = t; }, async (p) => files[p] ?? "");
  assert.equal(sha, "abc123");
  assert.equal(files["docs/research/c-9.md"], "# Nine\n");
  assert.match(files["docs/research/INDEX.md"]!, /\| c-9 \| Nine \|/);
  assert.equal(calls.filter((c) => c.startsWith("push")).length, 2);
  assert.ok(calls.every((c) => !c.includes("--force")));
});

test("publishResearch: refuses a commit that touches another path", async () => {
  const { git, calls } = fakeGit("docs/research/c-9.md\npackages/core/src/a.ts\n", []);
  await assert.rejects(publishResearch(git, "/wt", { id: "c-9", title: "Nine", text: "x" }, [], async () => {}, async () => ""), /only docs\/research/);
  assert.ok(!calls.some((c) => c.startsWith("push")));
});
