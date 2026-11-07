# Notes (example mod)

A KesherAI mod with no code to build: everything is in `kesher-plugin.json` and the `ui/` folder.

- **Page** `ui/notes.html`: appears in the sidebar as "Notes"; saves through `storage.set` and tidies the text with the user's chat model (`chat`).
- **Panel** `ui/summary.html`: a "Summary" button in every conversation's top bar; reads the conversation (`conversation`) and summarizes it.
- **Composer button** "Make it shorter": puts a ready prompt in the message box.

`ui/kesher.js` is the small client every page can copy. See [docs/PLUGINS.md](../../docs/PLUGINS.md) → Interface.
