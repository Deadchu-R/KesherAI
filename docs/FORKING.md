# Forking Kesher

Forks are welcome — that is what the Apache-2.0 licence is for. Kesher is laid out so a fork can rebrand and trim the app without editing core code, which keeps merging upstream changes easy.

## 1. Rebrand

Everything that identifies the app is in **`packages/shared/src/branding.config.ts`**:

| Field | Affects |
| --- | --- |
| `productName` | Window title, sidebar, CLI output |
| `appId` | Data folder (`~/.<appId>`), so your fork never shares settings with Kesher |
| `accentColor` | Default accent |
| `repositoryUrl`, `docsUrl` | Links in the app |
| `defaultPort` | Core server port, so both apps can run side by side |

Then update:

- `apps/desktop/package.json` → `build.appId` and `build.productName` (installer identity).
- `apps/web/src/styles.css` → the `:root` colour tokens.
- `apps/web/index.html` → `<title>`.

If you find the product name hard-coded anywhere else, that is a bug in Kesher — please report it upstream.

## 2. Switch features off

**`packages/shared/src/features.config.ts`** has one flag per large feature: `downloads`, `images`, `remote`, `plugins`, `skills`, `openaiCompatibleApi`, `autodetectLocalServers`. A disabled feature registers no routes and shows no screen. Example — a chat-only, offline-only build:

```ts
export const features: Features = {
  downloads: false, images: false, remote: false, plugins: false,
  skills: true, openaiCompatibleApi: false, autodetectLocalServers: true,
};
```

## 3. Add instead of edit

Prefer adding behaviour through a plugin in your fork's `plugins/` folder over editing `packages/`. Plugins can add providers, categories and tools; see [PLUGINS.md](PLUGINS.md). The less you change in `packages/`, the fewer merge conflicts.

## 4. Stay in sync with upstream

```bash
git remote add upstream https://github.com/Deadchu-R/kesher.git
git fetch upstream
git merge upstream/main     # conflicts should be limited to the config files above
```

## 5. Licence obligations

Apache-2.0 lets you use, modify and redistribute Kesher, commercially or not. You must:

- keep the `LICENSE` file, and any `NOTICE` file, in your distribution;
- keep copyright notices in source files;
- state in the files you changed that you changed them;
- not use the Kesher name or logo in a way that suggests your fork is the official project (rebranding, step 1, handles this).

Read [LEGAL.md](LEGAL.md) for the licences of the dependencies and models your fork will deal with.
