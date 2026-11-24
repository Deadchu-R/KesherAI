import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { checkClaude, claudeArgs, claudeEnv, findClaude, mergeClaudeLimit, parseClaudeLine, readClaudeQuota, runClaude, usageLimitOf, writeClaudeSettings, type ClaudeEvent } from "./claude-exec.js";
import { claudeQuotaBlock } from "@kesher/shared";

/**
 * Claude Code as an executor (claude-exec.ts): the stream-json parser on recorded lines, the usage-limit text, finding
 * the program on Windows and elsewhere, the safe arguments and environment, the status-line quota file, and a whole
 * run against a fake `claude` (a Node script that answers stream-json on stdin like the real one).
 */

/** Lines in the shape `claude -p --output-format stream-json --verbose` prints (2.1.x). */
const RUN_LINES = [
  { type: "system", subtype: "init", cwd: "/w", session_id: "s1", tools: ["Read", "Edit", "Bash"], model: "claude-sonnet-4-5", permissionMode: "acceptEdits" },
  { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "I'll read the file." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "apps/a.ts" } }] }, session_id: "s1" },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "export const a = 1;" }] } },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1795000000, rateLimitType: "five_hour", utilization: 0.82 } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "apps/a.ts", old_string: "1", new_string: "2" } }] } },
  { type: "result", subtype: "success", is_error: false, duration_ms: 1000, num_turns: 3, result: "Changed apps/a.ts.", session_id: "s1", total_cost_usd: 0.01 },
];

test("parseClaudeLine: init, steps, text, rate limit and result; junk is ignored", () => {
  const all = RUN_LINES.flatMap((l) => parseClaudeLine(JSON.stringify(l)));
  assert.deepEqual(all[0], { kind: "init", model: "claude-sonnet-4-5" });
  assert.deepEqual(all.filter((e) => e.kind === "step").map((e) => (e as Extract<ClaudeEvent, { kind: "step" }>).step.tool), ["Read", "Edit"]);
  assert.ok(all.some((e) => e.kind === "text" && e.text === "I'll read the file."));
  const lim = all.find((e) => e.kind === "limit") as Extract<ClaudeEvent, { kind: "limit" }>;
  assert.equal(lim.window, "five_hour");
  assert.equal(Math.round(lim.used!), 82);
  assert.equal(lim.resetsAt, 1795000000 * 1000, "seconds become milliseconds");
  assert.deepEqual(all.at(-1), { kind: "result", ok: true, text: "Changed apps/a.ts.", subtype: "success" });
  assert.deepEqual(parseClaudeLine("not json"), []);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }))[0], { kind: "result", ok: false, text: "", subtype: "error_max_turns" });
  // A reset already in milliseconds stays.
  assert.equal((parseClaudeLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { resetsAt: 1795000000000 } }))[0] as { resetsAt: number }).resetsAt, 1795000000000);
});

test("usageLimitOf: the limit messages, with the reset when the message has one", () => {
  assert.deepEqual(usageLimitOf("Claude AI usage limit reached|1795003600"), { until: 1795003600 * 1000 });
  assert.deepEqual(usageLimitOf("You've hit your limit · resets 3pm (Asia/Jerusalem)"), {});
  assert.deepEqual(usageLimitOf("5-hour limit reached ∙ resets 9pm"), {});
  assert.equal(usageLimitOf("Error: tests failed"), undefined);
  assert.equal(usageLimitOf("Changed the rate limit handling in api.ts"), undefined);
});

test("findClaude: the native install first, an npm shim through its cli.js, nothing when missing (Windows and elsewhere)", () => {
  const home = win32.join("C:", "Users", "u");
  const native = win32.join(home, ".local", "bin", "claude.exe");
  assert.deepEqual(findClaude({ platform: "win32", env: { USERPROFILE: home, PATH: "C:\\Windows" }, home, exists: (p) => p === native }), { program: native, pre: [] });
  const npm = win32.join("C:", "npm");
  const cli = win32.join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  const shim = findClaude({ platform: "win32", env: { USERPROFILE: home, PATH: `C:\\Windows;"${npm}"` }, home, node: "node.exe", exists: (p) => p === win32.join(npm, "claude.cmd") || p === cli });
  assert.deepEqual(shim, { program: "node.exe", pre: [cli] }, "never cmd.exe");
  assert.equal(findClaude({ platform: "win32", env: { PATH: "C:\\Windows" }, home, exists: () => false }), undefined);
  const local = posix.join("/home/u", ".local", "bin", "claude");
  assert.deepEqual(findClaude({ platform: "linux", env: { PATH: "/usr/bin" }, home: "/home/u", exists: (p) => p === local }), { program: local, pre: [] });
  assert.deepEqual(findClaude({ platform: "darwin", env: { PATH: "/usr/bin" }, home: "/Users/u", exists: (p) => p === "/opt/homebrew/bin/claude" }), { program: "/opt/homebrew/bin/claude", pre: [] });
});

