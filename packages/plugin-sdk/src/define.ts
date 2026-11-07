import type { PluginContext } from "./context.js";

/** The object a plugin's entry module default-exports. */
export interface KesherPlugin {
  /**
   * Called once when the plugin is enabled (and at every app start while it
   * stays enabled). Register providers, categories and tools here.
   */
  activate(context: PluginContext): void | Promise<void>;
  /** Optional. Called before the plugin is disabled or the app quits. */
  deactivate?(): void | Promise<void>;
}

/**
 * Declares a plugin. It only returns its argument, but gives you type
 * checking and editor autocompletion for the whole plugin API.
 *
 * @param plugin - `activate` and optional `deactivate`.
 * @returns The same object, to `export default`.
 *
 * @example
 * ```ts
 * import { definePlugin } from "@kesher/plugin-sdk";
 *
 * export default definePlugin({
 *   activate(ctx) {
 *     ctx.registerTool({
 *       name: "shout",
 *       description: "Returns the text in upper case.",
 *       inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
 *       run: async ({ text }) => String(text).toUpperCase(),
 *     });
 *   },
 * });
 * ```
 */
export function definePlugin(plugin: KesherPlugin): KesherPlugin {
  return plugin;
}
