import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserBridge, browserTools } from "./browser-bridge.js";

/** A fake extension: answers each command with what `reply` returns. */
function fakeSocket(reply: (msg: { id: string; action: string; args: Record<string, unknown> }) => unknown) {
  const ee = new EventEmitter();
  return {
    send(data: string) {
      const msg = JSON.parse(data) as { id?: string; action: string; args: Record<string, unknown> };
      if (msg.id) setImmediate(() => ee.emit("message", JSON.stringify({ id: msg.id, ok: true, result: reply(msg as never) })));
    },
    close: () => ee.emit("close"),
    on: (ev: string, fn: (...a: unknown[]) => void) => void ee.on(ev, fn),
  };
}

test("browser bridge: tools appear only while the extension is connected, and carry commands", async () => {
  const b = new BrowserBridge();
  assert.equal(browserTools(b).length, 0);
  await assert.rejects(b.call("tabs"), /not connected/);
  const sock = fakeSocket((m) => (m.action === "tabs" ? [{ id: 7, title: "Mail", url: "https://mail.example", active: true }] : { url: "https://x", title: "X", text: "hi", elements: ["1: button \"Send\""] }));
  b.attach(sock, { browser: "Chrome" });
  assert.equal(b.status().connected, true);
  const tools = Object.fromEntries(browserTools(b).map((t) => [t.spec.name, t]));
  assert.deepEqual(Object.keys(tools).sort(), ["browser_click", "browser_open", "browser_read", "browser_screenshot", "browser_tabs", "browser_type"]);
  assert.equal(tools.browser_tabs!.risk, "read");
  assert.equal(tools.browser_click!.risk, "exec");
  const ctx = { signal: new AbortController().signal } as never;
  assert.match((await tools.browser_tabs!.run({}, ctx)).output, /7 \(in front\): Mail/);
  assert.match((await tools.browser_read!.run({}, ctx)).output, /1: button "Send"/);
  await assert.rejects(tools.browser_open!.run({ url: "file:///etc/passwd" }, ctx), /Only http/);
  sock.close();
  assert.equal(b.status().connected, false);
});
