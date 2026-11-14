import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNoctaliaPlugin, noctaliaPluginSource, noctaliaStatus } from "./noctalia.js";

test("connect to Noctalia: copies the plugin, enables it, keeps other plugins and its own settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "noct-"));
  await assert.rejects(installNoctaliaPlugin(noctaliaPluginSource()!, home), /not found/);
  mkdirSync(join(home, ".config", "noctalia", "plugins", "kesherai"), { recursive: true });
  writeFileSync(join(home, ".config", "noctalia", "plugins.json"), JSON.stringify({ timer: { enabled: true } }));
  writeFileSync(join(home, ".config", "noctalia", "plugins", "kesherai", "settings.json"), '{"url":"http://pc:7420"}');
  await installNoctaliaPlugin(noctaliaPluginSource()!, home);
  const states = JSON.parse(readFileSync(join(home, ".config", "noctalia", "plugins.json"), "utf8"));
  assert.equal(states.timer.enabled, true);
  assert.equal(states.kesherai.enabled, true);
  assert.ok(existsSync(join(home, ".config", "noctalia", "plugins", "kesherai", "BarWidget.qml")));
  assert.equal(readFileSync(join(home, ".config", "noctalia", "plugins", "kesherai", "settings.json"), "utf8"), '{"url":"http://pc:7420"}');
  assert.equal(noctaliaStatus(home).installed, true);
});
