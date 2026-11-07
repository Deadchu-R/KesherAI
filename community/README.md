# Community store

The app's **Community** screen lists two kinds of plugins and mods:

- **Official**: made and checked by the KesherAI project. The list is [`official.json`](official.json) in this folder (GitHub repositories as `owner/repo`). Empty for now.
- **Community**: any public GitHub repository with the topic **`kesherai-plugin`**. Anyone can publish one; KesherAI does not check them, and the app warns before installing.

Optional topics put an item in a category: `kesherai-theme`, `kesherai-mod`, `kesherai-tool`, `kesherai-model`, `kesherai-integration`, `kesherai-program`.

How to make one: [docs/PLUGINS.md](../docs/PLUGINS.md).

## Prompts, personas and skills

The Community screen's other tabs:

- **Prompts and personas**: the project's shared library, [`library.json`](library.json). To add one, open a pull request that adds it there.
- **Skills** (`SKILL.md`, the open format Claude Code uses): the official ones are listed in `library.json` and live in [`skills/`](skills); community skills are public GitHub repositories with the topic **`kesherai-skill`**. Any skill can also be installed from a GitHub link. KesherAI copies a skill's files and runs nothing; the app warns before installing an unchecked one.
