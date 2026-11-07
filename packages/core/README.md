# @kesher/core

The local server at the centre of KesherAI. The desktop window, the phone, the CLI and any OpenAI-compatible tool are all clients of this one process — the same split OpenCode uses.

```
src/
  server.ts      createKesherServer(): builds services and registers routes, in start-up order
  main.ts        CLI entry (kesher-core --port 7420 --web ../web/dist)
  config.ts      config.json schema, data folder layout
  services.ts    the object every route receives
  auth.ts        remote-access token check
  assets.ts      AssetStore: every generated file, by id
  plugins.ts     PluginHost: finds, validates and activates plugins
  llamacpp.ts    starts/stops llama-server for downloaded GGUF files
  sse.ts         Server-Sent Events helper
  routes/
    system.ts    health, categories, hardware, skills, plugins, tools, remote pairing
    models.ts    models, providers (connections), local files, llama.cpp engine
    generate.ts  /api/chat (streamed), /api/images, /api/assets
    downloads.ts Hugging Face search and the download queue
    openai.ts    /v1/models and /v1/chat/completions for other tools
```

Every endpoint is listed in [docs/API.md](../../docs/API.md).

Run it on its own:

```bash
pnpm --filter @kesher/core dev                     # from source, restarts on change
node packages/core/dist/main.js --web apps/web/dist # built, serving the UI
```
