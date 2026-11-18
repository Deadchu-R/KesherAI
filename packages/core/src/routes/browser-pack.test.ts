import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { packExtension } from "./browser.js";

const folder = join(import.meta.dirname, "../../../../apps/browser-extension");
const manifestOf = (zip: Uint8Array) => JSON.parse(Buffer.from(unzipSync(zip)["manifest.json"]!).toString("utf8")) as Record<string, unknown>;

test("the Chrome package has only Chrome's manifest keys; Firefox's keeps its own", async () => {
  const chrome = manifestOf(await packExtension(folder, "chrome"));
  assert.equal(chrome.sidebar_action, undefined);
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.deepEqual(chrome.background, { service_worker: "background.js" });
  const firefox = manifestOf(await packExtension(folder, "firefox"));
  assert.deepEqual(firefox.background, { scripts: ["page.js", "background.js"] });
  assert.ok(firefox.browser_specific_settings);
});
