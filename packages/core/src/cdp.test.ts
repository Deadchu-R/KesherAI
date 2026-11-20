import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpPage, type CdpTransport } from "./cdp.js";

/** A fake CDP connection: answers by method, records what was sent, and can fire events. */
function fakeCdp(answers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let listener: (m: string, p: Record<string, unknown>) => void = () => undefined;
  const t: CdpTransport = {
    send: async (method, params = {}) => {
      sent.push({ method, params });
      const a = answers[method];
      if (a) return a(params);
      return {};
    },
    onEvent: (fn) => {
      listener = fn;
      return () => (listener = () => undefined);
    },
  };
  return { t, sent, fire: (m: string, p: Record<string, unknown>) => listener(m, p) };
}

/** A small page's accessibility tree: a heading, text, a button, a field, a password field and hidden stuff. */
const TREE = {
  nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Mail" }, childIds: ["2", "3", "4", "5", "6", "7"] },
    { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Inbox" }, properties: [{ name: "level", value: { value: 1 } }], childIds: ["8"] },
    { nodeId: "8", parentId: "2", role: { value: "StaticText" }, name: { value: "Inbox" } },
    { nodeId: "3", parentId: "1", role: { value: "generic" }, childIds: ["9"] },
    { nodeId: "9", parentId: "3", role: { value: "button" }, name: { value: "Send" }, backendDOMNodeId: 30, childIds: ["10"] },
    { nodeId: "10", parentId: "9", role: { value: "StaticText" }, name: { value: "Send" } },
    { nodeId: "4", parentId: "1", role: { value: "textbox" }, name: { value: "To" }, value: { value: "dana@x" }, backendDOMNodeId: 40 },
    { nodeId: "5", parentId: "1", role: { value: "textbox" }, name: { value: "Password" }, backendDOMNodeId: 50 },
    { nodeId: "6", parentId: "1", ignored: true, role: { value: "button" }, name: { value: "Hidden" }, backendDOMNodeId: 60 },
    { nodeId: "7", parentId: "1", role: { value: "checkbox" }, name: { value: "Keep me" }, properties: [{ name: "checked", value: { value: true } }], backendDOMNodeId: 70 },
  ],
};

const box = (x: number, y: number, w: number, h: number) => ({ model: { content: [x, y, x + w, y, x + w, y + h, x, y + h], border: [x, y, x + w, y, x + w, y + h, x, y + h] } });

test("cdp: the snapshot is a readable tree with refs on controls only, hidden nodes left out", async () => {
  const f = fakeCdp({ "Accessibility.getFullAXTree": () => TREE });
  const p = new CdpPage(f.t);
  const { tree, refs } = await p.snapshot();
  assert.equal(refs, 4);
  assert.equal(
    tree,
    ['- heading "Inbox" [level=1]', '- button "Send" [ref=e1]', '- textbox "To" [ref=e2]: dana@x', '- textbox "Password" [ref=e3]', '- checkbox "Keep me" [checked] [ref=e4]'].join("\n"),
  );
  assert.equal(p.labels.get("e1"), 'button "Send"');
  assert.doesNotMatch(tree, /Hidden/);
});

test("cdp: click goes to the middle of the element; a ref from an old page is refused", async () => {
  const f = fakeCdp({ "Accessibility.getFullAXTree": () => TREE, "DOM.getBoxModel": () => box(100, 200, 50, 20) });
  const p = new CdpPage(f.t);
  await p.snapshot();
  await p.click("e1");
  const mouse = f.sent.filter((s) => s.method === "Input.dispatchMouseEvent").map((s) => [s.params.type, s.params.x, s.params.y]);
  assert.deepEqual(mouse, [["mouseMoved", 125, 210], ["mousePressed", 125, 210], ["mouseReleased", 125, 210]]);
  f.fire("Page.frameNavigated", { frame: { id: "main" } });
  await assert.rejects(p.click("e1"), /no ref e1/);
});

test("cdp: typing replaces the field's text, and never goes into a password field", async () => {
  const f = fakeCdp({
    "Accessibility.getFullAXTree": () => TREE,
    "DOM.describeNode": (q) => ({ node: { nodeName: "INPUT", attributes: q.backendNodeId === 50 ? ["type", "password"] : ["type", "email"] } }),
    "DOM.resolveNode": () => ({ object: { objectId: "o1" } }),
    "Runtime.callFunctionOn": () => ({ result: {} }),
  });
  const p = new CdpPage(f.t);
  await p.snapshot();
  await p.type("e2", "noa@x");
  assert.deepEqual(f.sent.find((s) => s.method === "Input.insertText")?.params, { text: "noa@x" });
  await assert.rejects(p.type("e3", "hunter2"), /never types/);
  assert.equal(f.sent.filter((s) => s.method === "Input.insertText").length, 1);
});

