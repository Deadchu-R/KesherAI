# Image editor (official KesherAI plugin)

A layered image editor that runs inside KesherAI as an app plugin. It uses your local picture model.

- **Layers:** add, duplicate, merge down, reorder, hide, opacity, and 12 blend modes.
- **Tools:** brush and eraser (size, hardness, opacity), rectangle, ellipse and lasso selection, move, fill, color picker, pan and zoom.
- **Filters:** brightness, contrast, saturation, hue, blur, black and white, sepia, invert and sharpen. A filter changes only the selection when there is one.
- **AI:** create a new layer from a description, or repaint the selection (inpainting with a mask, with "how much to change"). Enlarge ×4 enlarges the whole picture.
- **Files:** open a picture (it becomes a layer), export a PNG, and save or open a project (`.kesherimg`, with every layer).
- **Keys:** B brush, E eraser, M rectangle, L lasso, V move, G fill, I picker, H or space pan, `[` and `]` change the size, Ctrl+Z / Ctrl+Y undo and redo, Ctrl+A select all, Ctrl+D select none, Delete clears.

How it is built: there is no build step. It is plain HTML, CSS and JavaScript (`ui/`), declared in `kesher-plugin.json` as a full-window page (`"layout": "app"`) that uses the `image` models. It talks to KesherAI only through `window.kesher` (`ui/kesher.js`): `image.generate`, `image.edit` and `image.upscale`. See docs/PLUGINS.md → "A plugin as an app".
