import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enablePlugin, GodotBridge } from "./godot-bridge.js";
import { GODOT_ADDON } from "./godot-addon.js";

test("the addon text in core matches integrations/godot", async () => {
  for (const [name, text] of Object.entries(GODOT_ADDON)) assert.equal(text, await readFile(join(import.meta.dirname, "..", "..", "..", "integrations", "godot", "addons", "kesher_bridge", name), "utf8"), name);
});

test("enablePlugin adds the addon to project.godot once, keeping other plugins", () => {
  const e = '"res://addons/kesher_bridge/plugin.cfg"';
  assert.match(enablePlugin('config_version=5\n\n[application]\n\nconfig/name="X"\n', e), /\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/kesher_bridge\/plugin.cfg"\)/);
  assert.equal(enablePlugin('[editor_plugins]\n\nenabled=PackedStringArray("res://addons/a/plugin.cfg")\n', e), `[editor_plugins]\n\nenabled=PackedStringArray("res://addons/a/plugin.cfg", ${e})\n`);
});

test("connecting a project writes the addon and turns it on; a folder without project.godot is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "godot-"));
  const b = new GodotBridge(dir);
  await assert.rejects(b.connectProject(dir));
  await writeFile(join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="X"\n');
  await b.connectProject(dir);
  await b.connectProject(dir);
  const text = await readFile(join(dir, "project.godot"), "utf8");
  assert.equal(text.split("kesher_bridge/plugin.cfg").length, 2);
  assert.match(await readFile(join(dir, "addons", "kesher_bridge", "kesher_bridge.gd"), "utf8"), /extends EditorPlugin/);
  assert.equal(b.status().connected, false);
  await assert.rejects(b.request("tree"), /not connected/);
});
