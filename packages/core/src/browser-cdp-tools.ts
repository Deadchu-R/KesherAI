/**
 * The model's CDP browser tools for KesherAI's own browser pane and, through the extension's `chrome.debugger` (0.3.0+),
 * the user's own Chrome: the same recipes over either transport (docs/research/browser-computer-control.md, Phases 1–2):
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
import type { CdpPage, InspectInfo } from "./cdp.js";
import { encodeRecording } from "./browser-record.js";
import { hostOf, untrusted, uploadRefusal, redactUrl } from "./browser-safety.js";

/** What the tools need from browserTools: the tab arguments and the card's " on site" words. */
export interface CdpToolHelpers {
  tabArg: Record<string, unknown>;
  onSite: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  /** Keeps a picture or a recording as an asset (its id), so the chat shows it in the step. */
  saveAsset?: (data: Buffer, mimeType: string) => Promise<string>;
  /** FFmpeg's program when it is on the computer (a WebM recording); never downloads it. */
  ffmpeg?: () => Promise<string | undefined>;
}

/**
 * One inspected element as text for the model (and the log): tag and attributes, box, styles, whether it is cut, text
 * and HTML.
 *
 * @param i - What `CdpPage.inspect` found.
 */
export function inspectText(i: InspectInfo): string {
  const attrs = Object.entries(i.attributes).map(([k, v]) => ` ${k}="${v}"`).join("");
  return [
    `<${i.tag}${attrs}>`,
    `Box: x ${i.box.x}, y ${i.box.y}, ${i.box.width}×${i.box.height} px (CSS pixels of the visible area)`,
    `Styles: ${Object.entries(i.styles).map(([k, v]) => `${k}: ${v}`).join("; ") || "(defaults)"}`,
    i.cut ? "Cut: yes, its content is wider or taller than its box and is hidden (text may be cut off)." : "Cut: no",
    ...(i.text ? [`Text: ${i.text}`] : []),
    `HTML: ${i.html}`,
  ].join("\n");
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
  // The tab, and (when both are there) which browser: KesherAI's pane or the user's Chrome.
  const tab = { tabId: h.tabArg.tabId, ...(h.tabArg.browser ? { browser: h.tabArg.browser } : {}) };
  const refArg = { ref: { type: "string", description: "The element's ref from browser_snapshot, e.g. e12." } };
  const run = <T>(input: Record<string, unknown>, ctx: ToolContext, fn: (p: CdpPage, tabId: number) => Promise<T>) => b.withCdp(input, fn, ctx.signal);
  /** `button "Send" (ref e3)` for cards and the log. */
  const label = async (input: Record<string, unknown>, ctx: ToolContext) => {
    const ref = String(input.ref ?? "");
    const id = await b.cdpTabId(input, ctx.signal).catch(() => undefined);
    const l = id === undefined ? undefined : b.cdpLabel(id, ref, b.cdpTarget(input));
    return l ? `${l} (ref ${ref})` : `element ${ref}`;
  };
  const source = async (p: CdpPage, what: string) => `${what} of ${hostOf((await p.where()).url) ?? "the page"}`;

  return [
    {
      risk: "write",
      spec: {
        name: "browser_snapshot",
        description:
          "Read a tab as an accessibility tree: headings, text, and every button, link, field and list with a ref (e1, e2…) for browser_click, browser_type, browser_select, browser_hover and browser_scroll. Cheaper and more exact than a screenshot; refs change after each snapshot or page change. Hidden text is not included.",
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
        if (what === "front") await b.frontTab(input, ctx.signal);
        return { output: await run(input, ctx, async (p) => (what === "front" ? undefined : await p.history(what as "back"), snapshotText(p))) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_close_tab",
        description: "Close a tab (tabId from browser_tabs; leave out for the one in front).",
        inputSchema: { type: "object", properties: tab },
      },
      preview: async (input, ctx) => `Close the tab${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const id = await b.closeTab(input, ctx.signal);
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
    {
      risk: "write",
      spec: {
        name: "browser_inspect",
        description: "Inspect one element like DevTools' Elements panel: tag, attributes, box (place and size), the styles that decide its layout and look, whether its content is cut off, its text and HTML. Give its ref from browser_snapshot, or x and y of the last browser_screenshot. For checking a page you are building.",
        inputSchema: { type: "object", properties: { ref: refArg.ref, x: { type: "number" }, y: { type: "number" }, ...tab } },
      },
      preview: async (input, ctx) => `Inspect ${input.ref ? await label(input, ctx) : `the element at (${Math.round(Number(input.x))}, ${Math.round(Number(input.y))})`}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const at = input.ref ? { ref: String(input.ref) } : { x: Number(input.x), y: Number(input.y) };
        return { output: await run(input, ctx, async (p) => untrusted(await source(p, "element"), inspectText(await p.inspect(at)))) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_emulate",
        description: "Show the page as a phone (390 px wide, touch), a desktop (1280 px) or at the browser's own size (reset), and in dark or light colors (scheme: dark, light, auto). It stays until changed. To check a design at 390 px and on a desktop at once, use browser_try_change.",
        inputSchema: { type: "object", properties: { device: { type: "string", enum: ["phone", "desktop", "reset"] }, scheme: { type: "string", enum: ["dark", "light", "auto"] }, ...tab } },
      },
      preview: async (input, ctx) => `Show the page as ${[input.device ? ({ phone: "a 390 px phone", desktop: "a desktop", reset: "its own size" } as Record<string, string>)[String(input.device)] : "", input.scheme ? `${String(input.scheme)} colors` : ""].filter(Boolean).join(", ") || "it is"}${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const device = input.device === "reset" ? "none" : input.device === "phone" || input.device === "desktop" ? input.device : undefined;
        const scheme = input.scheme === "dark" || input.scheme === "light" || input.scheme === "auto" ? input.scheme : undefined;
        if (!device && !scheme) throw new Error("Give device (phone, desktop, reset) or scheme (dark, light, auto).");
        return {
          output: await run(input, ctx, async (p) => {
            const e = await p.emulate({ ...(device ? { device } : {}), ...(scheme ? { scheme } : {}) });
            return snapshotText(p, `Now: ${e.device === "none" ? "the browser's own size" : e.device === "phone" ? "a 390 px phone" : "a 1280 px desktop"}, ${e.scheme === "auto" ? "the page's own colors" : `${e.scheme} colors`}.`);
          }),
        };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_try_change",
        description: "\"Try my change\" after editing a web page you are building: reloads the tab, then gives the console errors and warnings and the failed requests since the reload, and pictures of the page at 390 px (phone) and 1280 px (desktop), with whether it is wider than the screen (side scroll or cut text).",
        inputSchema: { type: "object", properties: tab },
      },
      preview: async (input, ctx) => `Reload and check the page at 390 px and on a desktop${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        const r = await run(input, ctx, (p) => p.tryChange());
        const lines = [
          `Reloaded ${redactUrl(r.url)}.`,
          r.errors.length ? `Console errors and warnings (${r.errors.length}):\n${r.errors.map((l) => `[${l.level}] ${l.text}${l.where ? ` (${l.where})` : ""}`).join("\n")}` : "Console: no errors or warnings.",
          r.failed.length ? `Failed requests (${r.failed.length}):\n${r.failed.map((q) => `#${q.n} ${q.method} ${q.failed ? `FAILED (${q.failed})` : q.status} ${redactUrl(q.url)}`).join("\n")}` : "Network: no failed requests.",
          ...r.views.map((v) => `${v.device === "phone" ? "Phone, 390 px" : "Desktop, 1280 px"}: ${v.overflow ? `${v.overflow} px wider than the screen (side scroll or cut content)` : "fits the width"}.`),
          "The two pictures follow: the phone first, then the desktop.",
        ];
        const images = r.views.map((v) => ({ mimeType: "image/png", data: v.data.toString("base64") }));
        const ids = h.saveAsset ? (await Promise.all(r.views.map((v) => h.saveAsset!(v.data, "image/png").catch(() => undefined)))).filter((x): x is string => !!x) : [];
        return { output: untrusted(hostOf(r.url) ?? "the page", lines.join("\n\n")), images, ...(ids.length ? { assetIds: ids } : {}) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_record",
        description: "Record what happens in a tab as a GIF (or a WebM video when FFmpeg is on the computer): action start, then do the steps (click, type…), then action stop to get the file in the chat. Stops by itself after 60 s.",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop"] }, format: { type: "string", enum: ["gif", "webm"] }, ...tab }, required: ["action"] },
      },
      preview: async (input, ctx) => `${input.action === "stop" ? "Stop recording" : "Record"} the tab${await h.onSite(input, ctx.signal)}`,
      run: async (input, ctx) => {
        if (input.action === "start") return { output: await run(input, ctx, async (p) => (await p.startRecording(), "Recording. Do the steps, then browser_record with action stop.")) };
        if (input.action !== "stop") throw new Error("action is start or stop.");
        const frames = await run(input, ctx, (p) => p.stopRecording());
        const file = await encodeRecording(frames, input.format === "webm" ? "webm" : "gif", h.ffmpeg);
        const id = h.saveAsset ? await h.saveAsset(file.data, file.mimeType).catch(() => undefined) : undefined;
        const kind = file.mimeType === "video/webm" ? "WebM video" : "GIF";
        return { output: `${file.note ? `${file.note} ` : ""}Recorded ${frames.length} frames as a ${kind}${id ? "; it is shown in the chat" : ""}.`, ...(id ? { assetIds: [id] } : {}) };
      },
    },
  ];
}
