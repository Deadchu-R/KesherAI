// Copies the files the phone screens load from node_modules into www/vendor,
// so the APK works offline: wllama (llama.cpp in WebAssembly, for models that
// run on the phone) and the Rubik font the desktop app uses.
// Run before `cap sync` (the Android workflow does).
/* global console */
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const www = join(here, "..", "www", "vendor");
const require = createRequire(import.meta.url);

const wllama = join(dirname(require.resolve("@wllama/wllama/package.json")), "esm");
mkdirSync(join(www, "wllama"), { recursive: true });
cpSync(join(wllama, "index.js"), join(www, "wllama", "index.js"));
cpSync(join(wllama, "wasm", "wllama.wasm"), join(www, "wllama", "wllama.wasm"));

const rubik = join(dirname(require.resolve("@fontsource/rubik/package.json")), "files");
mkdirSync(join(www, "fonts"), { recursive: true });
for (const sub of ["hebrew", "latin"]) {
  for (const w of [400, 500]) cpSync(join(rubik, `rubik-${sub}-${w}-normal.woff2`), join(www, "fonts", `rubik-${sub}-${w}.woff2`));
}
// The study helpers for the phone's own study page, bundled from the shared code (esbuild comes with vite).
const webRequire = createRequire(join(here, "..", "..", "web", "package.json"));
const esbuild = createRequire(webRequire.resolve("vite"))("esbuild");
esbuild.buildSync({
  entryPoints: [join(here, "..", "study-core.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  outfile: join(www, "study-core.js"),
  nodePaths: [join(here, "..", "..", "..", "packages", "core", "node_modules")],
  logLevel: "warning",
});
// Lecture files read on the phone itself (slides, Word, PDF), from the same unpdf the computer uses.
esbuild.buildSync({
  entryPoints: [join(here, "..", "docs-core.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  outfile: join(www, "docs-core.js"),
  nodePaths: [join(here, "..", "..", "..", "packages", "agent", "node_modules")],
  logLevel: "warning",
});
// How to address her in Hebrew, from the same shared code (a classic script, loaded before the others).
esbuild.buildSync({
  entryPoints: [join(here, "..", "address-core.ts")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  outfile: join(www, "address.js"),
  logLevel: "warning",
});
// The hub-or-direct-Tailscale choice, from the same shared code (a classic script, for index.html and cloud.html).
esbuild.buildSync({
  entryPoints: [join(here, "..", "path-core.ts")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  outfile: join(www, "path.js"),
  logLevel: "warning",
});
console.log("vendor files copied to www/vendor");
