import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { MCP_APP_MIME, VIEWS, VIEW_URIS } from "./connector-views.js";

/** A node of the tiny fake DOM the views need: tag, attributes, text, children, click handlers. */
class Node_ {
  attrs: Record<string, string> = {};
  children: Node_[] = [];
  handlers: Array<(e: { currentTarget: Node_ }) => void> = [];
  className = "";
  disabled = false;
  value = "";
  private own = "";
  constructor(readonly tag: string, text = "") {
    this.own = text;
  }
  set textContent(v: string) {
    this.own = v;
    this.children = [];
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: Node_) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: Node_[]) {
    this.children = c;
  }
  addEventListener(_t: string, fn: (e: { currentTarget: Node_ }) => void) {
    this.handlers.push(fn);
  }
  /** Every node below, this one included. */
  all(): Node_[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

/** Runs a view's script against the fake DOM; `host` plays Claude (answers `ui/initialize` and `tools/call`). */
function runView(uri: string, host: (method: string, params: Record<string, unknown>) => unknown) {
  const html = VIEWS.find((v) => v.uri === uri)!.html;
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  const app = new Node_("div");
  const created: Node_[] = [];
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const posted: Array<Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown> }> = [];
  const root = { lang: "", dir: "", className: "", scrollWidth: 390, scrollHeight: 600 };
  const parentWin = {
    postMessage: (m: Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown> }) => {
      posted.push(m);
      if (m.id !== undefined && m.method) {
        const result = host(m.method, m.params ?? {});
        Promise.resolve().then(() => listeners.forEach((l) => l({ source: parentWin, data: { jsonrpc: "2.0", id: m.id, result } })));
      }
    },
  };
  const document = {
    documentElement: root,
    body: new Node_("body"),
    getElementById: () => app,
    createElement: (t: string) => created.push(new Node_(t)) && created.at(-1)!,
    createTextNode: (t: string) => new Node_("#text", t),
  };
  runInNewContext(script, { document, window: { addEventListener: (_: string, fn: (e: { source: unknown; data: unknown }) => void) => listeners.push(fn) }, parent: parentWin, setTimeout: () => 0, Date, Math, String, Promise, Error });
  return {
    app,
    created,
    posted,
    root,
    /** The host sends the tool's result to the page. */
    result: (structuredContent: unknown) => listeners.forEach((l) => l({ source: parentWin, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } } })),
    /** Presses the button whose label matches. */
    press: (label: RegExp) => {
      const b = app.all().find((n) => n.tag === "button" && label.test(n.textContent))!;
      b.handlers[0]!({ currentTarget: b });
    },
    flush: () => new Promise((r) => setTimeout(r, 5)),
  };
}

const TAGS = new Set(["main", "div", "span", "h1", "h2", "small", "button", "select", "option", "pre", "ol", "li"]);
const EVIL = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
const card = (over: Record<string, unknown> = {}) => ({ conversationId: "c-1", requestId: "q-1", title: EVIL, tool: "run_command", preview: `rm -rf ~ ${EVIL}`, reason: `Runs ${EVIL}`, who: "helper", forWhile: true, ...over });

test("approvals view: listed in resources, with the shared MCP App rules", () => {
  const v = VIEWS.find((x) => x.uri === VIEW_URIS.approvals)!;
  assert.equal(VIEW_URIS.approvals, "ui://kesher/approvals");
  assert.ok(v.html.startsWith("<!DOCTYPE html>") && v.html.length < 40_000);
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//i.test(v.html) && !/innerHTML/.test(v.html));
  assert.match(v.html, /אשר/, "Hebrew labels");
  assert.match(v.html, /Allow for 10 minutes/);
  assert.match(v.html, /width=device-width/);
  assert.equal(MCP_APP_MIME, "text/html;profile=mcp-app");
});

test("approvals view: every value is shown as text, never as markup", async () => {
  const v = runView(VIEW_URIS.approvals, (m) => (m === "ui/initialize" ? { hostContext: { locale: "en", theme: "dark" } } : {}));
  await v.flush();
  v.result({ pc: EVIL, canAnswer: true, approvals: [card()] });
  assert.ok(v.created.every((n) => TAGS.has(n.tag)), `only plain tags: ${[...new Set(v.created.map((n) => n.tag))]}`);
  const text = v.app.textContent;
  for (const part of [`<img src=x onerror="alert(1)">`, "<script>alert(2)</script>"]) assert.ok(text.includes(part), "the tags show as text");
  assert.ok(v.created.every((n) => !Object.keys(n.attrs).some((k) => /^on/i.test(k))), "no inline handlers");
  assert.equal(v.app.all().find((n) => n.tag === "pre")!.attrs.dir, "auto");
});

test("approvals view: Allow, Allow for 10 minutes and Deny call kesher_approve through the host, then refresh", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const v = runView(VIEW_URIS.approvals, (m, p) => {
    if (m === "ui/initialize") return { hostContext: { locale: "he" } };
    if (m === "tools/call") {
      calls.push(JSON.parse(JSON.stringify(p)));
      return (p as { name: string }).name === "kesher_approve" ? { content: [{ type: "text", text: "Allowed once." }], structuredContent: { ok: true } } : { content: [], structuredContent: { approvals: [], canAnswer: true } };
    }
    return {};
  });
  await v.flush();
  assert.equal(v.root.dir, "rtl", "Hebrew is right-to-left");
  v.result({ pc: "Desk", canAnswer: true, approvals: [card({ title: "Fix the build", preview: "pnpm test" })] });
  assert.deepEqual(v.app.all().filter((n) => n.tag === "button").map((n) => n.textContent), ["אשר", "אשר ל-10 דקות", "דחה"]);
  v.press(/10/);
  await v.flush();
  assert.deepEqual(calls[0], { name: "kesher_approve", arguments: { conversationId: "c-1", requestId: "q-1", decision: "allow", forMinutes: 10, device: "Desk" } });
  v.press(/^אשר$/);
  v.press(/^דחה$/);
  await v.flush();
  assert.deepEqual(calls.slice(1).map((c) => c.arguments.decision), ["allow", "deny"]);
  assert.equal(calls[1]!.arguments.forMinutes, undefined, "plain Allow is once");
  assert.equal(calls[2]!.arguments.forMinutes, undefined, "Deny carries no allowance");
});

test("approvals view: a locked card, one the PC will not let Claude answer, and an empty list show only what is possible", async () => {
  const v = runView(VIEW_URIS.approvals, () => ({}));
  await v.flush();
  v.result({ canAnswer: true, approvals: [card({ locked: true }), card({ requestId: "q-2", forWhile: false })] });
  const labels = (n = v.app) => n.all().filter((x) => x.tag === "button").map((x) => x.textContent);
  assert.deepEqual(labels(), ["Deny", "Allow", "Deny"], "a locked card has only Deny; a card with no allowance has no 10 minutes");
  assert.match(v.app.textContent, /Only you can allow this one/);
  v.result({ canAnswer: false, approvals: [card()] });
  assert.deepEqual(labels(), ["Deny"]);
  assert.match(v.app.textContent, /does not let Claude allow/);
  v.result({ canAnswer: true, approvals: [] });
  assert.match(v.app.textContent, /Nothing waits for approval/);
});
