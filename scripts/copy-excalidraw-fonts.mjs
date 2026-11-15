// Copies Excalidraw's fonts into the web app's public folder (served at /excalidraw-assets/fonts/), so the Canvas
// page loads them from KesherAI itself: its CSP allows no font from outside. Xiaolai (13 MB of Chinese glyphs) is
// left out; Chinese text falls back to a system font. Runs before the web app's dev server and build.
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..", "apps", "web");
// The package exports no package.json: resolve its entry (dist/prod/index.js) and go up to dist/.
const dist = dirname(dirname(createRequire(join(web, "package.json")).resolve("@excalidraw/excalidraw")));
const from = join(dist, "prod", "fonts");
const to = join(web, "public", "excalidraw-assets", "fonts");
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true, filter: (src) => !/[\\/]Xiaolai([\\/]|$)/.test(src) });
console.log(`Excalidraw fonts copied to ${to}`);
