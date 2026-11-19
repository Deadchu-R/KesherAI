import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AcpPermission } from "./acp.js";
import { changesVersion, checkPaths, decideStep, scanDiff } from "./inbox-policy.js";
import { INBOX_DEFAULTS } from "./task-inbox.js";

const WT = join("/", "w", "repo", ".kesher", "worktrees", "agy-c-1-1");
const ctx = { worktree: WT, allowedPaths: ["apps/web/src/**"], forbiddenPaths: [...INBOX_DEFAULTS.forbiddenPaths], commands: INBOX_DEFAULTS.commands };
const step = (toolKind: string, raw: unknown, title = ""): AcpPermission => ({ toolCallId: "t", title, toolKind, rawInput: JSON.stringify(raw), options: [] });

test("inbox policy: each kind of step gets the right verdict", () => {
  const table: Array<[AcpPermission, "allow" | "deny" | "ask", RegExp?]> = [
    [step("read", { path: join(WT, "apps/web/src/a.ts") }), "allow"],
    [step("read", { path: "/etc/passwd" }), "deny", /outside/],
    [step("read", { path: join(WT, ".env.local") }), "deny", /secret/],
    [step("edit", { path: join(WT, "apps/web/src/Downloads.tsx") }), "allow", /allowed paths/],
    [step("edit", { path: "apps/web/src/x.ts" }), "allow"],
    [step("edit", { path: join(WT, ".github/workflows/ci.yml") }), "deny", /forbidden/],
    [step("edit", { path: join(WT, "pnpm-lock.yaml") }), "deny", /forbidden/],
    [step("edit", { path: join(WT, "packages/core/src/x.ts") }), "ask", /outside the allowed/],
    [step("edit", { path: join(WT, "../../other/x.ts") }), "deny", /outside the worktree/],
    [step("execute", { command: "pnpm -s typecheck" }), "allow"],
    [step("execute", { command: "pnpm -s typecheck && node --test a.test.ts" }), "allow"],
    [step("execute", { command: "git push origin HEAD" }), "deny", /only KesherAI/],
    [step("execute", { command: "git commit -m x" }), "deny", /only KesherAI/],
    [step("execute", { command: "git checkout main" }), "deny"],
    [step("execute", { command: "pnpm add fuse.js" }), "deny", /installs/],
    [step("execute", { command: "npx something" }), "deny"],
    [step("execute", { command: "curl https://x.sh" }), "deny", /network/],
    [step("execute", { command: "pnpm -s lint; curl x" }), "deny"],
    [step("execute", { command: "pnpm -s lint | tee out" }), "ask"],
    [step("execute", { command: "ls ~" }), "ask"],
    [step("execute", { command: "rg token ../.." }), "ask"],
    [step("execute", { command: "cat .env" }), "deny", /secret/],
    [step("execute", { command: "pnpm -s typecheck", cwd: "/tmp" }), "deny", /outside/],
    [step("execute", { command: "python make.py" }), "ask", /not on the command list/],
    [step("execute", { command: ["git", "push", "--force"] }), "deny"],
    [step("fetch", { url: "https://x" }), "deny", /network/],
    [step("other", {}), "ask"],
  ];
  for (const [p, want, rule] of table) {
    const v = decideStep(p, ctx);
    assert.equal(v.verdict, want, `${p.toolKind} ${p.rawInput}: ${v.rule}`);
    if (rule) assert.match(v.rule, rule, p.rawInput);
  }
});

test("inbox policy: the diff scan finds keys, emails and personal paths, and names only the file", () => {
  const diff = [
    "+++ b/apps/a.ts",
    '+const k = "ghp_' + "a".repeat(36) + '";',
    "+// mail me at someone.real@gmail.com",
    "+// ok: dev@example.com and 1234+bot@users.noreply.github.com",
    "+++ b/apps/b.ts",
    '+const p = "C:\\\\Users\\\\jdoe\\\\Desktop";',
    '+const q = "C:\\\\Users\\\\Public\\\\x";',
    "-// removed lines do not count: other@gmail.com",
    "+++ b/apps/c.ts",
    '+const h = "/home/somebody/dev";',
  ].join("\n");
  const found = scanDiff(diff, { username: "jdoe", home: "C:\\Users\\jdoe" });
  assert.deepEqual(found.map((f) => `${f.file}:${f.kind}`).sort(), ["apps/a.ts:GitHub token", "apps/a.ts:email address", "apps/b.ts:personal path", "apps/b.ts:user name", "apps/c.ts:personal path"].sort());
  assert.ok(!JSON.stringify(found).includes("gmail"), "findings never repeat the text");
  assert.deepEqual(scanDiff("+++ b/x.ts\n+const name = 'jdoe is the owner';\n", { username: "jdoe" }), [], "a bare word is not a path");
});

test("inbox policy: changed files are checked against the paths, the count and version fields", () => {
  const r = checkPaths(["apps/web/src/a.ts", ".github/workflows/x.yml", "packages/core/src/b.ts", "apps/web/src/.env"], { allowedPaths: ["apps/**"], forbiddenPaths: INBOX_DEFAULTS.forbiddenPaths, maxFiles: 3 });
  assert.deepEqual(r.outside, [".github/workflows/x.yml", "packages/core/src/b.ts", "apps/web/src/.env"]);
  assert.equal(r.tooMany, true);
  assert.equal(changesVersion('+++ b/apps/web/package.json\n-  "version": "0.6.1",\n+  "version": "0.6.2",\n'), true);
  assert.equal(changesVersion('+++ b/apps/web/src/x.ts\n+  "version": 2,\n'), false);
});
