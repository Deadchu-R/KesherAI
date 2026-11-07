# @kesher/shared

The vocabulary every other package speaks. Nothing here does I/O.

| File | What it holds |
| --- | --- |
| `categories.ts` | The model categories (chat, image, video, …) and how a plugin registers a new one |
| `models.ts` | `ModelInfo`, `ModelRef` and the helpers that build and parse model ids |
| `chat.ts` | Chat messages and the request/response schemas used by the core server |
| `media.ts` | Image, video and audio generation requests and the `Asset` type they produce |
| `branding.config.ts` | Name, colours and URLs — the one file a fork edits to rebrand |
| `features.config.ts` | Feature flags a fork can switch off without touching core code |

**Rule:** if a shape crosses a process or package boundary, its zod schema lives here, and the TypeScript type is derived from it with `z.infer`. That keeps the server's validation, the UI's types and the API docs in sync.
