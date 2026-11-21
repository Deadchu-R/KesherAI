import { test } from "node:test";
import assert from "node:assert/strict";
import { activeGrants, alwaysAsks, grantFor, grantTool, targetOf, withGrant, type GrantRequest, type GrantRule } from "./approval-grants.js";
import { ruleAllows, targetMatches, toolMatches } from "./approval-rules.js";

const NOW = Date.parse("2026-11-21T10:00:00Z");

test("toolMatches: names, families, any, helpers kept apart", () => {
  const rows: Array<[string, string, boolean]> = [
    ["run_command", "run_command", true],
    ["run_command", "write_file", false],
    ["browser_*", "browser_click", true],
    ["browser_*", "computer_click", false],
    ["*", "write_file", true],
    ["*", "helper:write_file", false],
    ["helper:*", "helper:write_file", true],
    ["helper:*", "write_file", false],
    ["helper:browser_*", "helper:browser_type", true],
    ["write_file", "helper:write_file", false],
  ];
  for (const [rule, call, want] of rows) assert.equal(toolMatches(rule, call), want, `${rule} vs ${call}`);
});

test("targetMatches: folders, sites, apps", () => {
  const rows: Array<[string | undefined, string | undefined, boolean]> = [
    [undefined, undefined, true],
    [undefined, "folder:/p/src", true],
    ["folder:/p/src", undefined, false],
    ["folder:/p/src", "folder:/p/src", true],
    ["folder:/p/src", "folder:/p/src/ui", true],
    ["folder:/p/src", "folder:/p/srcx", false],
    ["folder:/p/src", "folder:/p/src/../etc", false],
    ["folder:C:\\work\\proj", "folder:c:/work/proj/apps", true],
    ["folder:/", "folder:/anything", true],
    ["site:example.com", "site:example.com", true],
    ["site:example.com", "site:docs.example.com", true],
    ["site:example.com", "site:badexample.com", false],
    ["site:example.com", "folder:/example.com", false],
    ["app:unity", "app:Unity", true],
    ["app:unity", "app:unity hub", false],
  ];
  for (const [p, v, want] of rows) assert.equal(targetMatches(p, v), want, `${p} vs ${v}`);
});

test("targetOf: site, app and the folder of a written file", () => {
  assert.equal(targetOf("browser_click", {}, "site:github.com"), "site:github.com");
  assert.equal(targetOf("computer_use_app", { app: "Unity" }), "app:unity");
  assert.equal(targetOf("write_file", { path: "/p/src/a.ts" }), "folder:/p/src");
  assert.equal(targetOf("edit_file", { path: "C:\\p\\b.ts" }), "folder:C:/p");
  assert.equal(targetOf("write_file", { path: "a.ts" }), "folder:.");
  assert.equal(targetOf("write_file", { path: "../x/a.ts" }), undefined);
  assert.equal(targetOf("run_command", { command: "ls" }), undefined);
});

test("alwaysAsks: dangerous, guests, noAlways, deletes; plain steps may be granted", () => {
  const base = { input: {}, reason: "The agent wants to change a file." };
  const rows: Array<[Partial<GrantRequest> & { name: string }, boolean]> = [
    [{ name: "write_file" }, false],
    [{ name: "run_command", reason: "This command deletes files recursively or forcefully, so it always needs your approval." }, true],
    [{ name: "write_file", reason: "Dana #81c0 (a guest) asked for this. Guests' actions always need your yes." }, true],
    [{ name: "browser_type", scope: "site:bank.example", noAlways: true }, true],
    [{ name: "delete_file" }, true],
    [{ name: "helper:delete_file" }, true],
  ];
  for (const [r, want] of rows) assert.equal(!!alwaysAsks({ ...base, ...r }), want, r.name);
});

test("grantFor: each choice, its scope and its end", () => {
  const r: GrantRequest = { name: "write_file", input: { path: "/p/src/a.ts" }, reason: "x" };
  const o = { conversationId: "c1", now: NOW };
  assert.equal(grantFor(r, { ...o, choice: "once" }), undefined);
  const chat = grantFor(r, { ...o, choice: "chat" })!;
  assert.deepEqual([chat.scope, chat.conversationId, chat.until, chat.target], ["conversation", "c1", undefined, "folder:/p/src"]);
  const hour = grantFor(r, { ...o, choice: "hour" })!;
  assert.equal(Date.parse(hour.until!) - NOW, 3_600_000);
  const revoke = grantFor(r, { ...o, choice: "revoke" })!;
  assert.deepEqual([revoke.scope, revoke.conversationId, revoke.until], ["everywhere", undefined, undefined]);
});

