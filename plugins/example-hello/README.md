# Hello example plugin

The plugin to copy when you write your own. It adds:

- an **`echo` provider type** — add it under Connections and you get a chat model, `echo/echo-1`, that repeats your message (handy for testing without downloading a model);
- a **`reverse_text` tool** — `POST /api/tools/reverse_text` with `{"text":"abc"}` returns `"cba"`.

```
kesher-plugin.json   manifest: id, version, API version, permissions
src/index.ts         the plugin
```

Start your own from it:

```bash
pnpm create-plugin my-plugin   # copies this folder to plugins/my-plugin and renames it
pnpm build:packages            # builds it with everything else
```

Read [docs/PLUGINS.md](../../docs/PLUGINS.md) for the full API.
