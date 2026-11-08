import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";

test("Unity CLI without a project: info, and a new project made through the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-"));
  const calls: string[][] = [];
  const run: CliRunner = async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "unity 2.4.0\n", stderr: "" };
    if (args[0] === "editors") return { code: 0, stdout: JSON.stringify({ success: true, data: { items: [{ version: "6000.0.47f1" }, { version: "bad version;rm" }] } }), stderr: "" };
    if (args[0] === "projects") {
      const path = join(args[4]!, args[2]!);
      await mkdir(join(path, "Assets"), { recursive: true });
      return { code: 0, stdout: JSON.stringify({ success: true, data: { path } }), stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const config = { projects: [] as string[] };
  const u = new UnityCli(config, async () => undefined, run);
  const info = await u.cliInfo();
  assert.equal(info.cli, true);
  assert.deepEqual(info.editors, ["6000.0.47f1"]);

  assert.throws(() => u.createProject({ name: "../evil", parent: root }, async () => ""), /name/);
  assert.throws(() => u.createProject({ name: "Game", parent: "relative/folder" }, async () => ""), /folder/);
  assert.throws(() => u.createProject({ name: "Game", parent: root, editor: "6000; rm -rf" }, async () => ""), /editor/);

  u.createProject({ name: "My Game", parent: root, template: "2d" }, async () => "copied");
  for (let i = 0; i < 50 && (await u.cliInfo()).job?.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  const done = await u.cliInfo();
  assert.equal(done.job?.state, "done");
  assert.deepEqual(config.projects, [join(root, "My Game")]);
  const create = calls.find((c) => c[0] === "projects")!;
  assert.ok(create.includes("--no-cloud"));
  assert.deepEqual(create.slice(0, 7), ["projects", "create", "My Game", "--path", root, "--template", "2d"]);
});
