import { z } from "zod";

/**
 * Version of the plugin API this SDK implements. The core server loads a
 * plugin only if its manifest's `kesher.apiVersion` has the same major
 * number.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * What a plugin may do. The user sees this list before enabling a plugin.
 *
 * - `network`: make outbound HTTP requests.
 * - `filesystem`: read and write outside its own data folder.
 * - `shell`: run programs on the user's computer.
 */
export const PluginPermissionSchema = z.enum(["network", "filesystem", "shell"]);

/** One permission; see {@link PluginPermissionSchema}. */
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/**
 * Schema of `kesher-plugin.json`, the file that marks a folder as a plugin.
 *
 * @example
 * ```json
 * {
 *   "id": "example-hello",
 *   "name": "Hello example",
 *   "version": "0.1.0",
 *   "description": "Adds an echo provider and a reverse_text tool.",
 *   "main": "dist/index.js",
 *   "kesher": { "apiVersion": 1 },
 *   "permissions": []
 * }
 * ```
 */
/** Relative path inside the plugin folder (no `..`, not absolute). */
const RelPath = z.string().regex(/^(?!\/)(?![a-zA-Z]:)(?!.*\.\.)[^\0]+$/, "a path inside the plugin folder");

/**
 * What a plugin adds to the interface. All of it is declarative: pages and
 * panels are HTML files the app shows in a sandboxed frame and talks to
 * through `window.kesher` (see docs/PLUGINS.md → Interface), so a mod
 * needs no build step.
 */
export const PluginUiSchema = z.object({
  /** Full pages, listed in the sidebar; shown at `#/p/<plugin>/<page>`. */
  pages: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), title: z.string(), icon: z.string().max(4).optional(), file: RelPath })).default([]),
  /** Panels a conversation can open next to the chat (a button in its top bar). */
  panels: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/), title: z.string(), file: RelPath })).default([]),
  /** Stylesheets added to the whole app: themes and visual mods. They can use and override the app's CSS variables. */
  styles: z.array(RelPath).default([]),
  /** Buttons in the composer that put a ready prompt into the message box. */
  composerActions: z.array(z.object({ id: z.string(), label: z.string(), prompt: z.string() })).default([]),
});

/**
 * A program on the user's computer the plugin lets models start (a game
 * engine, Blender, a converter). Each becomes a tool that always asks the
 * user before running; it needs the `shell` permission.
 */
export const PluginProgramSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  description: z.string(),
  /** The program: a name on PATH or a full path. */
  command: z.string(),
  /** Fixed arguments before the model's own. */
  args: z.array(z.string()).default([]),
  /** Whether the model may add arguments (default: yes). */
  extraArgs: z.boolean().default(true),
  /** Stop it after this many seconds; 0 = start it and do not wait (an app with a window). */
  timeoutSeconds: z.number().int().min(0).max(3600).default(120),
});

export const PluginManifestSchema = z.object({
  /** Unique id, lower-case, letters, digits and `-`. Also the plugin's settings key. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and '-'"),
  /** Display name. */
  name: z.string(),
  /** Semver version of the plugin itself. */
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  homepage: z.string().url().optional(),
  /** Entry module, relative to the plugin folder. Must default-export {@link definePlugin}'s result. Omit for a UI-only mod. */
  main: z.string().optional(),
  kesher: z.object({
    /** Plugin API major version the plugin was written for. */
    apiVersion: z.number().int(),
  }),
  permissions: z.array(PluginPermissionSchema).default([]),
  /** Interface additions (pages, panels, styles, composer buttons). Optional. */
  ui: PluginUiSchema.optional(),
  /** Programs models may start, with the user's approval. Requires the `shell` permission. */
  programs: z.array(PluginProgramSchema).default([]),
}).refine((m) => m.programs.length === 0 || m.permissions.includes("shell"), { message: "programs need the \"shell\" permission", path: ["permissions"] });

/** Parsed `kesher-plugin.json`; see {@link PluginManifestSchema}. */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Parsed `ui` section; see {@link PluginUiSchema}. */
export type PluginUi = z.infer<typeof PluginUiSchema>;
/** One program a plugin can start; see {@link PluginProgramSchema}. */
export type PluginProgram = z.infer<typeof PluginProgramSchema>;
