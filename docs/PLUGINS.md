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

### 4. Interface: pages, panels, themes, composer buttons (mods)

A plugin can change the interface with **no code to build**: declare it in the manifest's `ui` section and ship plain HTML/CSS. A plugin that has only `ui` (and no `main`) is a *mod*. [`plugins/example-notes`](../plugins/example-notes) is a complete one to copy.

```json
"ui": {
  "pages":   [{ "id": "notes", "title": "Notes", "icon": "✎", "file": "ui/notes.html" }],
  "panels":  [{ "id": "summary", "title": "Summary", "file": "ui/summary.html" }],
  "styles":  ["ui/theme.css"],
  "composerActions": [{ "id": "shorter", "label": "Make it shorter", "prompt": "Rewrite your last answer in half the length." }]
}
```

- **pages** appear in the sidebar and open full size at `#/p/<plugin>/<page>`.
- **panels** get a button in every conversation's top bar and open above the chat.
- **styles** are added to the whole app. Override its CSS variables (`--bg`, `--panel`, `--accent`, `--text`, `--radius`, …) to make a theme, or restyle any part.
- **composerActions** are buttons that put a ready prompt into the message box.

Pages and panels run in a **sandboxed frame**: their scripts run, but they cannot read the app, its token or its storage, and they cannot fetch on their own. They ask the app through `postMessage`. Copy [`ui/kesher.js`](../plugins/example-notes/ui/kesher.js) (25 lines) and call:

