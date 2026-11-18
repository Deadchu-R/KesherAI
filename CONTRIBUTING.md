# Contributing to KesherAI

Thank you for helping. KesherAI is meant to be built by many people, so this guide tries to answer everything you need without asking anyone. If something here is unclear, that is a bug in this file — please open an issue.

## Set up

```bash
corepack enable          # gives you the pnpm version from package.json
pnpm install
pnpm build:packages      # builds packages/* and plugins/* with tsc -b
pnpm test                # node:test, runs on the TypeScript sources
pnpm lint
pnpm dev                 # core on :7420, UI on :5173 with hot reload
```

**Space:** the install and builds take about 6 GB (node_modules, the interface build, Electron when you package the app). With Docker or Codespaces, `.devcontainer/` sets everything up ("Reopen in Container").

**A separate development profile:** your own KesherAI's chats, models settings and keys stay apart when the core you run has its own data folder, for example `node packages/core/dist/main.js --port 7421 --data-dir ~/kesher-dev` (any empty folder). Delete the folder to start fresh.

You do not need a GPU or a model to work on most of KesherAI: the `example-hello` plugin adds an `echo` provider (add it under Connections) that answers instantly.

## Your first change in 10 minutes

A real round trip, so you see every step once (like the walk-throughs Obsidian and VS Code give):

1. **Find the string.** Open the app (`pnpm dev`, then http://localhost:5173), pick a button you want to change, and search its text: `git grep -n "New document"`. You land in `apps/web/src/pages/DocsPage.tsx`.
2. **Change it.** Edit the English and the Hebrew (`L("מסמך חדש", "New document")`). The page reloads by itself.
3. **Check it at phone width.** In the browser's dev tools pick a 390 px wide device; nothing may scroll sideways.
4. **Run the checks.** `pnpm typecheck && pnpm lint && pnpm test`. For a server change, add a `node:test` file next to the code (`*.test.ts`); `packages/core/src/routes/app-link.test.ts` is a short example that starts the routes with `app.inject`, no port.
5. **Open the pull request.** One change, a sentence on what and why, and a screenshot for UI. The template asks the rest.

Building a plugin instead? `pnpm create-plugin my-plugin --dir C:\dev\my-plugin`, then in the installed app **Connections → Plugins → 🛠 Load a folder (development)**: it reloads on every save. Before publishing: `pnpm plugin:check C:\dev\my-plugin`.

## How the code is organised

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. In short: `packages/core` is a local HTTP server; everything else (desktop window, phone, CLI) is a client of it; models come from **providers** (`packages/providers`); plugins extend the app through `packages/plugin-sdk`.

## Documentation is part of the code

- **Every exported function, class, interface and type** in `packages/` and `plugins/` has a TSDoc comment: what it does, its parameters, what it returns, and an `@example` when usage is not obvious. `pnpm lint` fails otherwise.
- **Every exported function and class** in the interface (`apps/web`) and the desktop shell (`apps/desktop`) has one too: at least a line saying what it is. `pnpm lint` checks this as well.
- **The API reference** is built from these comments (`pnpm docs:api`) and published after every release at roeetal.com/KesherAI/api/.
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

Issues ready for a first change carry the [`good first issue`](https://github.com/Deadchu-R/KesherAI/labels/good%20first%20issue) label, and ones where a hand is especially welcome carry [`help wanted`](https://github.com/Deadchu-R/KesherAI/labels/help%20wanted). Some ideas to start with:

- A new provider preset (a server with an OpenAI-compatible API): one entry in `packages/providers/src/presets.ts`.
- AMD or Intel GPU detection in `packages/downloads/src/hardware.ts`.
- A UI translation: one object in `apps/web/src/i18n.ts`.
- A plugin: start from `pnpm create-plugin my-plugin`.
