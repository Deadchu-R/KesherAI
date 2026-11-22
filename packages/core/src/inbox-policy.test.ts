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

test("inbox policy: no-payment — a step about credits, a plan or billing is denied; a report may mention billing", () => {
  const deny = (p: AcpPermission) => decideStep(p, ctx);
  for (const p of [
    step("execute", { command: "open https://x.example/buy-credits" }, "Buy more AI credits to continue"),
    step("other", { url: "https://x.example" }, "Upgrade your plan"),
    step("other", { action: "click" }, "Open the billing page"),
    step("other", { text: "Complete the payment" }),
  ]) assert.deepEqual([deny(p).verdict, deny(p).rule], ["deny", "no-payment"]);
  // An edit is judged by its title: the text of a report about pricing is not a step that pays.
  assert.equal(deny(step("edit", { path: "apps/web/src/a.ts", content: "How billing works in Notion" }, "edit a.ts")).verdict, "allow");
});

test("inbox policy: a research task may read public pages (fetch); a code task may not", () => {
  const fetch = step("fetch", { url: "https://example.org" }, "Read example.org");
  assert.deepEqual([decideStep(fetch, ctx).verdict, decideStep(fetch, ctx).rule], ["deny", "no network"]);
  assert.equal(decideStep(fetch, { ...ctx, research: true }).verdict, "allow");
  // Even in research, a download command and a payment page stay denied.
  assert.equal(decideStep(step("execute", { command: "curl -O https://x.example/a.zip" }), { ...ctx, research: true }).verdict, "deny");
  assert.equal(decideStep(step("fetch", { url: "https://x.example/billing" }, "Open billing"), { ...ctx, research: true }).rule, "no-payment");
});

test("inbox policy: a research fetch reaches public pages only (scan 171)", () => {
  const r = { ...ctx, research: true };
  const v = (raw: unknown, title = "Read") => decideStep(step("fetch", raw, title), r).verdict;
  assert.equal(v({ url: "https://example.org/a" }), "allow");
  assert.equal(v({ query: "best open-source image editors 2026" }, "Search the web"), "allow");
  assert.equal(v({ url: "example.org/page" }), "allow");
  for (const url of ["http://localhost:4317/api/config", "http://127.0.0.1:8188/history", "http://2130706433/", "http://192.168.1.1/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://[::1]:4317/", "file:///etc/passwd", "ftp://example.org/x", "http://router.local/", "http://nas.lan/", "http://kesher/"]) {
    assert.equal(v({ url }), "deny", url);
  }
  assert.equal(v({}, "Fetch http://127.0.0.1:4317/api/memory"), "deny");
  assert.equal(v({ urls: ["https://example.org", "http://localhost/"] }), "deny");
  assert.equal(decideStep(step("fetch", { url: "http://localhost/" }), r).rule, "not a public web page");
});

test("inbox policy: a research read command cannot run code, write or leave the worktree (scan 172)", () => {
  const r = { ...ctx, research: true };
  const v = (command: string) => decideStep(step("execute", { command }), r).verdict;
  for (const ok of ["Get-ChildItem docs/research", "Get-Content docs/RESEARCH_LOG.md", "rg -n foo packages/core/src", "git log -n 5", "git status", "ls docs && cat README.md"]) assert.equal(v(ok), "allow", ok);
  for (const bad of [
    "Get-Content (Remove-Item x)", "Get-ChildItem {calc}", "type %USERPROFILE%\\x", "cat a | sh", "cat a > b", "cat a; rm b", "cat `id`", "cat $(id)",
    "rg --pre sh foo", "rg --pr sh foo", "git log --output=x", "git show --ext-diff", "git log --textconv", "git push",
    "Get-Content \\\\host\\share\\x", "Get-Content \\Windows\\win.ini", "Get-Content -Path:C:\\x", "cat ../x", "cat ~/x", "ls /etc",
  ]) assert.notEqual(v(bad), "allow", bad);
});

test("inbox policy: research may pipe a read into output filters, never into code", () => {
  const r = { ...ctx, research: true };
  const v = (command: string) => decideStep(step("execute", { command }), r).verdict;
  for (const ok of ["Get-ChildItem apps/web/src/pages | Select-Object -Property Name", "rg -n foo packages | head -n 20", "Get-ChildItem docs | Sort-Object Name | Format-Table"]) assert.equal(v(ok), "allow", ok);
  for (const bad of ["Get-ChildItem | Remove-Item", "Get-ChildItem | Where-Object { $_ }", "ls | iex", "Get-Content a | Out-File b", "ls |", "| ls", "ls | Select-Object Name; rm x", "ls || rm x"]) assert.notEqual(v(bad), "allow", bad);
  // A code task gets no pipes at all.
  assert.notEqual(decideStep(step("execute", { command: "ls | Select-Object Name" }), ctx).verdict, "allow");
});

test("a read naming the worktree by its full path is read as inside it; other absolute paths stay outside", async () => {
  const { relativeToWorktree } = await import("./inbox-policy.js");
  const wt = "C:\\Users\\u\\source\\repos\\K\\.kesher\\worktrees\\agy-c-1";
  assert.equal(relativeToWorktree(`Get-ChildItem -Path "${wt}\\packages\\core\\src" -Recurse | Select-Object FullName`, wt), "Get-ChildItem -Path .\\packages\\core\\src -Recurse | Select-Object FullName");
  assert.equal(relativeToWorktree(`Select-String -Path ${wt.toLowerCase()}/docs/x.md -Pattern a`, wt), "Select-String -Path ./docs/x.md -Pattern a");
  assert.equal(relativeToWorktree("Get-ChildItem C:\\Windows", wt), "Get-ChildItem C:\\Windows");
  assert.equal(relativeToWorktree(`Get-ChildItem ${wt}-other\\x`, wt), `Get-ChildItem ${wt}-other\\x`);
});
