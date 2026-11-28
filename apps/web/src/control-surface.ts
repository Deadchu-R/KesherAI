/**
 * The computer-control chat surface (surfaces.ts; design ChatControlSurface): the logic of its card and panel, with no
 * React and no network so it is tested on its own. The panel is `ControlLive` (the live view, the steps list and Stop;
 * ControlLive.tsx); on the phone it is view + ask.
 */
import type { ChatSurface } from "./surfaces";

/** The agent tools that act on the computer (the browser tools are not a screen the user needs to watch). */
export const CONTROL_TOOLS = /^computer_[a-z_]+$/;

/** The one item a chat has for it (a chat controls one computer): its id. */
export const CONTROL_ITEM = "live";

/**
 * The control item a tool step makes: any successful `computer_*` step opens the same single item.
 *
 * @param tool - The tool's name.
 * @param ok - Whether the step worked.
 * @returns The item, or undefined (another tool or a failed step).
 */
export function controlFromResult(tool: string, ok: boolean): { kind: string; id: string; title: string } | undefined {
  return ok && CONTROL_TOOLS.test(tool) ? { kind: "control", id: CONTROL_ITEM, title: "Computer control" } : undefined;
}

/**
 * The message "Ask about this" sends: the question, with a note of which screen it is about.
 *
 * @param question - What the user typed.
 * @param he - Write the note in Hebrew.
 * @param goal - The running task's goal, when there is one.
 * @returns The chat message.
 */
export function controlAskMessage(question: string, he: boolean, goal?: string): string {
  const g = goal?.trim().slice(0, 200);
  const head = he ? `על מה שקורה עכשיו במחשב${g ? ` (המשימה: ${g})` : ""}:` : `About what is on the computer now${g ? ` (task: ${g})` : ""}:`;
  return `${head}\n\n${question.trim()}`;
}

/** The control surface: a small card in the message and a panel with the live view; the phone watches and asks. */
export const controlSurface: ChatSurface = {
  id: "control",
  title: { he: "שליטה במחשב", en: "Computer control" },
  kinds: ["control"],
  fromResult: (tool, ok) => controlFromResult(tool, ok),
  card: () => import("./ControlSurface").then((m) => ({ default: m.ControlCard })),
  panel: () => import("./ControlSurface").then((m) => ({ default: m.ControlPanel })),
  panelClass: "control-panel",
  tools: ["computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_open_app"],
  phone: "view+ask",
  versions: "none",
};