test("grantFor: helpers are stricter, always-ask steps get nothing, sites cover the browser family", () => {
  const helper: GrantRequest = { name: "run_command", input: { command: "pnpm test" }, reason: "x", helper: { title: "h" } };
  const g = grantFor(helper, { choice: "revoke", conversationId: "c1", now: NOW, command: "pnpm test" })!;
  assert.deepEqual([g.tool, g.scope, g.conversationId, g.command], ["helper:run_command", "conversation", "c1", "pnpm test"]);
  const danger: GrantRequest = { name: "run_command", input: {}, reason: "This command shuts the computer down, so it always needs your approval." };
  assert.equal(grantFor(danger, { choice: "revoke", conversationId: "c1", now: NOW }), undefined);
  assert.equal(grantTool({ name: "browser_click", scope: "site:github.com" }), "browser_*");
  const site = grantFor({ name: "browser_click", input: {}, reason: "x", scope: "site:github.com" }, { choice: "hour", conversationId: "c1", now: NOW })!;
  assert.equal(ruleAllows(site, { tool: "browser_type", modelId: "m", conversationId: "c1", target: "site:github.com" }, NOW + 1000), true);
  assert.equal(ruleAllows(site, { tool: "browser_type", modelId: "m", conversationId: "c1", target: "site:gitlab.com" }, NOW + 1000), false);
  assert.equal(ruleAllows(site, { tool: "browser_type", modelId: "m", conversationId: "c1", target: "site:github.com" }, NOW + 3_600_001), false, "ended");
});

test("grants match by chat, kind and expiry", () => {
  const rule = grantFor({ name: "write_file", input: { path: "/p/src/a.ts" }, reason: "x" }, { choice: "hour", conversationId: "c1", now: NOW })!;
  const call = { tool: "write_file", modelId: "m", conversationId: "c1", target: "folder:/p/src/ui" };
  const rows: Array<[Partial<typeof call>, number, boolean, string]> = [
    [{}, NOW + 1, true, "inside the folder, in time"],
    [{ conversationId: "c2" }, NOW + 1, false, "another chat"],
    [{ tool: "helper:write_file" }, NOW + 1, false, "a helper"],
    [{ target: "folder:/other" }, NOW + 1, false, "another folder"],
    [{}, NOW + 3_600_000, false, "the hour ended"],
  ];
  for (const [c, at, want, why] of rows) assert.equal(ruleAllows(rule, { ...call, ...c }, at), want, why);
});

test("withGrant replaces the same grant and drops ended ones; activeGrants lists time left", () => {
  const a: GrantRule = { tool: "write_file", scope: "conversation", conversationId: "c1", target: "folder:/p" };
  const ended: GrantRule = { tool: "run_command", scope: "everywhere", until: new Date(NOW - 1).toISOString() };
  const hour: GrantRule = { ...a, until: new Date(NOW + 60_000).toISOString() };
  const list = withGrant([a, ended], hour, NOW);
  assert.deepEqual(list, [hour]);
  const helper: GrantRule = { tool: "helper:run_command", scope: "conversation", conversationId: "c1" };
  const active = activeGrants([...list, ended, helper], NOW);
  assert.deepEqual(active.map((g) => [g.index, g.kind, g.leftMs]), [[0, "chat", 60_000], [2, "helper", undefined]]);
});

test("a command grant is a start of the command asked about, never another one (scan 171)", () => {
  const r = { name: "run_command", input: { command: "pnpm  -s test" }, reason: "Runs a command." };
  const o = { choice: "chat" as const, conversationId: "c1", now: 0 };
  assert.equal(grantFor(r, { ...o, command: "pnpm" })?.command, "pnpm");
  assert.equal(grantFor(r, { ...o, command: "pnpm -s test" })?.command, "pnpm -s test");
  assert.equal(grantFor(r, { ...o, command: "rm" })?.command, "pnpm -s test");
  assert.equal(grantFor(r, { ...o, command: "pn" })?.command, "pnpm -s test");
});
