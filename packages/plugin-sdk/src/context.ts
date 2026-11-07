import type { CategoryDefinition } from "@kesher/shared";
import type { ProviderFactory } from "@kesher/providers";

/**
 * A JSON Schema object describing a tool's input. Kept as a plain object so
 * it can be sent to any model API unchanged.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * A function that models can call.
 *
 * Tools registered by plugins are listed at `GET /api/tools` and can be run
 * with `POST /api/tools/<name>`. Chat models, the code agent and Pipelines
 * use the same list.
 *
 * @typeParam I - Input type, matching `inputSchema`.
 */
export interface KesherTool<I = Record<string, unknown>> {
  /** `snake_case` name, unique across all plugins. Prefix it with your plugin id if in doubt. */
  name: string;
  /** What the tool does and when to use it. Models read this, so be specific. */
  description: string;
  /** JSON Schema for the input. */
  inputSchema: JsonSchema;
  /**
   * Runs the tool. Return a string (shown to the model) or any JSON value.
   * Throw an `Error` to report failure; its message is shown to the model.
   */
  run(input: I, signal: AbortSignal): Promise<unknown>;
}

/** A small logger that prefixes every line with the plugin id. */
export interface PluginLogger {
  /** Logs an informational message. */
  info(message: string, data?: unknown): void;
  /** Logs a warning. */
  warn(message: string, data?: unknown): void;
  /** Logs an error. */
  error(message: string, data?: unknown): void;
}

/**
 * What a plugin's `activate` function receives. Every `register*` call is
 * undone automatically when the plugin is disabled or the app quits, so
 * plugins do not need to clean up after them.
 */
export interface PluginContext {
  /** The plugin's id from its manifest. */
  readonly pluginId: string;
  /** A folder only this plugin writes to. Created before `activate` runs. */
  readonly dataDir: string;
  /** The user's settings for this plugin (from the app config), or `{}`. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Logger. */
  readonly log: PluginLogger;

  /**
   * Makes a new provider type available in "Add connection". Users then
   * create providers of this type like any built-in one.
   */
  registerProviderFactory(factory: ProviderFactory): void;

  /** Adds a model category, e.g. `"upscale"` or `"lip-sync"`. */
  registerCategory(category: CategoryDefinition): void;

  /** Adds a tool models can call. */
  registerTool(tool: KesherTool): void;
}
