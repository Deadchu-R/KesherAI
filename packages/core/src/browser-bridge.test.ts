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

test("browser bridge: KesherAI's own pane comes first; the extension when asked for chrome", async () => {
  const b = new BrowserBridge();
  assert.equal(browserTools(b).length, 0);
  const seen: string[] = [];
  b.attachPane(async (action, args) => {
    seen.push(`${action}:${JSON.stringify(args)}`);
    return action === "tabs" ? [{ id: 1, title: "Pane", url: "https://a.test/", active: true }] : { url: "https://a.test/", title: "A", text: "hi", elements: [] };
  });
  assert.deepEqual(b.status().pane, true);
  const tools = browserTools(b);
  assert.ok(tools.length > 0, "tools with only the pane");
  assert.equal(tools[0]!.spec.inputSchema.properties && "browser" in (tools[0]!.spec.inputSchema.properties as object), false, "no browser choice without the extension");
  const tabs = tools.find((t) => t.spec.name === "browser_tabs")!;
  assert.match((await tabs.run({}, { signal: new AbortController().signal } as never)).output, /Pane/);
  b.attach(fakeSocket(() => [{ id: 9, title: "Chrome", url: "https://b.test/", active: true }]) as never, { browser: "Chrome" });
  const both = browserTools(b).find((t) => t.spec.name === "browser_tabs")!;
  assert.ok("browser" in (both.spec.inputSchema.properties as object), "a browser choice when both are there");
  assert.match((await both.run({}, { signal: new AbortController().signal } as never)).output, /Pane/, "the pane by default");
  assert.match((await both.run({ browser: "chrome" }, { signal: new AbortController().signal } as never)).output, /Chrome/, "the user's browser when asked");
  assert.ok(seen.every((x) => !x.includes("browser")), "the choice is not passed on to the pane");
  await assert.rejects(new BrowserBridge().paneCall("pane-state"), /desktop app/);
});
