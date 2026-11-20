/**
 * computer_find and browser_find_visual (Phase 6): "the blue Save button" → where it is. The accessibility tree is
 * asked first (Windows UI Automation for apps, the page's accessibility snapshot for the browser): a control named
 * like the description is surer and faster than any picture. Only when nothing there matches does the local vision
 * model look at a screenshot (canvases, games, icons without names, custom-drawn apps).
 *
 * The tools only look: they return a point (and a crop around it, so the main model can check) and the click goes
 * through computer_click / browser_click_at, whose approval cards show the same crop. Without an installed vision
 * model they say so and the chat shows the Install button with the model's size and drive.
 */
import type { AgentTool } from "@kesher/agent";
import { bestNameMatch, foundText, type GroundResult } from "./vision-ground.js";
import type { Grounding, VisionMissing } from "./vision-service.js";

/** The marker the chat turns into an Install button (Activity.tsx), e.g. `[offer_install:vision-model]`. */
export const OFFER_MARK = (id: string) => `[offer_install:${id}]`;

/**
 * The tool's answer when no vision model is installed.
 *
 * @param m - What would be installed.
 */
export function missingText(m: VisionMissing): string {
  return `Nothing named like that in the accessibility tree, and no vision model is installed to look at the screen. The chat now shows an Install button for ${m.name} (${m.sizeGb} GB, saved in ${m.where}). Tell the user in one short sentence and stop; after it is installed the chat continues by itself. ${OFFER_MARK(m.installId)}`;
}

/** A picture of the screen or the page, in its own pixels. */
export interface Picture {
  png: Buffer;
  width: number;
  height: number;
}

/** What computer_find needs from ComputerControl. */
export interface ComputerFindHost {
  /** @throws Error when computer control is off or stopped. */
  gate(): void;
  /** A fresh screenshot; later clicks map from its pixels. */
  shoot(): Promise<Picture>;
  /** A control of the window in front named like the description, with its centre in the screenshot's pixels. */
  treeMatch?(query: string, signal?: AbortSignal): Promise<{ x: number; y: number; label: string; ref: string } | undefined>;
  /** A picture around a point of the screenshot (for the model to check). */
  around?(x: number, y: number): Promise<Buffer | undefined>;
  record(action: string, ok: boolean, note?: string): void;
  vision(): Grounding | undefined;
}

const QUERY = { query: { type: "string", description: "What to find, as a person would say it: 'the blue Save button', 'the gear icon at the top right'." } };

/** The answer for a vision result, with the crop when there is one. */
async function visionAnswer(r: GroundResult, clickTool: string, around?: (x: number, y: number) => Promise<Buffer | undefined>) {
  if (!r.found) return { output: `Not found on the screenshot: ${r.why} Try other words, scroll, or bring the right window to the front.` };
  const crop = await around?.(r.x, r.y).catch(() => undefined);
  return { output: foundText(r, clickTool), ...(crop ? { images: [{ mimeType: "image/png", data: crop.toString("base64") }] } : {}) };
}

/**
 * computer_find: the accessibility tree first, then the vision model on a screenshot.
 *
 * @param h - ComputerControl's side.
 */
export function computerFindTool(h: ComputerFindHost): AgentTool {
  return {
    risk: "read",
    spec: {
      name: "computer_find",
      description:
        "Find a thing on the screen by describing it ('the blue Save button', 'the play icon'). Looks in the window's controls first, then asks the local vision model to look at a screenshot. Returns x, y in screenshot pixels for computer_click (which still asks the user) and a crop to check. Use it when computer_tree has no match (games, Unity/Unreal, canvases, icons without names).",
      inputSchema: { type: "object", properties: QUERY, required: ["query"] },
    },
    run: async (input, ctx) => {
      h.gate();
      const query = String(input.query ?? "").trim();
      if (!query) throw new Error("Say what to find, e.g. 'the blue Save button'.");
      const hit = await h.treeMatch?.(query, ctx.signal).catch(() => undefined);
      if (hit) {
        h.record(`found "${query.slice(0, 60)}" in the controls`, true);
        return { output: `Found in the window's controls: ${hit.label} (ref ${hit.ref}), at x=${hit.x}, y=${hit.y} in the screenshot's pixels. Prefer computer_invoke with ref ${hit.ref}; or computer_click at that point.` };
      }
      const v = h.vision();
      if (!v?.model()) return { output: missingText((v ?? fallbackMissing).missing()) };
      const shot = await h.shoot();
      const r = await v.ground({ ...shot, query, signal: ctx.signal });
      h.record(`looked for "${query.slice(0, 60)}" with ${r.model}`, r.found, r.found ? undefined : r.why);
      return visionAnswer(r, "computer_click", h.around);
    },
  };
}

