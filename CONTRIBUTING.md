# Contributing to Kesher

Thank you for helping. Kesher is meant to be built by many people, so this guide tries to answer everything you need without asking anyone. If something here is unclear, that is a bug in this file — please open an issue.

## Set up

```bash
corepack enable          # gives you the pnpm version from package.json
pnpm install
pnpm build:packages      # builds packages/* and plugins/* with tsc -b
pnpm test                # node:test, runs on the TypeScript sources
pnpm lint
pnpm dev                 # core on :7420, UI on :5173 with hot reload
```

You do not need a GPU or a model to work on most of Kesher: the `example-hello` plugin adds an `echo` provider (add it under Connections) that answers instantly.

## How the code is organised

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. In short: `packages/core` is a local HTTP server; everything else (desktop window, phone, CLI) is a client of it; models come from **providers** (`packages/providers`); plugins extend the app through `packages/plugin-sdk`.

## Documentation is part of the code

- **Every exported function, class, interface and type** in `packages/` and `plugins/` has a TSDoc comment: what it does, its parameters, what it returns, and an `@example` when usage is not obvious. `pnpm lint` fails otherwise.
- **Every package has a README** saying what it owns and what it exposes. Update it when that changes.
- **A shape that crosses a boundary** (HTTP, plugin API, config file) has a zod schema in `@kesher/shared`, and its TypeScript type comes from `z.infer`.
- **A new HTTP endpoint** is added to [docs/API.md](docs/API.md) in the same pull request.
- **A new extension point** for plugins is added to [docs/PLUGINS.md](docs/PLUGINS.md) in the same pull request.
- **Documentation is written in English**, so anyone can contribute. Translations (like `README.he.md`) are welcome in addition.

## Style

- TypeScript, strict mode, ES modules. Relative imports end in `.js` (Node's ESM rules).
- No default exports, except where a framework needs one (plugin entry points).
- Prefer the standard library (`fetch`, `node:test`, `node:crypto`) over new dependencies. A new runtime dependency needs a sentence in the PR on why.
- Errors that reach the user say what went wrong and what to do: `No provider "ollama" — add it under Connections`, not `undefined is not a function`.
- Every user-visible string in the UI goes through `t()` in `apps/web/src/i18n.ts`.

## Pull requests

1. Open an issue first for anything larger than a bug fix, so we agree on the approach before you spend time on it.
2. One change per pull request. Small is better.
3. `pnpm lint && pnpm test && pnpm typecheck` pass.
4. Describe what changed and how you tested it. Screenshots for UI changes.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Good first contributions

- A new provider preset (a server with an OpenAI-compatible API): one entry in `packages/providers/src/presets.ts`.
- AMD or Intel GPU detection in `packages/downloads/src/hardware.ts`.
- A UI translation: one object in `apps/web/src/i18n.ts`.
- A plugin: start from `pnpm create-plugin my-plugin`.
