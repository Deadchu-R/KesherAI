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

## Going further

- **Motion:** none, subtle (the default) or lively. Lively gives a slowly moving background, cards that lift and page transitions. It is off whenever the system asks for reduced motion.
- **Background picture:** upload one (it is made smaller on the device), or ask in a chat for "paint a sea background and use it". A slider dims it.
- **Your own icons:** each tool can have an emoji or a picture of your own.
- **Your own CSS (advanced):** it is cleaned by `cleanCss`, which:
  - keeps only rules, `@media`, `@supports` and `@keyframes`
  - drops `@import`, `@font-face` and `@layer`
  - rejects outside addresses; pictures can only be `url("/api/assets/<id>")`
  - rejects anything that runs code and all backslash escapes
  - removes `position: fixed` and caps `z-index` at 1000
  - keeps `::before` and `::after` in place, so they never catch clicks

  The cleaned rules are added with `!important` in the cascade layer `kesher-look`.
- **Theme files:** "Save as a theme file" writes the whole look, with its pictures inside, to `.kesher-theme.json`. "Open a theme file" brings one in. A theme that has its own CSS asks first.
- **Figma:** export the Variables, for example with the "Export/Import Variables" plugin or Tokens Studio, as JSON, then import that file. Colours are matched by names such as background, surface, text and primary. Font and radius tokens are read too.
- **Colours from a picture:** pick a screenshot of a design or a poster. Its most common colour becomes the page, the most vivid one becomes the accent, and the text colour is whichever reads best on the page.

## Safety: looks only

A look is data plus cleaned CSS. It holds no JavaScript and no HTML.

- **Two checks:** the computer cleans every look, and each browser cleans its own copy again.
- **The safety guard:** the cascade layer `kesher-guard` comes before every look's CSS. Its `!important` rules keep approvals visible, opaque and in their own place, with the default colours and labels. No look can hide, fade, move, cover or relabel the Approve and Deny buttons.
- **The interface's Content-Security-Policy** (`WEB_CSP` in server.ts) allows scripts, fonts, pictures and connections only from KesherAI itself, plus Google profile pictures. Even if something got past the cleaning, it could not load anything from outside or send anything away. The same rule stops a chat's Markdown from loading outside pictures.
