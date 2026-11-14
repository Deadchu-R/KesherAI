import { randomUUID } from "node:crypto";
import { siteIcon } from "./site-icon.js";
import { AgentSession, type AgentTool, type ModelTurn } from "@kesher/agent";
import { cleanShortcut, type Shortcut } from "./menu-shortcuts.js";

/**
 * The design assistant: the small 🎨 panel next to the bell. The user says in words how KesherAI should look
 * ("lighter", "a One Piece look", "bigger text") or how the side menu should be ("put Models first", "add a
 * shortcut to my GitHub"), and a short agent run does it with two tools only: change_look (the same tool chats
 * have) and change_menu (below). Nothing else is reachable from it: no files, no commands, no web pages.
 *
 * How others do it (docs/RESEARCH_LOG.md, 2026-11-13): Notion, Linear and Slack customize the sidebar by hand
 * (edit mode, drag, hide); Arc and Raycast theme by picking; LobeHub has a theme panel. A prompt box for looks
 * and the menu in one small panel is KesherAI's own: the same things by hand stay in the sidebar's ✏️ and in
 * Settings → Appearance.
 */

/** What change_menu reads and changes. */
export interface MenuStore {
  /** The pinned tools, in order (null: the defaults). */
  pins(): string[] | null;
  setPins(next: string[]): Promise<void>;
  shortcuts(): Shortcut[];
  setShortcuts(next: Shortcut[]): Promise<void>;
}

/** A page the menu can show. */
export interface MenuPage {
  href: string;
  label: string;
}

/**
 * The change_menu tool: pin, unpin and reorder tools in the side menu, and add, rename, reorder or remove the
 * user's shortcuts.
 *
 * @param store - The menu, as kept on the computer.
 * @param pages - The app's pages (their address and name in the user's language).
 * @param fallbackPins - The pins shown when the user never changed them.
 * @returns The tool.
 */
export function menuTool(store: MenuStore, pages: MenuPage[], fallbackPins: string[]): AgentTool {
  const known = new Map(pages.map((p) => [p.href, p.label]));
  const list = pages.map((p) => `${p.href} (${p.label})`).join(", ");
  return {
    risk: "safe",
    spec: {
      name: "change_menu",
      description:
        `Change KesherAI's side menu (the same menu on the computer and the phone). pins: the tools shown in the menu, top to bottom (give the whole list in the order wanted; leave a page out to take it off the menu). addShortcuts / removeShortcuts / shortcutOrder: the user's own shortcuts. Every field is optional. Pages: ${list}.`,
      inputSchema: {
        type: "object",
        properties: {
          pins: { type: "array", items: { type: "string" }, description: "Page addresses (#/…), the whole list in order." },
          addShortcuts: {
            type: "array",
            items: { type: "object", properties: { label: { type: "string" }, href: { type: "string", description: "A page (#/…) or a web address (https://…)." }, icon: { type: "string", description: "One emoji." }, iconFromSite: { type: "boolean", description: "For a web address: use the site's own icon (fetched from the site) instead of an emoji, when the user asks for its icon." } }, required: ["label", "href"] },
          },
          removeShortcuts: { type: "array", items: { type: "string" }, description: "Names (or addresses) of shortcuts to remove." },
          shortcutOrder: { type: "array", items: { type: "string" }, description: "Shortcut names, in the order wanted (the rest keep their order after them)." },
        },
      },
    },
    run: async (input) => {
      const said: string[] = [];
      if (Array.isArray(input.pins)) {
        const next = [...new Set((input.pins as unknown[]).filter((p): p is string => typeof p === "string" && known.has(p)))];
        const unknown = (input.pins as unknown[]).filter((p) => typeof p !== "string" || !known.has(p));
        if (next.length) {
          await store.setPins(next);
          said.push(`The menu now shows, in order: ${next.map((h) => known.get(h)).join(", ")}.`);
        }
        if (unknown.length) said.push(`Not pages of KesherAI (left out): ${unknown.map(String).join(", ")}.`);
      }
      let shortcuts = store.shortcuts();
      let changed = false;
      const same = (s: Shortcut, name: string) => s.label.toLowerCase() === name.toLowerCase() || s.href === name;
      if (Array.isArray(input.removeShortcuts)) {
        const names = (input.removeShortcuts as unknown[]).map(String);
        const before = shortcuts.length;
        shortcuts = shortcuts.filter((s) => !names.some((n) => same(s, n)));
        if (shortcuts.length !== before) {
          changed = true;
          said.push(`Removed ${before - shortcuts.length} shortcut(s).`);
        } else said.push("No shortcut has that name.");
      }
      if (Array.isArray(input.addShortcuts)) {
        for (const raw of input.addShortcuts as Array<Partial<Shortcut>>) {
          if (shortcuts.length >= 25) {
            said.push("There are already 25 shortcuts (the most the menu takes).");
            break;
          }
          let image: string | undefined;
          if ((raw as { iconFromSite?: unknown }).iconFromSite === true && /^https?:/i.test(String(raw?.href ?? ""))) {
            image = await siteIcon(String(raw.href)).catch((e: Error) => {
              said.push(`No icon from the site for ${String(raw?.label ?? "")}: ${e.message}`);
              return undefined;
            });
          }
          const c = cleanShortcut({ ...raw, ...(image ? { image } : {}), id: randomUUID() });
          if ("error" in c) said.push(`Not added (${String(raw?.label ?? "")}): ${c.error}`);
          else if (shortcuts.some((s) => s.href === c.href)) said.push(`${c.label} is already a shortcut.`);
          else {
            shortcuts = [...shortcuts, c];
            changed = true;
            said.push(`Added the shortcut ${c.label}.`);
          }
        }
      }
      if (Array.isArray(input.shortcutOrder)) {
        const names = (input.shortcutOrder as unknown[]).map(String);
        const first = names.flatMap((n) => shortcuts.filter((s) => same(s, n)));
        const next = [...new Set([...first, ...shortcuts])];
        if (next.some((s, i) => s !== shortcuts[i])) {
          shortcuts = next;
          changed = true;
          said.push("Shortcuts reordered.");
        }
      }
      if (changed) await store.setShortcuts(shortcuts);
      if (!said.length) {
        const pins = store.pins() ?? fallbackPins;
        return { output: `Nothing to change. Now in the menu: ${pins.map((h) => known.get(h) ?? h).join(", ") || "(nothing pinned)"}. Shortcuts: ${store.shortcuts().map((s) => s.label).join(", ") || "(none)"}.` };
      }
      return { output: said.join(" ") };
    },
  };
}

