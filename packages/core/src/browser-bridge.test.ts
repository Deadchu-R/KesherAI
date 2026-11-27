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

test("browser bridge: a screenshot is kept as an asset for the chat's thumbnail (and still goes to the model)", async () => {
  const b = new BrowserBridge();
  const sock = fakeSocket(() => ({ dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}` }));
  b.attach(sock, { browser: "Chrome" });
  const kept: Array<{ data: string; mimeType: string }> = [];
  const shot = browserTools(b, async (data, mimeType) => (kept.push({ data: data.toString(), mimeType }), "a1")).find((t) => t.spec.name === "browser_screenshot")!;
  const ctx = { signal: new AbortController().signal } as never;
  const r = await shot.run({}, ctx);
  assert.deepEqual(r.assetIds, ["a1"]);
  assert.equal(r.images?.[0]?.mimeType, "image/png");
  assert.deepEqual(kept, [{ data: "png", mimeType: "image/png" }]);
  // Without a store (or when keeping fails) the step still works, with no thumbnail.
  const plain = browserTools(b, async () => { throw new Error("disk full"); }).find((t) => t.spec.name === "browser_screenshot")!;
  assert.equal((await plain.run({}, ctx)).assetIds, undefined);
  sock.close();
});

test("browser bridge: cards name the element and the site; page text is untrusted; actions are logged", async () => {
  const b = new BrowserBridge();
  b.attachPane(async (action) =>
    action === "tabs" ? [{ id: 1, title: "Mail", url: "https://mail.example.com/inbox", active: true }] : { url: "https://mail.example.com/inbox", title: "Mail", text: "Inbox", elements: ['3: button "Send"', '4: textbox "To"'] },
  );
  const tools = Object.fromEntries(browserTools(b).map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal } as never;
  const read = (await tools.browser_read!.run({}, ctx)).output;
  assert.match(read, /^<untrusted-page source="mail\.example\.com">/);
  assert.equal(await tools.browser_click!.preview!({ ref: 3 }, ctx), 'Click button "Send" (ref 3) on mail.example.com');
  assert.match(await tools.browser_type!.preview!({ ref: 4, text: "dana@x", submit: true }, ctx), /^Type "dana@x" into textbox "To" \(ref 4\) on mail\.example\.com and press Enter$/);
  assert.equal(await tools.browser_click!.preview!({ ref: 99 }, ctx), "Click element 99 on mail.example.com");
  await tools.browser_click!.run({ ref: 3 }, ctx);
  const last = b.activity().log.at(-1)!;
  assert.deepEqual([last.tool, last.site, last.target, last.ok], ["browser_click", "mail.example.com", 'button "Send" (ref 3)', true]);
  assert.equal(b.activity().active, true);
});

test("browser bridge: Stop ends running commands and refuses new ones for a while", async () => {
  const b = new BrowserBridge();
  b.attachPane(() => new Promise(() => undefined));
  const ctx = { signal: new AbortController().signal } as never;
  const read = browserTools(b).find((t) => t.spec.name === "browser_read")!;
  const running = read.run({}, ctx);
  b.stop();
  await assert.rejects(running, /pressed Stop/);
  await assert.rejects(b.call("tabs"), /pressed Stop/);
  assert.equal(b.activity().active, false, "a Stop is not activity");
  assert.ok(b.activity().log.some((a) => a.tool === "stop"));
});

test("browser bridge: Pause refuses new actions until resumed, and no Chrome tab is pictured when none is driven", async () => {
  const b = new BrowserBridge();
  b.attachPane(async (action) => (action === "tabs" ? [] : null));
  b.setPaused(true);
  assert.equal(b.paused(), true);
  await assert.rejects(b.call("tabs"), /paused browser and computer control/);
  b.setPaused(false);
  assert.deepEqual(await b.call("tabs"), []);
  assert.deepEqual(b.activity().log.map((a) => a.tool).filter((t) => t === "pause" || t === "resume"), ["pause", "resume"]);
  assert.equal(b.chromeDriving(), undefined);
  assert.equal(await b.chromePeek(), undefined);
});

test("browser bridge: the pane gets the CDP tools; snapshot refs name elements on cards; eval and upload always ask", async () => {
  const b = new BrowserBridge();
  b.attachPane(async (action) => (action === "tabs" ? [{ id: 4, title: "Shop", url: "https://shop.example/cart", active: true }] : null));
  const sent: string[] = [];
  const tree = { nodes: [{ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }, { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Pay" }, backendDOMNodeId: 9 }] };
  b.attachCdpTab(4, {
    send: async (m) => {
      sent.push(m);
      if (m === "Accessibility.getFullAXTree") return tree;
      if (m === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: "https://shop.example/cart", title: "Shop" }] };
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    },
    onEvent: () => () => undefined,
  });
  const tools = Object.fromEntries(browserTools(b).map((t) => [t.spec.name, t]));
  for (const name of ["browser_snapshot", "browser_hover", "browser_select", "browser_scroll", "browser_press_key", "browser_click_at", "browser_wait", "browser_navigate", "browser_close_tab", "browser_console", "browser_network", "browser_network_request", "browser_dialog", "browser_eval", "browser_upload"]) assert.ok(tools[name], name);
  const ctx = { signal: new AbortController().signal } as never;
  const snap = (await tools.browser_snapshot!.run({}, ctx)).output;
  assert.match(snap, /<untrusted-page source="shop\.example">[\s\S]*button "Pay" \[ref=e1\]/);
  assert.equal(await tools.browser_click!.preview!({ ref: "e1" }, ctx), 'Click button "Pay" (ref e1) on shop.example');
  await tools.browser_click!.run({ ref: "e1" }, ctx);
  assert.ok(sent.includes("Input.dispatchMouseEvent"));
  assert.equal(b.activity().log.at(-1)!.target, 'button "Pay" (ref e1)');
  assert.ok(tools.browser_eval!.askFirst?.({}), "eval asks in every mode");
  assert.ok(tools.browser_upload!.askFirst?.({}), "upload asks in every mode");
  assert.equal(tools.browser_click!.askFirst, undefined);
  await assert.rejects(tools.browser_upload!.run({ ref: "e1", paths: ["/home/u/.ssh/id_rsa"] }, ctx), /never uploaded/);
  // A tab without a debugger (its developer tools are open) says so.
  b.detachCdpTab(4);
  await assert.rejects(tools.browser_snapshot!.run({}, ctx), /developer tools/);
});

test("browser bridge: the user's Chrome (extension 0.3.0) runs the same CDP tools over chrome.debugger", async () => {
  const b = new BrowserBridge();
  const ee = new EventEmitter();
  const got: Array<{ action: string; args: Record<string, unknown> }> = [];
  const tree = { nodes: [{ nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] }, { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Send" }, backendDOMNodeId: 5 }] };
  // A fake extension: tabs, and CDP commands answered like a page; events come back as cdp-event messages.
  const sock = {
    send(data: string) {
      const msg = JSON.parse(data) as { id: string; action: string; args: Record<string, unknown> };
      got.push(msg);
      let result: unknown = null;
      if (msg.action === "tabs") result = [{ id: 12, title: "Mail", url: "https://mail.example/inbox", active: true }];
      if (msg.action === "cdp-send") {
        const m = msg.args.method;
        if (m === "Accessibility.getFullAXTree") result = tree;
        else if (m === "Page.getNavigationHistory") result = { currentIndex: 0, entries: [{ url: "https://mail.example/inbox", title: "Mail" }] };
        else if (m === "DOM.getBoxModel") result = { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        else result = {};
      }
      setImmediate(() => ee.emit("message", JSON.stringify({ id: msg.id, ok: true, result })));
    },
    close: () => ee.emit("close"),
    on: (ev: string, fn: (...a: unknown[]) => void) => void ee.on(ev, fn),
  };
  b.attach(sock, { browser: "Chrome", version: "0.3.0", features: "cdp" });
  assert.equal(b.status().extensionCdp, true);
  const tools = Object.fromEntries(browserTools(b).map((t) => [t.spec.name, t]));
  assert.ok(tools.browser_snapshot && tools.browser_console, "the CDP tools are there without a pane");
  const ctx = { signal: new AbortController().signal } as never;
  const snap = (await tools.browser_snapshot!.run({}, ctx)).output;
  assert.match(snap, /<untrusted-page source="mail\.example">[\s\S]*button "Send" \[ref=e1\]/);
  // The first CDP step attached the debugger to that tab (the extension asks the user there).
  assert.deepEqual(got.find((m) => m.action === "cdp-attach")?.args, { tabId: 12 });
  assert.ok(got.some((m) => m.action === "cdp-send" && m.args.method === "Accessibility.getFullAXTree" && m.args.tabId === 12));
  assert.equal(await tools.browser_click!.preview!({ ref: "e1" }, ctx), 'Click button "Send" (ref e1) on mail.example');
  await tools.browser_click!.run({ ref: "e1" }, ctx);
  assert.ok(got.some((m) => m.action === "cdp-send" && m.args.method === "Input.dispatchMouseEvent"));
  // Events from the extension reach the tab's buffers.
  ee.emit("message", JSON.stringify({ type: "cdp-event", tabId: 12, method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Boom" } } }));
  assert.match((await tools.browser_console!.run({}, ctx)).output, /\[error\] Boom/);
  // "Cancel" on Chrome's debugging bar is the user's Stop.
  ee.emit("message", JSON.stringify({ type: "cdp-detached", tabId: 12, reason: "canceled_by_user" }));
  await assert.rejects(tools.browser_snapshot!.run({}, ctx), /pressed Stop/);
  sock.close();
  assert.equal(b.status().extensionCdp, false);
});

test("browser bridge: Firefox and older extensions keep the page reader and say why for CDP refs", async () => {
  const b = new BrowserBridge();
  b.attach(fakeSocket(() => []), { browser: "Firefox", version: "0.3.0", features: "" });
  assert.equal(b.status().extensionCdp, false);
  assert.equal(browserTools(b).some((t) => t.spec.name === "browser_snapshot"), false);
  await assert.rejects(b.withCdp({}, async () => 1), /Firefox has no debugger/);
  const old = new BrowserBridge();
  old.attach(fakeSocket(() => []), { browser: "Chrome", version: "0.2.6" });
  await assert.rejects(old.withCdp({}, async () => 1), /older than 0\.3\.0/);
});

test("browser bridge: inspect, emulate, Try my change and record are tools; the try's pictures go to the model and the chat", async () => {
  const b = new BrowserBridge();
  b.attachPane(async (action) => (action === "tabs" ? [{ id: 2, title: "App", url: "http://localhost:5173/", active: true }] : null));
  let width = 0;
  const listeners: Array<(m: string, p: Record<string, unknown>) => void> = [];
  b.attachCdpTab(2, {
    send: async (m, p) => {
      if (m === "Page.reload") setTimeout(() => listeners.forEach((fn) => fn("Page.loadEventFired", {})), 5);
      if (m === "Emulation.setDeviceMetricsOverride") width = Number(p?.width);
      if (m === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: width || 800, clientHeight: 600 } };
      if (m === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
      if (m === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: "http://localhost:5173/", title: "App" }] };
      if (m === "Runtime.evaluate") return { result: { value: 0 } };
      return {};
    },
    onEvent: (fn) => (listeners.push(fn), () => undefined),
  });
  const saved: string[] = [];
  const tools = Object.fromEntries(browserTools(b, async (_d, mime) => (saved.push(mime), `a${saved.length}`)).map((t) => [t.spec.name, t]));
  for (const name of ["browser_inspect", "browser_emulate", "browser_try_change", "browser_record"]) assert.ok(tools[name], name);
  const ctx = { signal: new AbortController().signal } as never;
  assert.match(await tools.browser_emulate!.preview!({ device: "phone", scheme: "dark" }, ctx), /390 px phone, dark colors/);
  const out = await tools.browser_try_change!.run({}, ctx);
  assert.match(out.output, /<untrusted-page source="localhost:5173">[\s\S]*Phone, 390 px: fits the width/);
  assert.equal(out.images?.length, 2);
  assert.deepEqual(out.assetIds, ["a1", "a2"]);
  await assert.rejects(tools.browser_emulate!.run({}, ctx), /Give device/);
});

test("browser bridge: a sign-in page shows the card, Continue reads it again; typing into a password field is refused", async () => {
  const b = new BrowserBridge();
  const sent: string[] = [];
  let signedIn = false;
  const login = { url: "https://accounts.example.com/signin", title: "Sign in", text: "Sign in", elements: ['1: textbox "Email"', '2: textbox "Password"'] };
  const inbox = { url: "https://mail.example.com/inbox", title: "Inbox", text: "3 new", elements: ['1: button "Compose"'] };
  b.attach(
    fakeSocket((m) => {
      sent.push(m.action);
      if (m.action === "tabs") return [{ id: 7, title: "x", url: signedIn ? inbox.url : login.url, active: true }];
      return signedIn ? inbox : login;
    }),
    { browser: "Chrome" },
  );
  const tools = Object.fromEntries(browserTools(b).map((t) => [t.spec.name, t]));
  const cards: unknown[] = [];
  const ctx = {
    signal: new AbortController().signal,
    handOver: async (_q: string, info: unknown) => {
      cards.push(info);
      signedIn = true;
      return "continue";
    },
  } as never;
  const out = await tools.browser_read!.run({}, ctx);
  assert.deepEqual(cards, [{ wall: "login", site: "accounts.example.com", browser: "chrome" }]);
  assert.match(out.output, /The user finished signing in[\s\S]*Compose/);

  // Back on the sign-in page: the model's typing into "Password" never reaches the browser.
  signedIn = false;
  await tools.browser_read!.run({}, { signal: new AbortController().signal } as never);
  sent.length = 0;
  const refused = await tools.browser_type!.run({ ref: "2", text: "hunter2" }, { signal: new AbortController().signal } as never);
  assert.equal(sent.includes("type"), false);
  assert.match(refused.output, /never types passwords[\s\S]*SIGN-IN NEEDED: accounts\.example\.com/);
});

test("browser bridge: a call the gate passed as a password field types nothing, even when the page renames the field", async () => {
  const b = new BrowserBridge();
  const sent: string[] = [];
  let renamed = false;
  const page = () => ({ url: "https://shop.example.com/", title: "Shop", text: "Shop", elements: [renamed ? '2: textbox "Search"' : '2: textbox "Password"'] });
  b.attach(
    fakeSocket((m) => {
      sent.push(m.action);
      return m.action === "tabs" ? [{ id: 7, title: "x", url: "https://shop.example.com/", active: true }] : page();
    }),
    { browser: "Chrome" },
  );
  const tools = Object.fromEntries(browserTools(b).map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal } as never;
  await tools.browser_read!.run({}, ctx);
  const info = (t: object) => (t as Record<symbol, (i: Record<string, unknown>, c: unknown) => Promise<{ secretField?: boolean }>>)[Object.getOwnPropertySymbols(t)[0]!]!;
  const input = { ref: "2", text: "my chat history" };
  assert.equal((await info(tools.browser_type!)(input, ctx)).secretField, true, "the gate lets it through without a card");
  // The page renames the field before the step runs: still nothing is typed.
  renamed = true;
  await tools.browser_read!.run({}, ctx);
  sent.length = 0;
  const out = await tools.browser_type!.run(input, ctx);
  assert.equal(sent.includes("type"), false);
  assert.match(out.output, /never types passwords/);
  // A fresh call into the renamed field is an ordinary step (the gate decides it).
  assert.equal((await info(tools.browser_type!)({ ref: "2", text: "socks" }, ctx)).secretField, undefined);
});

test("browser bridge: the approval card names the browser that will really be used", async () => {
  const b = new BrowserBridge();
  b.attachPane(async () => ({ url: "https://a.test/", title: "A", text: "hi", elements: [] }));
  b.attach(fakeSocket(() => ({})) as never, { browser: "Chrome" });
  const open = () => browserTools(b).find((t) => t.spec.name === "browser_open")!;
  const ctx = (lastUser: string) => ({ signal: new AbortController().signal, lastUser }) as never;
  b.preferred = () => "auto";
  assert.match(await open().preview!({ url: "https://mail.test/" }, ctx("open my gmail inbox")), /in your browser/, "own sign-in: the user's Chrome");
  assert.match(await open().preview!({ url: "https://a.test/" }, ctx("look at a.test")), /in KesherAI's browser/, "otherwise the pane");
  b.preferred = () => "chrome";
  assert.match(await open().preview!({ url: "https://a.test/" }, ctx("look at a.test")), /in your browser/, "the setting");
  assert.match(await open().preview!({ url: "https://a.test/", browser: "pane" }, ctx("look at a.test")), /in KesherAI's browser/, "what the model named wins");
});
