# @kesher/plugin-sdk

The only package a plugin needs to import. It defines:

- **`definePlugin`** — wraps your plugin's `activate` / `deactivate` functions with full type checking.
- **`PluginContext`** — what `activate` receives: register provider types, categories and tools, log, and read your plugin's settings and data folder.
- **`PluginManifestSchema`** — the shape of `kesher-plugin.json`.
- **`KesherTool`** — a function models can call (in chat today, in the code agent and Pipelines later).

The full guide, with a step-by-step example, is [docs/PLUGINS.md](../../docs/PLUGINS.md). A working plugin to copy is in [plugins/example-hello](../../plugins/example-hello).

`PLUGIN_API_VERSION` follows semver rules for plugins: it only changes when something a plugin relies on breaks, and the core server refuses plugins built for a different major version instead of crashing.
