import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlLog, actionClassOf, decideControl, effectiveMode, hostMatches, isLocalSite, sensitiveKind, sitesInText, type PolicyCall, type PolicySettings } from "./control-policy.js";

const base: PolicySettings = { mode: "manual", helperMode: "manual", skipAllowed: false, js: "ask", sensitive: [], blocked: [], helperAlways: false };
const call = (c: Partial<PolicyCall>): PolicyCall => ({ kind: "browser", tool: "browser_click", action: "act", site: "shop.example", always: false, taskSites: [], ...c });

/** Each row: what is asked, under which settings, and the expected action, tag and whether "Always" is hidden. */
const rows: Array<{ name: string; c: Partial<PolicyCall>; s?: Partial<PolicySettings>; action: string; why: string; noAlways: boolean }> = [
  { name: "manual chat click asks, Always offered", c: {}, action: "ask", why: "manual", noAlways: false },
  { name: "manual chat with Always on the site runs", c: { always: true }, action: "allow", why: "always", noAlways: false },
  { name: "reading runs in manual", c: { tool: "browser_snapshot", action: "read" }, action: "allow", why: "read", noAlways: false },
  { name: "auto chat goes to the reviewer", c: {}, s: { mode: "auto" }, action: "review", why: "review", noAlways: false },
  { name: "skip without the owner's yes is manual", c: {}, s: { mode: "skip" }, action: "ask", why: "manual", noAlways: false },
  { name: "skip with the owner's yes runs", c: {}, s: { mode: "skip", skipAllowed: true }, action: "allow", why: "skip", noAlways: false },
  { name: "skip never covers computer control (auto)", c: { kind: "computer", tool: "computer_click", site: undefined, app: "notepad" }, s: { mode: "skip", skipAllowed: true }, action: "review", why: "review", noAlways: false },
  { name: "helper is manual even when the chat skips", c: { helper: "Researcher" }, s: { mode: "skip", skipAllowed: true }, action: "ask", why: "manual", noAlways: true },
  { name: "helper with Always on the site still asks (setting off)", c: { helper: "Researcher", always: true }, action: "ask", why: "manual", noAlways: true },
  { name: "helper with Always and the setting on runs", c: { helper: "Researcher", always: true }, s: { helperAlways: true }, action: "allow", why: "always", noAlways: false },
  { name: "helper in auto goes to the reviewer", c: { helper: "Researcher" }, s: { helperMode: "auto" }, action: "review", why: "review", noAlways: true },
  { name: "bank asks in skip, no Always", c: { site: "online.leumi.co.il", always: true }, s: { mode: "skip", skipAllowed: true }, action: "ask", why: "sensitive", noAlways: true },
  { name: "webmail asks even to read", c: { site: "mail.google.com", tool: "browser_snapshot", action: "read" }, action: "ask", why: "sensitive", noAlways: true },
  { name: "government domain asks", c: { site: "www.gov.il" }, s: { mode: "auto" }, action: "ask", why: "sensitive", noAlways: true },
  { name: "account settings path asks", c: { site: "github.com", url: "https://github.com/settings/security" }, s: { mode: "skip", skipAllowed: true }, action: "ask", why: "sensitive", noAlways: true },
  { name: "checkout path asks", c: { site: "shop.example", url: "https://shop.example/checkout?step=2", always: true }, action: "ask", why: "sensitive", noAlways: true },
  { name: "the user's own sensitive site asks", c: { site: "portal.mycorp.example" }, s: { mode: "skip", skipAllowed: true, sensitive: ["mycorp.example"] }, action: "ask", why: "sensitive", noAlways: true },
  { name: "blocked site is refused, even reading", c: { site: "ads.tracker.example", action: "read" }, s: { blocked: ["tracker.example"] }, action: "deny", why: "blocked", noAlways: true },
  { name: "plan mode refuses acting", c: { plan: true }, action: "deny", why: "plan", noAlways: true },
  { name: "plan mode still reads", c: { plan: true, action: "read" }, action: "allow", why: "read", noAlways: false },
  { name: "JS off is refused", c: { tool: "browser_eval", action: "eval" }, s: { js: "off" }, action: "deny", why: "js", noAlways: true },
  { name: "JS ask asks even with Always", c: { tool: "browser_eval", action: "eval", always: true }, s: { mode: "skip", skipAllowed: true }, action: "ask", why: "js", noAlways: true },
  { name: "JS local on a dev server follows the mode", c: { tool: "browser_eval", action: "eval", site: "localhost:5173" }, s: { js: "local", mode: "skip", skipAllowed: true }, action: "allow", why: "skip", noAlways: false },
  { name: "JS local elsewhere asks", c: { tool: "browser_eval", action: "eval" }, s: { js: "local", mode: "skip", skipAllowed: true }, action: "ask", why: "js", noAlways: true },
  { name: "the tool's always-ask wins over skip", c: { tool: "browser_upload", mustAsk: "Uploads a file." }, s: { mode: "skip", skipAllowed: true }, action: "ask", why: "always-ask", noAlways: true },
  { name: "leaving the task's sites asks in skip", c: { site: "other.example", taskSites: ["shop.example"] }, s: { mode: "skip", skipAllowed: true }, action: "ask", why: "origin", noAlways: false },
  { name: "a subdomain of a task site is inside", c: { site: "cdn.shop.example", taskSites: ["shop.example"] }, s: { mode: "skip", skipAllowed: true }, action: "allow", why: "skip", noAlways: false },
  { name: "Always on a site outside the task passes the gate", c: { site: "other.example", taskSites: ["shop.example"], always: true }, action: "allow", why: "always", noAlways: false },
  { name: "navigating out of the task's sites asks", c: { tool: "browser_open", action: "navigate", site: "evil.example", taskSites: ["shop.example"] }, s: { mode: "auto" }, action: "ask", why: "origin", noAlways: false },
  { name: "localhost is never outside the task", c: { site: "localhost:3000", taskSites: ["shop.example"] }, s: { mode: "skip", skipAllowed: true }, action: "allow", why: "skip", noAlways: false },
  { name: "computer: an allowed app runs in manual", c: { kind: "computer", tool: "computer_click", site: undefined, app: "notepad", always: true }, action: "allow", why: "always", noAlways: false },
  { name: "computer: a new app asks in manual", c: { kind: "computer", tool: "computer_click", site: undefined, app: "notepad" }, action: "ask", why: "manual", noAlways: false },
];

