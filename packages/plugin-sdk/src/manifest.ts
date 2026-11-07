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
  /** Entry module, relative to the plugin folder. Must default-export {@link definePlugin}'s result. */
  main: z.string().default("dist/index.js"),
  kesher: z.object({
    /** Plugin API major version the plugin was written for. */
    apiVersion: z.number().int(),
  }),
  permissions: z.array(PluginPermissionSchema).default([]),
});

/** Parsed `kesher-plugin.json`; see {@link PluginManifestSchema}. */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
