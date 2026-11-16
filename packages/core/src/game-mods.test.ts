import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bedrockFiles, modId, modKindOf, modTools, renameGradle, robloxFiles } from "./game-mods.js";

test("mod ids are what Fabric and NeoForge accept", () => {
  assert.equal(modId("My Cool Mod!"), "my_cool_mod");
  assert.equal(modId("3D Stuff"), "m3d_stuff");
  assert.equal(modId("!!!"), "my_mod");
});

test("a Bedrock add-on's two packs need each other; Roblox gets a Rojo project", () => {
  const b = bedrockFiles("Gems");
  const bp = JSON.parse(b["behavior_pack/manifest.json"]!);
  const rp = JSON.parse(b["resource_pack/manifest.json"]!);
  assert.equal(bp.dependencies[0].uuid, rp.header.uuid);
  assert.equal(rp.dependencies[0].uuid, bp.header.uuid);
  assert.notEqual(bp.header.uuid, bp.modules[0].uuid);
  assert.equal(JSON.parse(robloxFiles("Obby")["default.project.json"]!).tree.ServerScriptService.Server.$path, "src/server");
});

test("gradle.properties gets the new id (NeoForge and Fabric keys)", () => {
  const p = renameGradle("mod_id=examplemod\nmod_name=Example Mod\nmod_group_id=com.example.examplemod\ngroup=com.example\nother=1\n", "gems", "Gems");
  assert.equal(p, "mod_id=gems\nmod_name=Gems\nmod_group_id=com.example.gems\ngroup=com.example.gems\nother=1\n");
});

test("mod_new makes a Bedrock and a Roblox project that are recognised for building", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mods-"));
  const [create] = modTools(dir);
  await create!.run({ kind: "bedrock", name: "Gems", folder: dir }, {} as never);
  await create!.run({ kind: "roblox", name: "Obby", folder: dir }, {} as never);
  assert.equal(modKindOf(join(dir, "gems")), "bedrock");
  assert.equal(modKindOf(join(dir, "obby")), "roblox");
  await assert.rejects(create!.run({ kind: "roblox", name: "Obby", folder: dir }, {} as never), /already exists/);
});
