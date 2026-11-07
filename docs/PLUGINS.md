# Writing a plugin

A plugin adds things to KesherAI without changing KesherAI's code: new kinds of model sources, new model categories, and tools that models can call. A working example lives in [`plugins/example-hello`](../plugins/example-hello).

## Five-minute version

```bash
pnpm create-plugin my-plugin      # copies the example to plugins/my-plugin
# edit plugins/my-plugin/src/index.ts
pnpm build:packages
pnpm dev                          # the core loads everything in plugins/
```

Open **Connections → Plugins** and your plugin is listed as `active`.

## Anatomy

```
my-plugin/
  kesher-plugin.json   the manifest (required)
  package.json
  tsconfig.json
  src/index.ts         entry point
  dist/index.js        built entry point (what KesherAI loads)
```

### The manifest: `kesher-plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "0.1.0",
  "description": "What it does, in one sentence.",
  "main": "dist/index.js",
  "kesher": { "apiVersion": 1 },
  "permissions": ["network"]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique, lower-case letters, digits and `-`. Also the key of the plugin's settings. |
| `main` | Entry module relative to the folder. Defaults to `dist/index.js`. |
| `kesher.apiVersion` | The plugin API major version you built against. KesherAI refuses plugins for another major version instead of crashing. Current: `1`. |
| `permissions` | `network`, `filesystem`, `shell`. Shown to the user before enabling. See [Security](#security). |

The full schema is `PluginManifestSchema` in `packages/plugin-sdk/src/manifest.ts`.

### The entry module

It default-exports an object with `activate` (required) and `deactivate` (optional):

```ts
import type { KesherPlugin } from "@kesher/plugin-sdk";

const plugin: KesherPlugin = {
  activate(ctx) {
    ctx.log.info("hello");
  },
};

export default plugin;
```

Using `import type` keeps the built file free of runtime dependencies, so it works when copied into `~/.kesher/plugins/`. If you need npm packages at runtime, bundle the plugin (esbuild or tsup) into one file.

## What `activate` receives: `PluginContext`

| Member | Use |
| --- | --- |
| `pluginId` | Your manifest id. |
| `dataDir` | A folder only your plugin writes to (`~/.kesher/plugin-data/<id>`). |
| `settings` | The user's settings for your plugin, from `config.json` → `plugins.<id>.settings`. |
| `log.info / warn / error` | Logging, prefixed with your id. |
| `registerProviderFactory(factory)` | Adds a new provider type to "Add connection". |
| `registerCategory(category)` | Adds a model category. |
| `registerTool(tool)` | Adds a tool models can call. |

Everything you register is removed automatically when the plugin is disabled.

## Extension points

### 1. A provider type

Lets users connect a new kind of model source. Implement the `Provider` interface (see [PROVIDERS.md](PROVIDERS.md)) and register a factory:

```ts
ctx.registerProviderFactory({
  type: "replicate",
  displayName: "Replicate",
  categories: ["image", "video"],
  create: (config) => new ReplicateProvider(config),
});
```

Users then add a connection with `"type": "replicate"` and their own id, URL and key — exactly like a built-in type.

### 2. A category

```ts
ctx.registerCategory({
  id: "upscale",
  label: { en: "Upscaling", he: "הגדלת תמונה" },
  toolName: "upscale_image",
  huggingFacePipelineTags: ["image-to-image"],
});
```

`label.en` is required; add any other locales. `huggingFacePipelineTags` lets the downloader file models into your category automatically.

### 3. A tool

```ts
ctx.registerTool({
  name: "word_count",
  description: "Counts the words in a text. Use when the user asks how long something is.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async run(input, signal) {
    return String(input.text).trim().split(/\s+/).length;
  },
});
```

Tools are listed at `GET /api/tools` and run with `POST /api/tools/<name>`. The code agent, chat tool-calling and Pipelines all use the same registry. Write the `description` for a model, not a human: say what the tool does and when to use it. Honour `signal` in long operations.

### Planned extension points

These are on the roadmap; the API will be added to `PluginContext` without breaking existing plugins:

- `registerPipelineNode` — a node for the Pipelines editor.
- `registerScreen` — a UI screen, loaded from a URL the plugin serves.
- `registerMcpServer` / `registerSkill` — package MCP servers and skills with a plugin.

## Lifecycle

1. On start-up, the core scans `~/.kesher/plugins/*` and the folders passed with `--plugins`.
2. For each folder with a `kesher-plugin.json`, it validates the manifest and checks `apiVersion`.
3. If the plugin is enabled (`config.json` → `plugins.<id>.enabled`, default `true`), it imports `main` and calls `activate`.
4. A plugin that throws is marked `error` with its message, visible in **Connections → Plugins**. Other plugins keep loading.
5. On quit, `deactivate` is called.

## Settings

Users configure a plugin in `config.json`:

```json
{ "plugins": { "my-plugin": { "enabled": true, "settings": { "apiKey": "…" } } } }
```

Read them from `ctx.settings`. Document every setting in your plugin's README.

## Security

Today plugins run **inside the core server's process**, with the same access as KesherAI itself. The `permissions` field is displayed but not yet enforced. Running each plugin in its own process, limited to the permissions it declared, is on the roadmap. Until then, only install plugins you trust, and as an author, declare honestly what your plugin needs — it will be enforced later.

## Publishing

- Put it on GitHub with `kesher-plugin.json` at the root and a built `dist/`, or publish to npm as `kesher-plugin-<id>`.
- Users install it by copying the folder into `~/.kesher/plugins/`. An in-app plugin browser is planned.
- Choose an open-source licence for your plugin. KesherAI's Apache-2.0 licence does not require any particular licence for plugins.

## Testing

Use `node:test` like the rest of the repo. `packages/core/src/server.test.ts` shows how to start a real core server with your plugin folder and call its routes with `app.inject`, without opening a port.
