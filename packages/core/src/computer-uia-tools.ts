import type { AgentTool } from "@kesher/agent";
import type { Foreground } from "./computer.js";
import type { UiaClient } from "./uia-worker.js";
import { CLIPBOARD_ASK, NAV_KEYS, appContent, keysToVk, uiaVerdict, type UiaAction, type UiaTarget } from "./computer-safety.js";

/**
 * Computer tools over Windows UI Automation (Phase 5): read a window's controls with refs, act on them by ref (no
 * mouse), list and move windows between monitors, wait for something to appear, hold keys, the clipboard, and the
 * parity actions (cursor position, middle and triple click, mouse down/up). The rules of computer.ts still apply (on
 * in Settings, per-app approval with computer_use_app, Stop); computer-safety.ts adds the never and always-ask lists.
 */

/** A window, as the worker reports it. `rect` is x, y, width, height in physical desktop pixels. */
export interface UiaWindow {
  handle: number;
  title: string;
  app: string;
  pid?: number;
  rect?: [number, number, number, number] | null;
  monitor?: number;
  minimized?: boolean;
  front?: boolean;
}

/** A monitor: 1-based index, whole bounds and the part without the taskbar. */
export interface UiaMonitor {
  index: number;
  primary: boolean;
  bounds: [number, number, number, number];
  work: [number, number, number, number];
}

/** One control of a window's tree. */
export interface UiaNode {
  ref: string;
  depth: number;
  type: string;
  name: string;
  id?: string;
  value?: string;
  readonly?: boolean;
  enabled?: boolean;
  password?: boolean;
  offscreen?: boolean;
  rect?: [number, number, number, number];
  patterns?: string[];
  toggle?: string;
  expand?: string;
  selected?: boolean;
}

/** What a ref points at: the control and its window. */
export interface UiaRef {
  node: UiaNode;
  window: UiaWindow;
}

/** What the tools need from ComputerControl for one conversation. */
export interface UiaHost {
  conversationId: string;
  uia: UiaClient;
  /** @throws Error when computer control is off, stopped, or no app is allowed yet. */
  gate(): void;
  /** Checks the app in front before a mouse or key action (allowed, browser and terminal rules). */
  check(need: "click" | "type"): Promise<Foreground>;
  /** @returns Whether the user allowed this app (computer_use_app) in this conversation. */
  allows(app: string): boolean;
  /** Logs an action (the status log, the banner, the phone). */
  record(action: string, app: string, ok: boolean, note?: string): void;
  /** Screenshot pixels → desktop pixels (the last computer_screenshot). */
  toScreen(x: unknown, y: unknown): { x: number; y: number };
  /** Desktop pixels → screenshot pixels, or undefined before the first screenshot. */
  toShot(x: number, y: number): { x: number; y: number } | undefined;
  /** This conversation's refs (they expire on the next computer_tree). */
  refs: Map<string, UiaRef>;
  /** The app in front as last seen (for always-ask rules that must answer at once). */
  lastFront(): Foreground | undefined;
  /** A picture of a part of the screen (physical pixels), when the platform can. */
  zoom?(x: number, y: number, w: number, h: number, maxWidth: number): Promise<{ png: Buffer; width: number; height: number }>;
}

/** What the tool's card and log call an element: `button "Save"`. */
export function describeNode(n: Pick<UiaNode, "type" | "name">): string {
  const type = (n.type || "element").toLowerCase();
  return n.name ? `${type} "${n.name.slice(0, 80)}"` : type;
}

/** What the card and log call a window: `notepad ("Untitled - Notepad")`. */
export function describeWindow(w: Pick<UiaWindow, "app" | "title">): string {
  return `${w.app || "an app"}${w.title ? ` ("${w.title.slice(0, 80)}")` : ""}`;
}

const ACTIONS: Record<string, string> = {
  Invoke: "invoke",
  Toggle: "toggle",
  SelectionItem: "select",
  ExpandCollapse: "expand/collapse",
  Value: "set_value",
};