test("cdp: keys and combinations become key events", async () => {
  const f = fakeCdp();
  const p = new CdpPage(f.t);
  await p.pressKey("Control+a");
  const [down, up] = f.sent.filter((s) => s.method === "Input.dispatchKeyEvent").map((s) => s.params);
  assert.deepEqual([down!.type, down!.key, down!.code, down!.modifiers, down!.text], ["rawKeyDown", "a", "KeyA", 2, undefined]);
  assert.equal(up!.type, "keyUp");
  await assert.rejects(p.pressKey("Hyper+x"), /Unknown modifier/);
  await assert.rejects(p.pressKey("NoSuchKey"), /Unknown key/);
});

test("cdp: console and network are kept, with sign-ins hidden", async () => {
  const f = fakeCdp({ "Network.getResponseBody": () => ({ body: '{"ok":true,"token":"abc"}', base64Encoded: false }) });
  const p = new CdpPage(f.t);
  f.fire("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello" }, { value: 3 }] });
  f.fire("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", url: "http://localhost:5173/app.js?key=k1", lineNumber: 9, exception: { description: "TypeError: x is undefined" } } });
  f.fire("Network.requestWillBeSent", { requestId: "r1", type: "Fetch", request: { method: "GET", url: "https://api.example.com/me?token=t1&q=2", headers: { Authorization: "Bearer s3cret", Accept: "json" } } });
  f.fire("Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json", headers: { "Set-Cookie": "sid=1" } } });
  f.fire("Network.loadingFinished", { requestId: "r1", encodedDataLength: 2048 });
  f.fire("Network.requestWillBeSent", { requestId: "r2", request: { method: "POST", url: "https://api.example.com/x" } });
  f.fire("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });

  assert.deepEqual(p.consoleLines().map((l) => l.text), ["hello 3", "TypeError: x is undefined"]);
  assert.deepEqual(p.consoleLines({ errors: true }).map((l) => l.where), ["http://localhost:5173/app.js?key=(hidden):10"]);
  assert.deepEqual(p.requests({ failed: true }).map((r) => r.n), [2]);
  const d = await p.requestDetail(1);
  assert.match(d, /token=\(hidden\)&q=2/);
  assert.match(d, /Authorization: \(hidden\)/);
  assert.match(d, /Set-Cookie: \(hidden\)/);
  assert.match(d, /"token":"\(hidden\)"/);
  assert.doesNotMatch(d, /s3cret|abc|t1/);
});

test("cdp: an open pop-up blocks actions until it is answered", async () => {
  const f = fakeCdp({ "Accessibility.getFullAXTree": () => TREE });
  const p = new CdpPage(f.t);
  f.fire("Page.javascriptDialogOpening", { type: "confirm", message: "Delete everything?" });
  await assert.rejects(p.snapshot(), /confirm pop-up .*browser_dialog/);
  assert.match(await p.answerDialog(false), /Dismissed the confirm/);
  assert.deepEqual(f.sent.at(-1), { method: "Page.handleJavaScriptDialog", params: { accept: false } });
  await p.snapshot();
});

test("cdp: wait for text polls the page; a screenshot of the visible area maps clicks back", async () => {
  let n = 0;
  const f = fakeCdp({
    "Runtime.evaluate": () => ({ result: { value: ++n > 2 ? "Saved!" : "Saving…" } }),
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 3200, clientHeight: 1000 } }),
    "Page.captureScreenshot": () => ({ data: Buffer.from("png").toString("base64") }),
  });
  const p = new CdpPage(f.t);
  assert.match(await p.waitFor({ text: "Saved" }), /is on the page/);
  await assert.rejects(p.waitFor({ text: "Never", timeoutMs: 300 }), /Still no "Never"/);
  const shot = await p.screenshot();
  assert.deepEqual([shot.width, shot.height, shot.data.toString()], [1600, 500, "png"]);
  await p.clickAt(800, 250);
  const press = f.sent.find((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed")!;
  assert.deepEqual([press.params.x, press.params.y], [1600, 500], "picture pixels back to CSS pixels");
});

test("cdp: the user's Elements view has its own refs and never breaks the model's", async () => {
  const f = fakeCdp({ "Accessibility.getFullAXTree": () => TREE, "DOM.resolveNode": () => ({ object: { objectId: "o1" } }), "Runtime.callFunctionOn": () => ({ result: { value: { tag: "button", attributes: {}, box: { x: 1, y: 2, width: 3, height: 4 }, styles: {}, text: "Send", html: "<button>Send</button>", cut: false } } }) });
  const p = new CdpPage(f.t);
  await p.snapshot();
  assert.equal(p.labels.get("e1"), 'button "Send"');
  await p.snapshot({ forUser: true });
  assert.equal(p.labels.get("e1"), 'button "Send"', "the model's labels stay");
  const info = await p.inspect({ ref: "e2", user: true, highlight: true });
  assert.equal(info.tag, "button");
  // The user's e2 is the To field (backend 40); highlighting turns on DOM and Overlay first.
  assert.equal(f.sent.find((s) => s.method === "DOM.resolveNode")?.params.backendNodeId, 40);
  assert.ok(f.sent.some((s) => s.method === "Overlay.highlightNode" && s.params.backendNodeId === 40));
  await assert.rejects(p.inspect({ ref: "e9" }), /no ref e9/);
});