| Method | Params | Returns |
|---|---|---|
| `info` | – | `{ pluginId, locale, conversationId }` |
| `models` | – | the connected models `[{ id, name, category, location }]` |
| `chat` | `{ messages, model?, temperature? }` | the answer text (default: the user's chat model) |
| `runTool` | `{ name, input }` | the result of any registered tool |
| `storage.get` / `storage.set` | `{ key }` / `{ key, value }` | your plugin's saved JSON (1 MB per key) |
| `newChat` | `{ prompt? }` | opens a new conversation and sends the prompt |
| `conversation` | – | panels only: `{ title, messages }` of the open conversation |
| `insertPrompt` | `{ text }` | panels only: puts text in the message box |
| `toast` | `{ text }` | shows a short message |
| `image.generate` | `{ prompt, width?, height?, steps?, seed?, model? }` | `uses: image` · the pictures, as `data:` URLs (default: the user's picture model) |
| `image.edit` | `{ prompt, image, mask?, strength? }` | `uses: image` · edits a picture (`data:` URLs); with a mask, only the white part changes |
| `image.upscale` | `{ image }` | `uses: image` · the picture four times larger |
| `speech.transcribe` | `{ audio, language? }` | `uses: speech` · the text of a WAV recording (`data:` URL) |
| `speech.speak` | `{ text, voice? }` | `uses: speech` · the text read aloud, as a WAV `data:` URL |

```js
const answer = await kesher.call("chat", { messages: [{ role: "user", content: "Hi" }] });
// Streaming: pieces arrive as they are written, then the whole answer.
await kesher.call("chat", { messages, stream: true }, (piece) => (out.textContent += piece));
```

### 4a. A plugin as an app

A plugin can be a whole app inside KesherAI, such as an image editor or a music sketchpad. It is a page that fills the window and uses the local models through the methods above. It does not need its own models or its own server:

```json
"uses": ["image", "chat"],
"ui": { "pages": [{ "id": "editor", "title": "Image editor", "icon": "🖌", "file": "ui/editor.html", "layout": "app" }] }
```

- `"layout": "app"` shows the page edge to edge, with no margins.
- `"uses"` lists the local models the app needs: `chat`, `image`, `speech`. The user sees them on the Plugins page before turning the plugin on. A call to a model kind the plugin did not declare is refused (`chat` is always allowed).
- The page stays in a sandbox, so it cannot read the app, its token or the user's files. It gets pictures and sound as `data:` URLs and saves its work with `storage.set`. It can also let the user download a file (`<a download>`) or pick one (`<input type="file">`).
- An app is installed like any plugin: from the catalog on the Plugins page, or from a Git address.

### 5. Programs the models can start

Declare programs (a game engine, Blender, a converter, your own script) and each becomes a tool the models can call. It **always asks the user first**, runs without a shell, and needs the `shell` permission:

```json
"permissions": ["shell"],
"programs": [{
  "id": "render", "name": "Blender", "description": "Render a .blend file to PNG frames.",
  "command": "blender", "args": ["--background"], "extraArgs": true, "timeoutSeconds": 600
}]
```

`timeoutSeconds: 0` starts an app with a window and does not wait for it. The tool is named `<plugin_id>_<program_id>` (dashes become `_`) and takes `{ args?: string[], cwd?: string }`.

### Planned extension points

These are on the roadmap; the API will be added without breaking existing plugins:

- `registerPipelineNode` — a node for the Pipelines editor.
- `registerMcpServer` / `registerSkill` — package MCP servers and skills with a plugin.

## Lifecycle

1. On start-up, the core scans `~/.kesher/plugins/*` and the folders passed with `--plugins`.
2. For each folder with a `kesher-plugin.json`, it validates the manifest and checks `apiVersion`.
3. If the plugin is enabled (`config.json` → `plugins.<id>.enabled`, default `true`), it imports `main` and calls `activate`.
4. A plugin that throws is marked `error` with its message, visible in **Plugins & mods**. Other plugins keep loading.
5. Turning a plugin on or off, installing or removing one reloads all plugins at once; no restart.
6. On quit, `deactivate` is called.

## Settings

Users configure a plugin in `config.json`:

```json
{ "plugins": { "my-plugin": { "enabled": true, "settings": { "apiKey": "…" } } } }
```

Read them from `ctx.settings`. Document every setting in your plugin's README.

## Security

A plugin's code runs **in its own process** (since 0.6.183), not inside KesherAI's server: a plugin that crashes or
hangs takes only itself down. What it can use comes from its `permissions`:

| Permission | Without it |
|---|---|
| `network` | `fetch`, WebSocket and Node's network modules (`net`, `http`, `https`, `tls`, `dgram`, `dns`…) throw. |
| `shell` | `child_process`, workers and `cluster` throw (and, with the file sandbox, Node refuses them too). |
| `filesystem` | With the file sandbox: it reads only its own folder and data folder, writes only its data folder. |

The file sandbox is Node's permission model (`--experimental-permission`); KesherAI turns it on when the computer's
Node supports it, and the Plugins page says per plugin whether it is on. Native code (addons) is refused with it.
Calls cross the processes as messages (tools, model providers with their streamed text, cancellation), so
`registerTool`, `registerCategory` and `registerProviderFactory` work as before.

This is not a full sandbox: a plugin with `network` can still send what it can read, and one with `filesystem` can read
your files. Only install plugins you trust, and as an author, ask only for what your plugin needs.

## Publishing

- Put it on GitHub with `kesher-plugin.json` at the root (and a built `dist/` if it has code).
- **Add the topic `kesherai-plugin` to the repository.** It then appears in the app under **Community → From the community** (with a warning that community items are not checked). Add `kesherai-theme`, `kesherai-mod`, `kesherai-tool`, `kesherai-model`, `kesherai-integration` or `kesherai-program` to put it in a category.
- **Official** items are made and checked by the KesherAI project and listed in [`community/official.json`](../community/official.json).
- Users can also install any repository by its address (`owner/repo` or an `https://` Git URL) on that screen, or copy the folder into `~/.kesher/plugins/`.
- Choose an open-source licence for your plugin. KesherAI's Apache-2.0 licence does not require any particular licence for plugins.

## Testing

Use `node:test` like the rest of the repo. `packages/core/src/server.test.ts` shows how to start a real core server with your plugin folder and call its routes with `app.inject`, without opening a port.
