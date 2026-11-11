/**
 * Example plugin: the smallest useful KesherAI plugin.
 *
 * It shows the two extension points most plugins use:
 * 1. a new provider type ("echo"), which users add under Connections;
 * 2. a tool ("reverse_text"), which models and Pipelines can call.
 *
 * Only `import type` is used from the SDK, so the built file has no runtime
 * dependencies and works when copied straight into `~/.kesher/plugins/`.
 * If your plugin needs npm packages at runtime, bundle it (esbuild, tsup).
 *
 * @packageDocumentation
 */
import type { KesherPlugin } from "@kesher/plugin-sdk";
/** The plugin. The core server calls `activate` once when it loads. */
declare const plugin: KesherPlugin;
export default plugin;
//# sourceMappingURL=index.d.ts.map