/**
 * One tree line: ref, type, name, id, value, state, what can be done, and the centre in screenshot pixels.
 *
 * @param n - The control.
 * @param at - Desktop → screenshot pixels, when a screenshot was taken.
 * @returns The line, indented by depth.
 */
export function nodeLine(n: UiaNode, at?: (x: number, y: number) => { x: number; y: number } | undefined): string {
  const bits = [`${n.ref} ${n.type}${n.name ? ` "${n.name}"` : ""}`];
  if (n.id) bits.push(`id=${n.id}`);
  if (n.password) bits.push("(password field)");
  else if (n.value !== undefined && n.value !== "") bits.push(`value="${n.value}"`);
  if (n.toggle) bits.push(`toggle=${n.toggle}`);
  if (n.expand && n.expand !== "LeafNode") bits.push(`expand=${n.expand}`);
  if (n.selected) bits.push("selected");
  if (n.enabled === false) bits.push("disabled");
  if (n.offscreen) bits.push("hidden");
  const acts = (n.patterns ?? []).map((p) => ACTIONS[p]).filter((a): a is string => !!a && !(a === "set_value" && (n.readonly || n.password)));
  if (acts.length) bits.push(`[${acts.join(", ")}]`);
  if (n.rect && at) {
    const c = at(n.rect[0] + n.rect[2] / 2, n.rect[1] + n.rect[3] / 2);
    if (c) bits.push(`@${Math.round(c.x)},${Math.round(c.y)}`);
  }
  return `${"  ".repeat(Math.min(n.depth, 15))}${bits.join(" ")}`;
}

/**
 * The UI Automation tools for one conversation.
 *
 * @param h - The host (ComputerControl for this conversation).
 * @returns The tools.
 */