test("claudeEnv: no API key or other billing route reaches the run; Electron runs as Node", () => {
  const env = claudeEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "y", ANTHROPIC_BASE_URL: "z", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1" }, true);
  assert.deepEqual(env, { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(claudeEnv({ PATH: "/bin" }, false).ELECTRON_RUN_AS_NODE, undefined);
});

test("claudeArgs: headless stream-json, edits only, the allowed commands only, never skip-permissions", () => {
  const a = claudeArgs({ settings: "/d/settings.json", commands: ["pnpm -s typecheck", "bad; rm -rf /"], model: "sonnet" });
  assert.ok(a.includes("-p") && a.includes("--verbose"));
  assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
  assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
  assert.equal(a[a.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "project", "the user's own settings and hooks are not loaded");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(a.includes("Bash(pnpm -s typecheck:*)"));
  assert.ok(!a.some((x) => x.includes("rm -rf")), "a command with shell characters is dropped");
  assert.ok(a.includes("Bash(git push:*)") && a.indexOf("Bash(git push:*)") > a.indexOf("--disallowedTools"));
  assert.ok(!a.some((x) => /dangerously|bypassPermissions/.test(x)));
  assert.deepEqual(a.slice(-2), ["--model", "sonnet"]);
  assert.ok(!claudeArgs({ settings: "s", commands: [] }).includes("--model"));
});

test("the status-line script writes only rate_limits to the quota file KesherAI reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-claude-"));
  const f = await writeClaudeSettings(dir, process.execPath);
  const settings = JSON.parse(readFileSync(f.settings, "utf8")) as { statusLine: { type: string; command: string } };
  assert.equal(settings.statusLine.type, "command");
  assert.ok(!settings.statusLine.command.includes("\\"), "forward slashes only");
  const input = JSON.stringify({ model: { display_name: "Opus" }, cwd: "/secret/path", rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1795000000 }, seven_day: { used_percentage: 41.2, resets_at: 1795400000 } } });
  const r = spawnSync(process.execPath, [join(dir, "statusline.cjs"), f.quota], { input, encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "KesherAI");
  assert.ok(!readFileSync(f.quota, "utf8").includes("/secret/path"));
  const q = await readClaudeQuota(f.quota);
  assert.deepEqual(q?.fiveHour, { usedPercentage: 23.5, resetsAt: 1795000000 * 1000 });
  assert.deepEqual(q?.sevenDay, { usedPercentage: 41.2, resetsAt: 1795400000 * 1000 });
  // No rate_limits (an API key, or before the first answer): the file is left as it was.
  spawnSync(process.execPath, [join(dir, "statusline.cjs"), f.quota], { input: JSON.stringify({ model: {} }), encoding: "utf8" });
  assert.deepEqual((await readClaudeQuota(f.quota))?.fiveHour, q?.fiveHour);
  // A stream event updates its own window and keeps the other.
  const next = await mergeClaudeLimit(f.quota, { kind: "limit", window: "five_hour", used: 90, resetsAt: 1795000500000 }, 5);
  assert.deepEqual(next?.fiveHour, { usedPercentage: 90, resetsAt: 1795000500000 });
  assert.deepEqual(next?.sevenDay, q?.sevenDay);
  assert.equal(await readClaudeQuota(join(dir, "none.json")), undefined);
});

test("claudeQuotaBlock: the thresholds, a reset window and an unknown one", () => {
  const s = { fiveHourMax: 80, weekMax: 85 };
  assert.equal(claudeQuotaBlock(undefined, s, 0), undefined, "unknown never blocks");
  assert.deepEqual(claudeQuotaBlock({ fiveHour: { usedPercentage: 80, resetsAt: 100 }, at: 0 }, s, 50), { window: "five_hour", used: 80, until: 100 });
  assert.equal(claudeQuotaBlock({ fiveHour: { usedPercentage: 95, resetsAt: 100 }, at: 0 }, s, 100), undefined, "it reset");
  assert.equal(claudeQuotaBlock({ fiveHour: { usedPercentage: 79, resetsAt: 100 }, sevenDay: { usedPercentage: 84, resetsAt: 900 }, at: 0 }, s, 50), undefined);
  assert.equal(claudeQuotaBlock({ fiveHour: { usedPercentage: 90, resetsAt: 100 }, sevenDay: { usedPercentage: 90, resetsAt: 900 }, at: 0 }, s, 50)?.until, 900, "the week's reset wins");
});

