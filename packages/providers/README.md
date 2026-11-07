# @kesher/providers

Everything that talks to a model lives here. A **provider** is any source of models — a local engine, a server the user already runs, or a cloud API — wrapped in one interface (`Provider` in `src/provider.ts`).

| Adapter | `type` | Covers |
| --- | --- | --- |
| `OpenAICompatibleProvider` | `openai-compatible` | llama.cpp `llama-server`, LM Studio, Ollama, vLLM, LocalAI, OpenAI, OpenRouter, Groq — anything with `/v1/models` and `/v1/chat/completions` |
| `AnthropicProvider` | `anthropic` | Claude models through the Messages API |
| `ComfyUIProvider` | `comfyui` | Image generation through a ComfyUI server's `/prompt` API |

`presets.ts` holds ready-made configs (ports, base URLs) for the well-known servers. `registry.ts` keeps the live providers and routes a model id to the provider that serves it.

To add a new kind of provider, read [docs/PROVIDERS.md](../../docs/PROVIDERS.md). You can ship it inside this package (open a PR) or as a plugin, without touching this package at all.