test("cdp: inspect by a point of the screenshot or a tap's fraction finds the node there", async () => {
  const f = fakeCdp({
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 400, clientHeight: 800 } }),
    "DOM.getNodeForLocation": (q) => ({ backendNodeId: 7, at: q }),
    "DOM.resolveNode": () => ({ object: { objectId: "o" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: { tag: "p", attributes: { "data-token": "(hidden)" }, box: { x: 0, y: 0, width: 400, height: 20 }, styles: { overflow: "hidden" }, text: "Long", html: "<p>Long</p>", cut: true } } }),
  });
  const p = new CdpPage(f.t);
  const i = await p.inspect({ fx: 0.5, fy: 0.25 });
  assert.equal(i.cut, true);
  assert.deepEqual(f.sent.find((s) => s.method === "DOM.getNodeForLocation")?.params, { x: 200, y: 200, ignorePointerEventsNone: true });
  // The page function is given the style names and hides secret attributes itself.
  const fn = String(f.sent.find((s) => s.method === "Runtime.callFunctionOn")?.params.functionDeclaration);
  assert.match(fn, /token\|secret/);
});

test("cdp: emulate shows the page at 390 px, on a desktop, or as it is, and in dark colors", async () => {
  const f = fakeCdp();
  const p = new CdpPage(f.t);
  assert.deepEqual(await p.emulate({ device: "phone", scheme: "dark" }), { device: "phone", scheme: "dark" });
  assert.deepEqual(f.sent.find((s) => s.method === "Emulation.setDeviceMetricsOverride")?.params, { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.deepEqual(f.sent.find((s) => s.method === "Emulation.setEmulatedMedia")?.params, { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await p.emulate({ device: "none" });
  assert.ok(f.sent.some((s) => s.method === "Emulation.clearDeviceMetricsOverride"));
  assert.deepEqual(p.emulation, { device: "none", scheme: "dark" });
});

test("cdp: Try my change reloads, gathers new errors and failed requests, and pictures at 390 and 1280", async () => {
  let width = 0;
  const f = fakeCdp({
    "Page.reload": () => (setTimeout(() => f.fire("Page.loadEventFired", {}), 5), {}),
    "Emulation.setDeviceMetricsOverride": (q) => ((width = Number(q.width)), {}),
    "Runtime.evaluate": () => ({ result: { value: width === 390 ? 24 : 0 } }),
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: width || 800, clientHeight: 600 } }),
    "Page.captureScreenshot": () => ({ data: Buffer.from(`shot${width}`).toString("base64") }),
    "Page.getNavigationHistory": () => ({ currentIndex: 0, entries: [{ url: "http://localhost:5173/?token=abc", title: "App" }] }),
  });
  const p = new CdpPage(f.t);
  f.fire("Runtime.exceptionThrown", { exceptionDetails: { text: "old error" } });
  await new Promise((r) => setTimeout(r, 5));
  const run = p.tryChange();
  setTimeout(() => {
    f.fire("Runtime.exceptionThrown", { exceptionDetails: { text: "new error" } });
    f.fire("Network.requestWillBeSent", { requestId: "1", request: { method: "GET", url: "http://localhost:5173/api/x" } });
    f.fire("Network.responseReceived", { requestId: "1", response: { status: 500 } });
  }, 50);
  const r = await run;
  assert.deepEqual(r.errors.map((e) => e.text), ["new error"]);
  assert.equal(r.failed[0]?.status, 500);
  assert.deepEqual(r.views.map((v) => [v.device, v.width, v.overflow, v.data.toString()]), [["phone", 390, 24, "shot390"], ["desktop", 1280, 0, "shot1280"]]);
  // The page's own size comes back after.
  const sizes = f.sent.filter((s) => s.method === "Emulation.setDeviceMetricsOverride" || s.method === "Emulation.clearDeviceMetricsOverride");
  assert.equal(sizes.at(-1)?.method, "Emulation.clearDeviceMetricsOverride");
});

test("cdp: a recording keeps the screencast's frames (acknowledged) and a last picture", async () => {
  const f = fakeCdp({
    "Page.getLayoutMetrics": () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 400, clientHeight: 300 } }),
    "Page.captureScreenshot": () => ({ data: Buffer.from("last").toString("base64") }),
  });
  const p = new CdpPage(f.t);
  await p.startRecording();
  assert.equal(p.recording, true);
  await assert.rejects(p.startRecording(), /already running/);
  f.fire("Page.screencastFrame", { data: Buffer.from("f1").toString("base64"), sessionId: 3, metadata: {} });
  assert.ok(f.sent.some((s) => s.method === "Page.screencastFrameAck" && s.params.sessionId === 3));
  const frames = await p.stopRecording();
  assert.deepEqual(frames.map((x) => x.data.toString()), ["f1", "last"]);
  assert.ok(f.sent.some((s) => s.method === "Page.stopScreencast"));
  assert.equal(p.recording, false);
  await assert.rejects(p.stopRecording(), /No recording/);
});