/** A fake `claude`: records its arguments, answers each stream-json user message (the first with the recorded lines). */
const FAKE_CLI = `
const fs = require("fs");
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
const lines = JSON.parse(fs.readFileSync(process.env.FAKE_LINES, "utf8"));
let n = 0, buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const text = msg.message.content[0].text;
    if (n++ === 0) {
      for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
      if (process.env.FAKE_HANG) continue;
    } else {
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hint: " + text }) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(process.env.FAKE_CODE ? Number(process.env.FAKE_CODE) : 0));
`;

function fake(lines: unknown[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kesher-fakeclaude-"));
  writeFileSync(join(dir, "claude.cjs"), FAKE_CLI);
  writeFileSync(join(dir, "lines.json"), JSON.stringify(lines));
  return { cli: { program: process.execPath, pre: [join(dir, "claude.cjs")] }, env: { ...process.env, FAKE_ARGS: join(dir, "args.json"), FAKE_LINES: join(dir, "lines.json"), ...env }, args: join(dir, "args.json"), dir };
}

test("runClaude with a fake CLI: the prompt on stdin, every event in order, ends by itself after the result", async () => {
  const f = fake(RUN_LINES);
  const events: ClaudeEvent[] = [];
  const end = await runClaude({ cli: f.cli, cwd: f.dir, args: ["-p", "--x"], prompt: "Do the task", env: f.env, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  assert.equal(end.code, 0);
  assert.deepEqual(end.result, { ok: true, text: "Changed apps/a.ts.", subtype: "success" });
  assert.equal(end.limit, undefined);
  assert.deepEqual(JSON.parse(readFileSync(f.args, "utf8")), ["-p", "--x"], "the prompt is not on the command line");
  assert.deepEqual(events.map((e) => e.kind), ["init", "text", "step", "limit", "step", "result"]);
});

test("runClaude: a usage-limit result is reported with its reset", async () => {
  const f = fake([RUN_LINES[0], { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1795003600" }]);
  const end = await runClaude({ cli: f.cli, cwd: f.dir, args: [], prompt: "p", env: f.env, signal: new AbortController().signal, onEvent: () => undefined });
  assert.deepEqual(end.limit, { until: 1795003600 * 1000 });
  assert.equal(end.result?.ok, false);
});

test("runClaude: a rejected rate-limit event counts as the limit even when the text says nothing", async () => {
  const f = fake([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1795007200, rateLimitType: "seven_day" } }, { type: "result", subtype: "success", is_error: true, result: "" }]);
  const end = await runClaude({ cli: f.cli, cwd: f.dir, args: [], prompt: "p", env: f.env, signal: new AbortController().signal, onEvent: () => undefined });
  assert.deepEqual(end.limit, { until: 1795007200 * 1000 });
});

test("runClaude: a hint sent while it works gets its own answer before stdin closes; abort ends a hung run", async () => {
  // The first message's result comes only after the hint is in (FAKE_HANG holds it): both get their result.
  const f = fake(RUN_LINES.slice(0, 2), { FAKE_HANG: "1" });
  let send!: (t: string) => Promise<void>;
  const ctl = new AbortController();
  const texts: string[] = [];
  const p = runClaude({ cli: f.cli, cwd: f.dir, args: [], prompt: "p", env: f.env, signal: ctl.signal, attach: (fn) => (send = fn), onEvent: (e) => e.kind === "result" && texts.push(e.text) });
  await send("Try the other file.");
  for (let i = 0; i < 100 && !texts.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(texts, ["hint: Try the other file."]);
  ctl.abort();
  const end = await p;
  assert.notEqual(end.code, 0);
});

test("checkClaude: the version and the login from Claude Code's own answers; an API key is told apart", async () => {
  const run = (auth: unknown) => async (args: string[]) => (args[0] === "--version" ? { code: 0, out: "2.1.331 (Claude Code)\n" } : { code: 0, out: JSON.stringify(auth) });
  assert.deepEqual(await checkClaude(run({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })), { installed: true, version: "2.1.331", loggedIn: true, account: "subscription", plan: "max" });
  assert.equal((await checkClaude(run({ loggedIn: true, authMethod: "api_key" }))).account, "api-key");
  assert.deepEqual(await checkClaude(run({ loggedIn: false, authMethod: "none" })), { installed: true, version: "2.1.331", loggedIn: false, account: "none" });
  assert.deepEqual(await checkClaude(async () => ({ code: -1, out: "" })), { installed: false });
});
