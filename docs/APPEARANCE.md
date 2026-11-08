# Appearance

Settings → Appearance changes how KesherAI looks:

- **Ready-made looks:** Graphite (default), Midnight, Paper (light), Forest, Sunset and High contrast.
- **Colours:** background, cards, fields, hover, text, secondary text and accent.
- **Font:** a choice of fonts that ship with the app and work offline.
- **Sizes:** text size and how round the corners are.
- **Spacing:** compact, normal or roomy.
- **Background:** plain or a gradient.
- **Tool groups:** their order in All tools, and which groups are shown.

The look is saved on the computer (`appearance` in config.json), so the phone shows the same look. Each browser keeps a copy so pages open without a flash.

You can also describe a look in words and the local model changes it. Ask in any chat ("make it light", "bigger text", "green accent", "put Work first"), or use the box at the top of Settings → Appearance. Either way the chat's `change_look` tool runs. Saying "undo" goes back one step, and the last ten looks are kept.

Every value is checked by `cleanAppearance` (`@kesher/shared`). Only colours as hex, the listed fonts and groups, and numbers within range get through. A model can change only the look, nothing else.

For forks: the default tokens are at the top of `apps/web/src/styles.css`. To add a ready-made look, add an entry to `APPEARANCE_PRESETS`.
