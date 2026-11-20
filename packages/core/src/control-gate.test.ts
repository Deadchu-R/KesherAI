import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, GateInfo } from "@kesher/agent";
import { gateControlTools, withControlInfo, type ControlGateDeps } from "./control-gate.js";
import { ControlLog, type PolicySettings } from "./control-policy.js";

const settings: PolicySettings = { mode: "manual", helperMode: "manual", skipAllowed: false, js: "ask", sensitive: [], blocked: [], helperAlways: false };
const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
const info = (g: Partial<GateInfo> = {}): GateInfo => ({ always: false, asked: ["buy shoes on shop.example"], plan: false, sessionId: "c1", ...g });

function setup(s: Partial<PolicySettings> = {}, reviewer?: ControlGateDeps["reviewer"]) {
  const click: AgentTool = withControlInfo(
    { spec: { name: "browser_click", description: "", inputSchema: { type: "object" } }, risk: "exec", run: async () => ({ output: "ok" }) },
    async () => ({ site: "shop.example", url: "https://shop.example/p/1", target: 'button "Add"', crop: async () => Buffer.from("png") }),
  );
  const other: AgentTool = { spec: { name: "read_file", description: "", inputSchema: { type: "object" } }, risk: "read", run: async () => ({ output: "" }) };
  const log = new ControlLog();
  const sites = new Set<string>();
  const [c, o] = gateControlTools([click, other], { chatId: "c1", settings: () => ({ ...settings, ...s }), reviewer: reviewer ?? (() => undefined), log, sites, saveCrop: async () => "asset-1" });
  return { c: c!, o: o!, log, sites };
}

test("control gate: other tools get no gate; a manual click asks with card v2 and a 5-minute limit", async () => {
  const { c, o, log } = setup();
  assert.equal(o.gate, undefined);
  const g = await c.gate!({ ref: "e2" }, ctx, info({ helper: "Shopper" }));
  assert.equal(g.action, "ask");
  assert.equal(g.noAlways, true, "a helper without the setting gets no Always");
  assert.equal(g.timeoutMs, 5 * 60_000);
  assert.equal(g.control?.site, "shop.example");
  assert.equal(g.control?.target, 'button "Add"');
  assert.equal(g.control?.crop, "asset-1");
  assert.deepEqual(g.control?.why, ["manual"]);
  g.decided?.("expired", "timeout");
  assert.deepEqual(log.last().map((d) => [d.decision, d.by, d.helper]), [["expired", "timeout", "Shopper"]]);
});

test("control gate: the reviewer's yes runs and is logged; its no asks with its reason", async () => {
  let yes = true;
  const { c, log } = setup({ mode: "auto" }, () => async () => ({ allow: yes, reason: yes ? "asked for" : "unsure" }));
  const a = await c.gate!({}, ctx, info());
  assert.equal(a.action, "allow");
  assert.match(a.note ?? "", /local reviewer/);
  yes = false;
  const b = await c.gate!({}, ctx, info());
  assert.equal(b.action, "ask");
  assert.match(b.reason, /unsure/);
  assert.equal(log.last()[0]!.by, "reviewer");
});

test("control gate: a site the user approves joins the task's sites", async () => {
  const { c, sites } = setup();
  const g = await c.gate!({}, ctx, info({ asked: ["hello"] }));
  g.decided?.("allow", "user");
  assert.ok(sites.has("shop.example"));
});
