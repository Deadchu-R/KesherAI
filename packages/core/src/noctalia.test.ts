import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableInConfigToml, installNoctaliaPlugin, noctaliaPluginSource, noctaliaStatus } from "./noctalia.js";

const ENV = { PATH: "", KESHER_NO_NOCTALIA_MSG: "1" };

test("connect to Noctalia v4: copies the QML plugin, enables it, keeps other plugins and its own settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "noct-"));
  await assert.rejects(installNoctaliaPlugin(home, ENV), /not found/);
  mkdirSync(join(home, ".config", "noctalia", "plugins", "kesherai"), { recursive: true });
  writeFileSync(join(home, ".config", "noctalia", "plugins.json"), JSON.stringify({ timer: { enabled: true } }));
  writeFileSync(join(home, ".config", "noctalia", "plugins", "kesherai", "settings.json"), '{"url":"http://pc:7420"}');
  assert.equal(noctaliaStatus(home, ENV).version, "v4");
  await installNoctaliaPlugin(home, ENV);
  const states = JSON.parse(readFileSync(join(home, ".config", "noctalia", "plugins.json"), "utf8"));
  assert.equal(states.timer.enabled, true);
  assert.equal(states.kesherai.enabled, true);
  assert.ok(existsSync(join(home, ".config", "noctalia", "plugins", "kesherai", "BarWidget.qml")));
  assert.equal(readFileSync(join(home, ".config", "noctalia", "plugins", "kesherai", "settings.json"), "utf8"), '{"url":"http://pc:7420"}');
  assert.equal(noctaliaStatus(home, ENV).installed, true);
});

test("connect to Noctalia v5: the Luau plugin goes to ~/.local/share and is enabled in config.toml", async () => {
  const home = mkdtempSync(join(tmpdir(), "noct5-"));
  mkdirSync(join(home, ".config", "noctalia"), { recursive: true });
  const config = join(home, ".config", "noctalia", "config.toml");
  writeFileSync(config, '[bar.default]\nend = ["clock"]\n\n[plugins]\nenabled = ["noctalia/screen_recorder"]\n\n[theme]\nmode = "dark"\n');
  assert.equal(noctaliaStatus(home, ENV).version, "v5");
  assert.match(await installNoctaliaPlugin(home, ENV), /switched on/);
  assert.ok(existsSync(join(home, ".local", "share", "noctalia", "plugins", "kesherai", "plugin.toml")));
  assert.ok(existsSync(join(home, ".local", "share", "noctalia", "plugins", "kesherai", "widget.luau")));
  const after = readFileSync(config, "utf8");
  assert.match(after, /enabled = \["noctalia\/screen_recorder", "kesherai\/kesherai"\]/);
  assert.match(after, /\[theme\]\nmode = "dark"/);
  assert.ok(existsSync(`${config}.kesher-backup`));
  await installNoctaliaPlugin(home, ENV);
  assert.equal(readFileSync(config, "utf8"), after);
  assert.equal(noctaliaStatus(home, ENV).installed, true);
});

test("config.toml: adds [plugins], or a missing enabled line; leaves multi-line lists alone", () => {
  assert.equal(enableInConfigToml(""), '\n[plugins]\nenabled = ["kesherai/kesherai"]\n');
  assert.equal(enableInConfigToml("[plugins]\nauto_update = true\n"), '[plugins]\nenabled = ["kesherai/kesherai"]\nauto_update = true\n');
  assert.equal(enableInConfigToml("[plugins]\nenabled = []\n"), '[plugins]\nenabled = ["kesherai/kesherai"]\n');
  assert.equal(enableInConfigToml('[plugins]\nenabled = [\n  "a/b",\n]\n'), undefined);
  assert.ok(noctaliaPluginSource("v5"));
});