for (const r of rows)
  test(`control policy: ${r.name}`, () => {
    const d = decideControl(call(r.c), { ...base, ...r.s });
    assert.equal(d.action, r.action, d.reason);
    assert.equal(d.why[0], r.why);
    assert.equal(d.noAlways, r.noAlways);
    assert.ok(d.reason.length > 5);
  });

test("control policy: sensitive kinds, local sites and host matching", () => {
  assert.equal(sensitiveKind("www.paypal.com"), "payment");
  assert.equal(sensitiveKind("outlook.office.com"), "email");
  assert.equal(sensitiveKind("accounts.google.com"), "account");
  assert.equal(sensitiveKind("myonlinebank.example"), undefined, "a word inside a name is not enough");
  assert.equal(sensitiveKind("online-bank.example"), "bank");
  assert.equal(sensitiveKind("irs.gov"), "government");
  assert.equal(sensitiveKind("docs.example.com", "https://docs.example.com/guide"), undefined);
  assert.equal(sensitiveKind("localhost:5173", "http://localhost:5173/checkout"), undefined, "a local dev server's checkout is a test");
  assert.ok(isLocalSite("127.0.0.1:8080") && isLocalSite("app.localhost") && !isLocalSite("example.com"));
  assert.ok(hostMatches("a.b.example.com", "example.com") && hostMatches("example.com", "*.example.com") && !hostMatches("badexample.com", "example.com"));
});

test("control policy: action classes and modes", () => {
  assert.equal(actionClassOf("browser_snapshot"), "read");
  assert.equal(actionClassOf("browser_open", { url: "https://x.example" }), "navigate");
  assert.equal(actionClassOf("browser_navigate", { action: "back" }), "navigate");
  assert.equal(actionClassOf("browser_eval"), "eval");
  assert.equal(actionClassOf("browser_click", { ref: "e1" }), "act");
  assert.equal(actionClassOf("computer_tree"), "read");
  assert.equal(actionClassOf("computer_invoke", { ref: "u3" }), "act");
  assert.equal(effectiveMode({ mode: "skip", helperMode: "auto", skipAllowed: true }, "browser", true), "auto");
});

test("control policy: the task's sites come from what the user wrote, not file names", () => {
  assert.deepEqual(sitesInText(["Order on https://www.shop.example/cart and check docs.example.com.", "fix main.ts and report.pdf", "open localhost:5173"]), ["shop.example", "docs.example.com", "localhost"]);
});

test("control policy: the decision log keeps the newest 500 and filters by chat", () => {
  const log = new ControlLog();
  for (let i = 0; i < 510; i++) log.add({ chatId: i % 2 ? "a" : "b", kind: "browser", tool: "browser_click", decision: "allow", by: "user" });
  assert.equal(log.last(1000).length, 500);
  assert.ok(log.last(1000, "a").every((d) => d.chatId === "a"));
});
