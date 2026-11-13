import { test } from "node:test";
import assert from "node:assert/strict";
import { checksState, cleanLog, compareUrl, GitHubApi, parsePrText } from "./github-pr.js";

test("checks: pending while any runs, failure if any failed, success otherwise", () => {
  assert.equal(checksState([]), "none");
  assert.equal(checksState([{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "success" }]), "pending");
  assert.equal(checksState([{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }]), "failure");
  assert.equal(checksState([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]), "success");
});

test("PR text, logs and the compare link", () => {
  assert.deepEqual(parsePrText('TITLE: "Fix login on Safari"\nBODY:\n- cookie flag\n- test'), { title: "Fix login on Safari", body: "- cookie flag\n- test" });
  assert.equal(cleanLog("2026-11-14T00:00:01.1234567Z \u001b[31merror\u001b[0m TS2322"), "error TS2322");
  assert.equal(compareUrl("me/app", "main", "kesher/x-1"), "https://github.com/me/app/compare/main...kesher%2Fx-1?expand=1");
});

test("GitHub API: finds the branch's open PR, opens one, reads failed logs", async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.github.com", "")}`);
    assert.equal(init?.headers?.authorization, "Bearer T");
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/pulls?head=")) return json([{ number: 7, html_url: "u", title: "t", state: "closed", merged_at: "x", head: { ref: "b", sha: "s1" }, base: { ref: "main" } }]);
    if (url.endsWith("/pulls") && init?.method === "POST") return json({ number: 8, html_url: "u8", title: JSON.parse(init.body!).title, state: "open", head: { ref: "b", sha: "s2" }, base: { ref: "main" } });
    if (url.includes("/runs/5/jobs")) return json({ jobs: [{ id: 9, name: "test", conclusion: "failure" }, { id: 10, name: "lint", conclusion: "success" }] });
    if (url.includes("/jobs/9/logs")) return new Response("2026-11-14T00:00:01.1Z boom\n");
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const gh = new GitHubApi(() => "T", fake);
  assert.equal((await gh.prFor("me/app", "b"))?.state, "merged");
  assert.equal((await gh.createPr("me/app", { head: "b", base: "main", title: "New", body: "" })).number, 8);
  assert.equal(await gh.failedLogs("me/app", 5), "## test\nboom\n");
  assert.ok(calls.includes("GET /repos/me/app/pulls?head=me%3Ab&state=all&per_page=5"));
  await assert.rejects(gh.defaultBranch("me/app"), /GitHub: .*404/);
});
