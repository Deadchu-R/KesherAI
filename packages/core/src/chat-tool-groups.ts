/**
 * Tool groups a chat gets (docs/ARCHITECTURE_REVIEW.md C1): each group gives its tools and the lines its tools need
 * in the system prompt, decided in one place. Media is in chat-tools-media.ts, the game engines in
 * chat-tools-games.ts; this file has the computer-control group and the rule for chats written from Telegram.
 */
import type { AgentTool } from "@kesher/agent";

/** What a group gives a chat. */
export interface ToolGroup {
  tools: AgentTool[];
  /** Lines for the system prompt (only when the group has tools). */
  notes: string[];
}

/** How to use the screen well (computer use): look before and after, batch what is predictable. */
export const COMPUTER_NOTE =
  "You can see and control this computer: first computer_use_app (the user approves each app), computer_open_app to bring it to the front, then computer_screenshot → act → check. When you can predict several steps (click a field, type, press enter), send them in one computer_batch, which returns one screenshot at the end; use computer_zoom to read small text. Never assume an action worked: look. Prefer your other tools (files, run_command, build_executable) when they can do the job; use the screen for apps that have no other way in (Unity, Blender, Office, settings dialogs). Browsers are view-only, terminals click-only, and you never type passwords or payment details.";

/**
 * The computer-control group: the screen tools and their note.
 *
 * @param tools - The computer tools this chat may use (none when computer control is off).
 * @returns The group.
 */
export function computerGroup(tools: AgentTool[]): ToolGroup {
  return { tools, notes: tools.length ? [COMPUTER_NOTE] : [] };
}

/** Tools a chat written from Telegram never gets: the screen, the browser, and what runs code in a game engine. */
export const NOT_FROM_TELEGRAM = /^(computer_|browser_|unity_script_eval$|unity_write_script$|unreal_(write_source|python|compile|package|create_project|open_editor|port_plugin)$|android_run_on_phone$)/;

/**
 * A chat written from Telegram (someone with the bot's chat, away from the computer): it never controls the screen
 * or the browser, whatever else is on, and the model is told so.
 *
 * @param g - The chat's tools and notes.
 * @returns Them without the tools a Telegram chat must not have, and with its note.
 */
export function forTelegram(g: ToolGroup): ToolGroup {
  return {
    tools: g.tools.filter((t) => !NOT_FROM_TELEGRAM.test(t.spec.name)),
    notes: [...g.notes.filter((n) => n !== COMPUTER_NOTE), "This chat is written from Telegram: you cannot control the screen or the browser here, and every change asks the user first."],
  };
}