/** What browser_find_visual needs from the browser tools. */
export interface BrowserFindHost {
  /** An element of the page's accessibility snapshot named like the description (refreshes the refs). */
  snapshotMatch(input: Record<string, unknown>, query: string, signal?: AbortSignal): Promise<{ ref: string; label: string } | undefined>;
  /** A picture of the visible area; browser_click_at maps from its pixels. */
  shot(input: Record<string, unknown>, signal?: AbortSignal): Promise<Picture>;
  /** A picture around a point of that picture. */
  around?(input: Record<string, unknown>, x: number, y: number, signal?: AbortSignal): Promise<Buffer | undefined>;
  vision(): Grounding | undefined;
  /** The tab arguments (tabId, browser). */
  tabArg: Record<string, unknown>;
}

/**
 * browser_find_visual: the page's accessibility snapshot first, then the vision model on the visible area.
 *
 * @param h - The browser tools' side.
 */
export function browserFindTool(h: BrowserFindHost): AgentTool {
  return {
    risk: "read",
    spec: {
      name: "browser_find_visual",
      description:
        "Find a thing on the page by describing how it looks ('the red heart icon', 'the arrow to the next photo'). Looks in the page's accessibility snapshot first (then answers with a ref for browser_click), else asks the local vision model to look at the visible area and answers x, y for browser_click_at (which still asks the user) with a crop to check. Use it when browser_snapshot has no match (canvases, maps, icons without labels).",
      inputSchema: { type: "object", properties: { ...QUERY, ...h.tabArg }, required: ["query"] },
    },
    run: async (input, ctx) => {
      const query = String(input.query ?? "").trim();
      if (!query) throw new Error("Say what to find, e.g. 'the blue Save button'.");
      const hit = await h.snapshotMatch(input, query, ctx.signal).catch(() => undefined);
      if (hit) return { output: `Found in the page's accessibility snapshot: ${hit.label} [ref=${hit.ref}]. Use browser_click with ref ${hit.ref} (refs from older snapshots are gone).` };
      const v = h.vision();
      if (!v?.model()) return { output: missingText((v ?? fallbackMissing).missing()) };
      const shot = await h.shot(input, ctx.signal);
      const r = await v.ground({ ...shot, query, signal: ctx.signal });
      return visionAnswer(r, "browser_click_at", h.around ? (x, y) => h.around!(input, x, y, ctx.signal) : undefined);
    },
  };
}

/** The offer when the app has no vision service at all (a worker process): the default model, saved where Settings says. */
const fallbackMissing = { missing: (): VisionMissing => ({ installId: "vision-model", name: "Qwen3-VL 8B", sizeGb: 6.2, where: "the heavy-data folder" }) };

/**
 * The elements of an accessibility snapshot's text (`- button "Save" [ref=e12]`), for {@link bestNameMatch}.
 *
 * @param tree - CdpPage.snapshot's text.
 * @returns Each element with a ref: its ref, role and name.
 */
export function snapshotElements(tree: string): Array<{ ref: string; role: string; name: string }> {
  const out: Array<{ ref: string; role: string; name: string }> = [];
  for (const line of tree.split("\n")) {
    const m = /^\s*- (\w+)(?: "((?:[^"\\]|\\.)*)")?.*\[ref=(e\d+)\]/.exec(line);
    if (m && m[2]) out.push({ ref: m[3]!, role: m[1]!, name: m[2] });
  }
  return out;
}

/**
 * The element of a snapshot named like a description.
 *
 * @param tree - The snapshot's text.
 * @param query - The description.
 */
export function matchSnapshot(tree: string, query: string): { ref: string; label: string } | undefined {
  const e = bestNameMatch(query, snapshotElements(tree));
  return e ? { ref: e.ref, label: `${e.role} "${e.name}"` } : undefined;
}
