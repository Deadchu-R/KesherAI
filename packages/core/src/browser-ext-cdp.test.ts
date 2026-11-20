import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionCdp, extensionHasCdp } from "./browser-ext-cdp.js";

test("extension CDP: commands carry the tab; events reach only that tab's listeners", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const ext = new ExtensionCdp(async (action, args) => (calls.push([action, args]), { ok: 1 }) as never);
  const t7 = ext.transport(7);
  assert.deepEqual(await t7.send("DOM.focus", { backendNodeId: 3 }), { ok: 1 });
  assert.deepEqual(calls[0], ["cdp-send", { tabId: 7, method: "DOM.focus", params: { backendNodeId: 3 } }]);
  const seen: string[] = [];
  const off = t7.onEvent((m) => seen.push(m));
  ext.event({ tabId: 7, method: "Page.loadEventFired", params: {} });
  ext.event({ tabId: 8, method: "Page.loadEventFired" });
  ext.event({ tabId: "7", method: "x" });
  off();
  ext.event({ tabId: 7, method: "Page.frameNavigated" });
  assert.deepEqual(seen, ["Page.loadEventFired"]);
});

test("extension CDP: only Chrome-family 0.3.0+ that says cdp", () => {
  assert.equal(extensionHasCdp({ browser: "Chrome", version: "0.3.0", features: "cdp" }), true);
  assert.equal(extensionHasCdp({ browser: "Edge", version: "1.0.0", features: "cdp" }), true);
  assert.equal(extensionHasCdp({ browser: "Chrome", version: "0.2.6", features: "cdp" }), false);
  assert.equal(extensionHasCdp({ browser: "Chrome", version: "0.3.0" }), false);
  assert.equal(extensionHasCdp({ browser: "Firefox", version: "0.3.0", features: "cdp" }), false);
});