/**
 * Runs one request of the design assistant to its end.
 *
 * @param o.text - What the user asked.
 * @param o.tools - change_look and change_menu.
 * @param o.modelId - The chat model.
 * @param o.model - Its turn function.
 * @param o.state - One line saying what the menu shows now.
 * @param o.hebrew - Whether to answer in Hebrew.
 * @param o.signal - Stops it.
 * @returns The assistant's short answer and the tools it used.
 */
export async function runDesigner(o: { text: string; tools: AgentTool[]; modelId: string; model: ModelTurn; state: string; hebrew: boolean; contextTokens?: number; signal: AbortSignal }): Promise<{ reply: string; used: string[] }> {
  const s = new AgentSession({
    id: `design-${randomUUID()}`,
    modelId: o.modelId,
    model: o.model,
    // Its two tools are safe ones (looks and the menu only), so nothing waits for an approval.
    mode: "auto",
    tools: o.tools,
    systemPrompt:
      `You are KesherAI's design assistant, in a small panel of the app. The user asks, in a few words, to change how the app looks or how its side menu is arranged. Do it with your tools: change_look for looks (colours, font, text size, corners, spacing, background, icons, a named style), change_menu for the side menu (which tools are pinned and their order, the user's shortcuts). Act at once; do not ask unless the request cannot be understood. Then answer in one short sentence saying what changed${o.hebrew ? ", in Hebrew" : ""}. If asked for anything else, say this panel only changes the look and the menu. ${o.state}`,
    maxSteps: 6,
    contextTokens: o.contextTokens ?? 12_000,
  });
  let last = "";
  const used: string[] = [];
  const done = new Promise<void>((resolve) => {
    s.on("event", (e) => {
      if (e.type === "assistant") last = e.text;
      else if (e.type === "tool_call") used.push(e.name);
      else if (e.type === "question") s.answer(e.questionId, "(Decide yourself and say what you chose.)");
      else if (e.type === "approval_request") s.approve(e.requestId, "deny", "This panel only changes the look and the menu.");
      else if (e.type === "status" && (e.status === "idle" || e.status === "error")) resolve();
    });
  });
  const stop = () => s.stop();
  o.signal.addEventListener("abort", stop, { once: true });
  try {
    s.send(o.text);
    await done;
  } finally {
    o.signal.removeEventListener("abort", stop);
  }
  return { reply: last.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim(), used };
}
