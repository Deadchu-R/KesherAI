// Packs the browser extension for a store, the same way the app's "Download for Chrome / Firefox" does
// (packExtension: Firefox-only keys removed for Chrome). Used by the extension-store workflow.
//   node --conditions=source --import tsx scripts/pack-extension.ts chrome out.zip
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packExtension } from "../packages/core/src/routes/browser.js";

const [target = "chrome", out = "extension.zip"] = process.argv.slice(2);
if (target !== "chrome" && target !== "firefox") throw new Error("target: chrome or firefox");
const zip = await packExtension(resolve(import.meta.dirname, "../apps/browser-extension"), target);
writeFileSync(out, zip);
console.log(`${out}: ${zip.length} bytes`);