export function uiaTools(h: UiaHost): AgentTool[] {
  const scope = h.conversationId.slice(0, 64);
  const call = <T>(op: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) =>
    h.uia.call<T>(op, { scope, ...args }, { ...(signal ? { signal } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const refOf = (input: Record<string, unknown>): UiaRef => {
    const r = h.refs.get(String(input.ref ?? "").trim());
    if (!r) throw new Error(`Ref "${String(input.ref ?? "")}" is unknown or expired: call computer_tree, then use a ref from it.`);
    return r;
  };
  const targetOf = (r: UiaRef): UiaTarget => ({ app: r.window.app, title: r.window.title, element: r.node });
  /** Throws for a never-verdict or an app the user did not allow. */
  const allowed = (action: UiaAction, t: UiaTarget) => {
    const v = uiaVerdict(action, t);
    if (v.kind === "never") throw new Error(v.reason);
    if (!h.allows(t.app))
      throw new Error(`${t.app || "This app"} is not allowed yet: call computer_use_app for it first.`);
  };
  /** The always-ask reason of a ref action, for the card (undefined: no extra yes needed). */
  const askFor = (action: UiaAction) => (input: Record<string, unknown>) => {
    const r = h.refs.get(String(input.ref ?? "").trim());
    if (!r) return undefined;
    const v = uiaVerdict(action, targetOf(r));
    return v.kind === "ask" ? v.reason : undefined;
  };
  const windows = (signal?: AbortSignal) => call<{ windows: UiaWindow[]; monitors: UiaMonitor[] }>("windows", {}, signal);
  const windowOf = async (input: Record<string, unknown>, signal?: AbortSignal): Promise<UiaWindow> => {
    const handle = Number(input.window);
    if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error("Give the window's number from computer_windows.");
    const w = (await windows(signal)).windows.find((x) => x.handle === handle);
    if (!w) throw new Error(`There is no window ${handle} now: call computer_windows again.`);
    return w;
  };
  const keep = (node: UiaNode, window: UiaWindow) => h.refs.set(node.ref, { node, window });
  const logged = async <T>(action: string, app: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      h.record(action, app, true);
      return out;
    } catch (e) {
      h.record(action, app, false, (e as Error).message);
      throw e;
    }
  };
  const xy = {
    x: { type: "integer", description: "From the left, in screenshot pixels." },
    y: { type: "integer", description: "From the top, in screenshot pixels." },
  };
  const windowArg = { window: { type: "integer", description: "The window's number from computer_windows. Leave out for the window in front." } };

  return [
    {
      risk: "read",
      spec: {
        name: "computer_windows",
        description:
          "List the open windows (number, app, title, monitor, in front or minimized) and the monitors. Use the number with computer_tree, computer_focus_window and computer_move_window.",
        inputSchema: { type: "object", properties: {} },
      },
      run: async (_input, ctx) => {
        h.gate();
        const r = await windows(ctx.signal);
        const lines = r.windows.map(
          (w) => `${w.handle} ${w.app} "${w.title}" monitor ${w.monitor ?? "?"}${w.front ? " (in front)" : ""}${w.minimized ? " (minimized)" : ""}`,
        );
        const mons = r.monitors.map((m) => `Monitor ${m.index}${m.primary ? " (main)" : ""}: ${m.bounds[2]}×${m.bounds[3]} at ${m.bounds[0]},${m.bounds[1]}`);
        h.record("listed windows", "", true);
        return { output: appContent("window list", `${mons.join("\n")}\n\nWindows:\n${lines.join("\n") || "(none)"}`) };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_tree",
        description:
          "Read a window's controls (buttons, fields, menus, lists) with refs like u12, their names, values and what can be done with them ([invoke], [toggle], [select], [expand/collapse], [set_value]) and @x,y = their centre in the last screenshot. Faster and surer than screenshots for normal apps; refs expire on the next computer_tree. Custom-drawn apps (games, Unity, Unreal, canvases) show little: use screenshots there.",
        inputSchema: {
          type: "object",
          properties: {
            ...windowArg,
            depth: { type: "integer", description: "How deep to read (default 8, at most 15)." },
            max: { type: "integer", description: "At most this many controls (default 200, at most 400)." },
            picture: { type: "boolean", description: "Also return a picture of the window." },
          },
        },
      },
      run: async (input, ctx) => {
        h.gate();
        const depth = Math.min(Math.max(Number(input.depth) || 8, 1), 15);
        const max = Math.min(Math.max(Number(input.max) || 200, 10), 400);
        const r = await call<{ window: UiaWindow; nodes: UiaNode[]; truncated?: boolean }>(
          "tree",
          { ...(input.window !== undefined ? { window: Number(input.window) } : {}), depth, max },
          ctx.signal,
          25_000,
        );
        const t = { app: r.window.app, title: r.window.title };
        // Read, but only shown for an allowed app; never for UAC or sign-in windows.
        allowed("read", t);
        h.refs.clear();
        for (const n of r.nodes) {
          if (n.password) delete n.value;
          keep(n, r.window);
        }
        const at = (x: number, y: number) => h.toShot(x, y);
        const head = `Window ${r.window.handle} ${describeWindow(r.window)} on monitor ${r.window.monitor ?? "?"}${r.window.front ? ", in front" : ""}. ${r.nodes.length} controls${r.truncated ? " (cut: ask for a deeper part with a smaller window, or more max)" : ""}:`;
        const body = r.nodes.map((n) => nodeLine(n, at)).join("\n");
        h.record(`read the controls of ${describeWindow(r.window)}`, r.window.app, true);
        const images: Array<{ mimeType: string; data: string }> = [];
        if (input.picture === true && h.zoom && r.window.rect && r.window.rect[2] > 8 && r.window.rect[3] > 8) {
          const [x, y, w, hh] = r.window.rect;
          const z = await h.zoom(x, y, w, hh, 1280).catch(() => undefined);
          if (z) images.push({ mimeType: "image/png", data: z.png.toString("base64") });
        }
        return { output: appContent(describeWindow(r.window), `${head}\n${body}`), ...(images.length ? { images } : {}) };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_invoke",
        description:
          "Act on a control by its ref from computer_tree, without the mouse (works even when the window is behind another): invoke (press a button or menu item), toggle (a check box), select (a list or tab item), expand or collapse (a menu, tree or combo box), focus.",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "The ref from computer_tree, e.g. u12." },
            action: { type: "string", enum: ["invoke", "toggle", "select", "expand", "collapse", "focus"], description: "Default invoke." },
          },
          required: ["ref"],
        },
      },
      askFirst: askFor("invoke"),
      preview: async (input) => {
        const r = refOf(input);
        return `${String(input.action ?? "invoke")} ${describeNode(r.node)} (ref ${r.node.ref}) in ${describeWindow(r.window)}.`;
      },
      run: async (input, ctx) => {
        h.gate();
        const r = refOf(input);
        const action = String(input.action ?? "invoke");
        if (!["invoke", "toggle", "select", "expand", "collapse", "focus"].includes(action)) throw new Error(`Unknown action "${action}".`);
        allowed("invoke", targetOf(r));
        const what = `${action} ${describeNode(r.node)}`;
        const out = await logged(what, r.window.app, () => call<{ node?: UiaNode | null }>("act", { ref: r.node.ref, action }, ctx.signal));
        if (out.node) keep({ ...out.node, depth: r.node.depth }, r.window);
        return { output: `Done: ${what} in ${describeWindow(r.window)}.${out.node ? ` Now: ${nodeLine({ ...out.node, depth: 0 })}` : ""} Check with computer_tree or a screenshot.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_set_value",
        description:
          "Set the text of a field (an edit box or combo box with [set_value]) by its ref from computer_tree, replacing what is there. Never for password fields.",
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string" }, value: { type: "string" } },
          required: ["ref", "value"],
        },
      },
      askFirst: askFor("set_value"),
      preview: async (input) => {
        const r = refOf(input);
        const v = String(input.value ?? "");
        return `Set ${describeNode(r.node)} (ref ${r.node.ref}) in ${describeWindow(r.window)} to:\n${v.slice(0, 300)}${v.length > 300 ? "…" : ""}`;
      },
      run: async (input, ctx) => {
        h.gate();
        const r = refOf(input);
        const value = String(input.value ?? "");
        if (value.length > 20_000) throw new Error("The value is longer than 20,000 characters.");
        allowed("set_value", targetOf(r));
        const what = `set ${describeNode(r.node)} (${value.length} characters)`;
        await logged(what, r.window.app, () => call("setValue", { ref: r.node.ref, value }, ctx.signal));
        return { output: `Done: ${what} in ${describeWindow(r.window)}.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_focus_window",
        description: "Bring a window (its number from computer_windows) to the front, restoring it when minimized.",
        inputSchema: { type: "object", properties: { window: { type: "integer" } }, required: ["window"] },
      },
      run: async (input, ctx) => {
        h.gate();
        const w = await windowOf(input, ctx.signal);
        allowed("focus", w);
        const out = await logged(`brought ${describeWindow(w)} to the front`, w.app, () => call<{ front: boolean }>("focus", { window: w.handle }, ctx.signal));
        return { output: out.front ? `${describeWindow(w)} is in front.` : `Windows did not let ${describeWindow(w)} come to the front; ask the user to click it, or use computer_open_app.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_move_window",
        description:
          "Move a window to a monitor (1, 2… from computer_windows), keeping its size and place where it fits; optionally x, y, width, height in that monitor's pixels (without the taskbar).",
        inputSchema: {
          type: "object",
          properties: {
            window: { type: "integer" },
            monitor: { type: "integer" },
            x: { type: "integer" },
            y: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
          },
          required: ["window", "monitor"],
        },
      },
      preview: async (input) => `Move window ${String(input.window)} to monitor ${String(input.monitor)}.`,
      run: async (input, ctx) => {
        h.gate();
        const w = await windowOf(input, ctx.signal);
        allowed("move", w);
        const monitor = Math.trunc(Number(input.monitor));
        if (!Number.isFinite(monitor) || monitor < 1 || monitor > 16) throw new Error("Give the monitor's number (1, 2…).");
        const opt = (k: string) => (Number.isFinite(Number(input[k])) && input[k] !== undefined ? { [k]: Math.trunc(Number(input[k])) } : {});
        const out = await logged(`moved ${describeWindow(w)} to monitor ${monitor}`, w.app, () =>
          call<{ rect: number[]; monitor: number }>("move", { window: w.handle, monitor, ...opt("x"), ...opt("y"), ...opt("width"), ...opt("height") }, ctx.signal),
        );
        return { output: `${describeWindow(w)} is on monitor ${out.monitor} at ${out.rect.slice(0, 2).join(",")}, ${out.rect[2]}×${out.rect[3]}. Take a new screenshot before clicking.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_wait",
        description:
          "Wait. With name: until a control whose name contains it appears in the window (or disappears, with gone), up to timeout seconds; it gets a ref. With window_title: until such a window opens (or closes). Without either: just wait seconds.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", description: "Only this control type, e.g. Button, Edit, Window." },
            ...windowArg,
            window_title: { type: "string" },
            gone: { type: "boolean" },
            timeout: { type: "number", description: "Seconds, default 10, at most 30." },
            seconds: { type: "number", description: "For a plain wait: seconds, at most 10." },
          },
        },
      },
      run: async (input, ctx) => {
        h.gate();
        const name = String(input.name ?? "").trim();
        const title = String(input.window_title ?? "").trim();
        if (!name && !title) {
          const s = Math.min(Math.max(Number(input.seconds) || 1, 0.1), 10);
          await new Promise((r) => setTimeout(r, s * 1000));
          h.gate();
          return { output: `Waited ${s} s.` };
        }
        const timeoutMs = Math.min(Math.max(Number(input.timeout) || 10, 0.5), 30) * 1000;
        const r = await call<{ met: boolean; node?: UiaNode; window?: UiaWindow }>(
          "wait",
          {
            ...(title ? { windowTitle: title } : { name, ...(input.type ? { type: String(input.type) } : {}) }),
            ...(input.window !== undefined ? { window: Number(input.window) } : {}),
            gone: input.gone === true,
            timeoutMs,
          },
          ctx.signal,
          timeoutMs + 5000,
        );
        const what = title ? `window "${title}"` : `"${name}"`;
        h.record(`waited for ${what}${input.gone ? " to go" : ""}: ${r.met ? "yes" : "timed out"}`, r.window?.app ?? "", true);
        if (!r.met) return { output: `Not met within ${timeoutMs / 1000} s: ${what} ${input.gone ? "is still there" : "did not appear"}.` };
        if (!r.node || !r.window) return { output: `Done: ${what} is gone.` };
        const v = uiaVerdict("read", r.window);
        if (v.kind === "never") return { output: `${what} appeared, in a window KesherAI never reads.` };
        if (!h.allows(r.window.app)) return { output: `${what} appeared in ${describeWindow(r.window)}, which is not allowed yet (computer_use_app).` };
        keep(r.node, r.window);
        return { output: appContent(describeWindow(r.window), `Appeared: ${nodeLine({ ...r.node, depth: 0 }, (x, y) => h.toShot(x, y))} in window ${r.window.handle} ${describeWindow(r.window)}.`) };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_hold_key",
        description: "Hold keys down for a time in the app in front (games, shift while clicking, arrow keys), then let go. E.g. keys w, seconds 2; keys shift+right, seconds 1.",
        inputSchema: {
          type: "object",
          properties: { keys: { type: "string" }, seconds: { type: "number", description: "0.05 to 10." } },
          required: ["keys", "seconds"],
        },
      },
      askFirst: (input) => {
        const fg = h.lastFront();
        const v = uiaVerdict("key", { app: fg?.app ?? "", title: fg?.title ?? "", keys: String(input.keys ?? "") });
        return v.kind === "ask" ? v.reason : undefined;
      },
      preview: async (input) => `Hold ${String(input.keys)} for ${Number(input.seconds) || 1} s in ${h.lastFront()?.app || "the app in front"}.`,
      run: async (input, ctx) => {
        const keys = String(input.keys ?? "").trim();
        const vks = keysToVk(keys);
        const ms = Math.round(Math.min(Math.max(Number(input.seconds) || 1, 0.05), 10) * 1000);
        const fg = await h.check(keys.split("+").every((k) => NAV_KEYS.test(k.trim())) ? "click" : "type");
        const v = uiaVerdict("key", { app: fg.app, title: fg.title, keys });
        if (v.kind === "never") throw new Error(v.reason);
        await logged(`held ${keys} for ${ms / 1000} s`, fg.app, () => call("holdKey", { keys: vks, ms }, ctx.signal, ms + 5000));
        return { output: `Held ${keys} for ${ms / 1000} s in ${fg.app}.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_cursor_position",
        description: "Where the mouse pointer is now, in screenshot pixels.",
        inputSchema: { type: "object", properties: {} },
      },
      run: async (_input, ctx) => {
        h.gate();
        const p = await call<{ x: number; y: number }>("cursor", {}, ctx.signal);
        const s = h.toShot(p.x, p.y);
        return { output: s ? `The pointer is at ${Math.round(s.x)},${Math.round(s.y)} in screenshot pixels.` : `The pointer is at ${p.x},${p.y} on the desktop; take a screenshot to map it.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_mouse",
        description:
          "Mouse actions besides click: middle_click, triple_click (select a line or paragraph), down and up (press and let go of the left button separately, for custom drags; always send up after down). At a point of the last screenshot.",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string", enum: ["middle_click", "triple_click", "down", "up"] }, ...xy },
          required: ["action", "x", "y"],
        },
      },
      run: async (input, ctx) => {
        const action = String(input.action ?? "");
        const kind = { middle_click: "middle", triple_click: "triple", down: "down", up: "up" }[action];
        if (!kind) throw new Error(`Unknown mouse action "${action}".`);
        const p = h.toScreen(input.x, input.y);
        // Pressing and moving with the button down drags, which can move files: like computer_drag, a typing-level act.
        const fg = await h.check(kind === "down" || kind === "up" ? "type" : "click");
        const v = uiaVerdict("mouse", fg);
        if (v.kind === "never") throw new Error(v.reason);
        await logged(`${action.replace("_", " ")} at ${input.x},${input.y}`, fg.app, () => call("mouse", { kind, x: Math.round(p.x), y: Math.round(p.y) }, ctx.signal));
        return { output: `Done: ${action.replace("_", " ")} at ${input.x},${input.y} in ${fg.app}. Take a screenshot to see the result.` };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_clipboard_read",
        description: "Read the text that is copied on this computer (asked every time).",
        inputSchema: { type: "object", properties: {} },
      },
      askFirst: () => CLIPBOARD_ASK.read,
      preview: async () => "Read what is copied on this computer (the clipboard).",
      run: async (_input, ctx) => {
        h.gate();
        const r = await logged("read the clipboard", "", () => call<{ text: string }>("clipboardGet", {}, ctx.signal));
        const text = r.text ?? "";
        return { output: appContent("clipboard", text ? text.slice(0, 20_000) + (text.length > 20_000 ? `\n… (${text.length - 20_000} more characters)` : "") : "(empty)") };
      },
    },
    {
      risk: "read",
      spec: {
        name: "computer_clipboard_write",
        description: "Put text on this computer's clipboard, e.g. to paste it with ctrl+v (asked every time).",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      askFirst: () => CLIPBOARD_ASK.write,
      preview: async (input) => {
        const t = String(input.text ?? "");
        return `Copy this text to the clipboard (it replaces what is copied now):\n${t.slice(0, 500)}${t.length > 500 ? "…" : ""}`;
      },
      run: async (input, ctx) => {
        h.gate();
        const text = String(input.text ?? "");
        if (!text) throw new Error("Give the text.");
        if (text.length > 100_000) throw new Error("The text is longer than 100,000 characters.");
        await logged(`copied ${text.length} characters to the clipboard`, "", () => call("clipboardSet", { text }, ctx.signal));
        return { output: `Copied ${text.length} characters to the clipboard.` };
      },
    },
  ];
}
