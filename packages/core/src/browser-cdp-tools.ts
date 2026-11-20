/**
 * The model's CDP browser tools for KesherAI's own browser pane (docs/research/browser-computer-control.md, Phase 1):
 * an accessibility snapshot with refs, acting by ref (hover, select, scroll, keys, upload), a click at a point of a
 * screenshot, waiting, back / forward / reload / bring to front, closing a tab, the console and the network, a pop-up's
 * answer and JavaScript. browser_click, browser_type and browser_screenshot (browser-bridge.ts) take these refs too.
 *
 * Approvals: looking (snapshot, console, network, wait) is "read" or "write" like browser_read; acting is "exec" and
 * asks unless the mode is auto or the site is allowed; browser_eval and browser_upload ask every time (ALWAYS_ASK in
 * browser-bridge.ts). Everything a page wrote reaches the model inside an untrusted block.
 */
import { stat } from "node:fs/promises";
import type { AgentTool, ToolContext } from "@kesher/agent";
import type { BrowserBridge } from "./browser-bridge.js";
import type { CdpPage } from "./cdp.js";
import { hostOf, untrusted, uploadRefusal, redactUrl } from "./browser-safety.js";

/** What the tools need from browserTools: the tab arguments and the card's " on site" words. */
export interface CdpToolHelpers {
  tabArg: Record<string, unknown>;
  onSite: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

/** Whether a ref is a snapshot ref ("e12") rather than an older browser_read number. */
export const isCdpRef = (ref: unknown): boolean => typeof ref === "string" && /^e\d+$/.test(ref.trim());

/**
 * The page after an action, as the model sees it: title, address and the snapshot, marked untrusted.
 *
 * @param page - The tab.
 * @param note - What was done, first ("Clicked button "Send".").
 */
export async function snapshotText(page: CdpPage, note = ""): Promise<string> {
  const where = await page.where();
  const { tree } = await page.snapshot();
  const body = `${where.title}\n${where.url}\n\n${tree}${page.dialog ? `\n\n(A ${page.dialog.type} pop-up is open: "${page.dialog.message.slice(0, 300)}". Answer it with browser_dialog.)` : ""}`;
  return `${note ? `${note}\n` : ""}${untrusted(hostOf(where.url) ?? where.url, body)}`;
}

/**
 * The CDP tools (only when KesherAI's own pane is there).
 *
 * @param b - The bridge.
 * @param h - Shared bits of browserTools.
 * @returns The tools, not yet wrapped by browserTools' log and site scope.
 */
export function cdpBrowserTools(b: BrowserBridge, h: CdpToolHelpers): AgentTool[] {
  const tab = { tabId: h.tabArg.tabId };
  const refArg = { ref: { type: "string", description: "The element's ref from browser_snapshot, e.g. e12." } };
  const run = <T>(input: Record<string, unknown>, ctx: ToolContext, fn: (p: CdpPage, tabId: number) => Promise<T>) => b.withCdp(input, fn, ctx.signal);
  /** `button "Send" (ref e3)` for cards and the log. */
  const label = async (input: Record<string, unknown>, ctx: ToolContext) => {
    const ref = String(input.ref ?? "");
    const id = await b.paneTabId(input, ctx.signal).catch(() => undefined);
    const l = id === undefined ? undefined : b.cdpLabel(id, ref);
    return l ? `${l} (ref ${ref})` : `element ${ref}`;
  };
  const source = async (p: CdpPage, what: string) => `${what} of ${hostOf((await p.where()).url) ?? "the page"}`;

  return [
    {
      risk: "write",
      spec: {
        name: "browser_snapshot",
        description:
          "Read a tab of KesherAI's browser as an accessibility tree: headings, text, and every button, link, field and list with a ref (e1, e2…) for browser_click, browser_type, browser_select, browser_hover and browser_scroll. Cheaper and more exact than a screenshot; refs change after each snapshot or page change. Hidden text is not included.",
        inputSchema: { type: "object", properties: tab },
      },
      preview: async (input, ctx) => `Read the page${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, (p) => snapshotText(p)) }),
    },
    {
      risk: "exec",
      spec: {
        name: "browser_hover",
        description: "Move the mouse over an element by its ref (opens menus or tips that show on hover). Returns the page after.",
        inputSchema: { type: "object", properties: { ...refArg, ...tab }, required: ["ref"] },
      },
      preview: async (input, ctx) => `Hover over ${await label(input, ctx)}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, async (p) => (await p.hover(String(input.ref)), snapshotText(p))) }),
    },
    {
      risk: "exec",
      spec: {
        name: "browser_select",
        description: "Choose options in a list box (<select>) by its ref: values are the options' words or values. Returns the page after.",
        inputSchema: { type: "object", properties: { ...refArg, values: { type: "array", items: { type: "string" } }, ...tab }, required: ["ref", "values"] },
      },
      preview: async (input, ctx) => `Choose ${(Array.isArray(input.values) ? input.values : [input.values]).map((v) => `"${String(v).slice(0, 80)}"`).join(", ")} in ${await label(input, ctx)}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const values = (Array.isArray(input.values) ? input.values : [input.values]).map(String);
        return { output: await run(input, ctx, async (p) => snapshotText(p, `Chosen: ${(await p.select(String(input.ref), values)).join(", ")}.`)) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_scroll",
        description: "Scroll a tab: to an element by its ref, or by screens in a direction (default one screen down).",
        inputSchema: { type: "object", properties: { ref: refArg.ref, direction: { type: "string", enum: ["up", "down", "left", "right"] }, screens: { type: "number" }, ...tab } },
      },
      preview: async (input, ctx) => `Scroll ${input.ref ? `to ${await label(input, ctx)}` : String(input.direction ?? "down")}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const o = { ...(input.ref ? { ref: String(input.ref) } : {}), ...(input.direction ? { direction: input.direction as "up" } : {}), ...(typeof input.screens === "number" ? { screens: input.screens } : {}) };
        return { output: await run(input, ctx, async (p) => (await p.scroll(o), "Scrolled.")) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_press_key",
        description: 'Press a key or a combination in a tab: "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+a", "Shift+Tab". Goes to the focused element. Returns the page after.',
        inputSchema: { type: "object", properties: { key: { type: "string" }, ...tab }, required: ["key"] },
      },
      preview: async (input, ctx) => `Press ${String(input.key).slice(0, 40)}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, async (p) => (await p.pressKey(String(input.key ?? "")), snapshotText(p))) }),
    },
    {
      risk: "exec",
      spec: {
        name: "browser_click_at",
        description: "Click a point of the last browser_screenshot of the visible area (its pixels), for what has no ref (a canvas, a map, a game). Prefer refs.",
        inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, ...tab }, required: ["x", "y"] },
      },
      preview: async (input, ctx) => `Click at (${Math.round(Number(input.x))}, ${Math.round(Number(input.y))})${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, async (p) => (await p.clickAt(Number(input.x), Number(input.y)), snapshotText(p))) }),
    },
    {
      risk: "read",
      spec: {
        name: "browser_wait",
        description: "Wait until text shows on the page (text), until text is gone (gone), or for ms milliseconds; at most 30 s (timeoutMs, default 10 s).",
        inputSchema: { type: "object", properties: { text: { type: "string" }, gone: { type: "string" }, ms: { type: "number" }, timeoutMs: { type: "number" }, ...tab } },
      },
      run: async (input, ctx) => {
        const o = { ...(input.text ? { text: String(input.text) } : {}), ...(input.gone ? { gone: String(input.gone) } : {}), ...(typeof input.ms === "number" ? { ms: input.ms } : {}), ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}) };
        return { output: await run(input, ctx, (p) => p.waitFor(o)) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_navigate",
        description: "Go back, forward or reload in a tab, or bring a tab to the front (action: back, forward, reload, front). Returns the page after.",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["back", "forward", "reload", "front"] }, ...tab }, required: ["action"] },
      },
      preview: async (input, ctx) => `${({ back: "Go back", forward: "Go forward", reload: "Reload", front: "Bring to the front" } as Record<string, string>)[String(input.action)] ?? "Navigate"}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const what = String(input.action);
        if (!["back", "forward", "reload", "front"].includes(what)) throw new Error("action is back, forward, reload or front.");
        if (what === "front") await b.paneCall("pane-select", { id: await b.paneTabId(input, ctx.signal) });
        return { output: await run(input, ctx, async (p) => (what === "front" ? undefined : await p.history(what as "back"), snapshotText(p))) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_close_tab",
        description: "Close a tab of KesherAI's browser (tabId from browser_tabs; leave out for the one in front).",
        inputSchema: { type: "object", properties: tab },
      },
      preview: async (input, ctx) => `Close the tab${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const id = await b.paneTabId(input, ctx.signal);
        await b.paneCall("pane-close", { id });
        return { output: `Closed tab ${id}.` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_console",
        description: "Read the console of a tab since it opened: logs, warnings, errors and uncaught exceptions with where they came from. errors: true for errors and warnings only; clear: true to empty it after (to see only what comes next).",
        inputSchema: { type: "object", properties: { errors: { type: "boolean" }, clear: { type: "boolean" }, last: { type: "number" }, ...tab } },
      },
      preview: async (input, ctx) => `Read the console${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({
        output: await run(input, ctx, async (p) => {
          const lines = p.consoleLines({ errors: input.errors === true, clear: input.clear === true, ...(typeof input.last === "number" ? { last: input.last } : {}) });
          const body = lines.map((l) => `[${l.level}] ${l.text}${l.where ? ` (${l.where})` : ""}`).join("\n") || (input.errors ? "(no errors or warnings)" : "(the console is empty)");
          return untrusted(await source(p, "console"), body);
        }),
      }),
    },
    {
      risk: "write",
      spec: {
        name: "browser_network",
        description: "List a tab's network requests since it opened: number, method, status, type, size, address. filter: words in the address; failed: true for failed ones and status 400+. Details with browser_network_request. Sign-in values are hidden.",
        inputSchema: { type: "object", properties: { filter: { type: "string" }, failed: { type: "boolean" }, last: { type: "number" }, ...tab } },
      },
      preview: async (input, ctx) => `Read the network requests${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({
        output: await run(input, ctx, async (p) => {
          const list = p.requests({ ...(input.filter ? { filter: String(input.filter) } : {}), failed: input.failed === true, ...(typeof input.last === "number" ? { last: input.last } : {}) });
          const body = list.map((r) => `#${r.n} ${r.method} ${r.failed ? `FAILED (${r.failed})` : r.status ?? "…"} ${r.type ?? ""}${r.size !== undefined ? ` ${Math.round(r.size / 102.4) / 10} KB` : ""} ${redactUrl(r.url)}`).join("\n") || "(no requests)";
          return untrusted(await source(p, "network"), body);
        }),
      }),
    },
    {
      risk: "write",
      spec: {
        name: "browser_network_request",
        description: "One network request in full by its number from browser_network: headers (sign-ins hidden), what was sent (secret fields hidden) and the answer (cut).",
        inputSchema: { type: "object", properties: { id: { type: "number" }, ...tab }, required: ["id"] },
      },
      preview: async (input, ctx) => `Read network request #${Number(input.id)}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, async (p) => untrusted(await source(p, "network"), await p.requestDetail(Number(input.id)))) }),
    },
    {
      risk: "exec",
      spec: {
        name: "browser_dialog",
        description: "Answer a pop-up the page opened (alert, confirm, prompt): accept true for OK, false for Cancel; text for a prompt. The page waits until it is answered.",
        inputSchema: { type: "object", properties: { accept: { type: "boolean" }, text: { type: "string" }, ...tab }, required: ["accept"] },
      },
      preview: async (input, ctx) => `${input.accept ? "Press OK" : "Press Cancel"} on the page's pop-up${input.text !== undefined ? ` with "${String(input.text).slice(0, 80)}"` : ""}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, (p) => p.answerDialog(input.accept === true, input.text === undefined ? undefined : String(input.text))) }),
    },
    {
      risk: "exec",
      spec: {
        name: "browser_eval",
        description: "Run JavaScript in a tab and get its value as JSON (await works). For checking a page you are building or debugging; the user is asked every time. Prefer the other tools.",
        inputSchema: { type: "object", properties: { expression: { type: "string" }, ...tab }, required: ["expression"] },
      },
      preview: async (input, ctx) => `Run this code in the page${await h.onSite(input, ctx.signal)}:\n${String(input.expression ?? "").slice(0, 1500)}`,
      run: async (input, ctx) => ({ output: await run(input, ctx, async (p) => untrusted(await source(p, "code result"), await p.evaluate(String(input.expression ?? "")))) }),
    },
    {
      risk: "exec",
      spec: {
        name: "browser_upload",
        description: "Put files from this computer into a file field (its ref, an <input type=file>): paths are full paths. The user is asked every time; key and sign-in files and files over 10 MB are never sent.",
        inputSchema: { type: "object", properties: { ...refArg, paths: { type: "array", items: { type: "string" } }, ...tab }, required: ["ref", "paths"] },
      },
      preview: async (input, ctx) => `Upload ${(Array.isArray(input.paths) ? input.paths : []).map(String).join(", ")} into ${await label(input, ctx)}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const paths = (Array.isArray(input.paths) ? input.paths : []).map(String).slice(0, 10);
        if (!paths.length) throw new Error("Give the files' full paths.");
        for (const path of paths) {
          const why = uploadRefusal(path, await stat(path).catch(() => undefined));
          if (why) throw new Error(why);
        }
        return { output: await run(input, ctx, async (p) => (await p.upload(String(input.ref), paths), snapshotText(p, `Put ${paths.length} file(s) in the field.`))) };
      },
    },
  ];
}
