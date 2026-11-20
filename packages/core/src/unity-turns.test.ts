import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";
import { unityTools } from "./unity-tools.js";
import { turnTitle, unityTurns } from "./unity-turns.js";

/** A fake Unity CLI whose Editor keeps an Undo group counter, like Unity's. */
async function fakeUnity() {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-turns-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const log: string[] = [];
  let group = 40;
  const run: CliRunner = async (args) => {
    const code = args.at(-1) ?? "";
    if (args[0] === "command" && args[1] === "script") {
      if (code.includes("IncrementCurrentGroup")) {
        group++;
        log.push(`open ${group} ${/SetCurrentGroupName\("([^"]*)"/.exec(code)?.[1]}`);
        return { code: 0, stdout: String(group), stderr: "" };
      }
      const collapse = /CollapseUndoOperations\((\d+)\)/.exec(code);
      if (collapse) {
        log.push(`collapse ${collapse[1]}`);
        return { code: 0, stdout: '"collapsed"', stderr: "" };
      }
      group++; // every Editor change records a step of its own
      log.push("edit");
      return { code: 0, stdout: '"Done"', stderr: "" };
    }
    if (args[0] === "command") {
      group++;
      log.push(`command ${args[1]}`);
      return { code: 0, stdout: "ok", stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const unity = new UnityCli({ projects: [project], active: project }, async () => undefined, run);
  return { unity, log, root };
}

test("Unity turns: one named Undo group per chat turn, folded at its end", async () => {
  const { unity, log, root } = await fakeUnity();
  const turns = unityTurns(unity);
  assert.equal(unityTurns(unity), turns);
  const tools = Object.fromEntries(unityTools(unity, join(root, "out"), async () => "a", () => [], undefined, turns.handle("c1")).map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };

  // Outside a turn (a helper's own session): no group.
  await tools.unity_create_gameobject!.run({ name: "Door" }, ctx);
  assert.deepEqual(log, ["edit"]);

  turns.begin("c1", "Add a door to the level and make it open when the player is near");
  turns.begin("c1", "ignored: running again after an approval is the same turn");
  // Read-only tools open nothing.
  await tools.unity_scene!.run({ action: "hierarchy" }, ctx);
  await Promise.all([tools.unity_create_gameobject!.run({ name: "Door" }, ctx), tools.unity_add_component!.run({ gameObject: "Door", components: ["BoxCollider"] }, ctx)]);
  await tools.unity_command!.run({ command: "editor.selection set" }, ctx);
  await tools.unity_script_eval!.run({ code: "return 1;" }, ctx);
  assert.equal(log.filter((l) => l.startsWith("open")).length, 1, "two changes at once open one group");
  assert.match(log[2]!, /^open 43 KesherAI: Add a door to the level and make it open when…$/);
  assert.equal(await turns.end("c1"), true);
  assert.equal(log.at(-1), "collapse 43");
  assert.equal(await turns.end("c1"), false, "ending twice collapses nothing");

  // A turn with no Unity change collapses nothing; the next turn gets a new group.
  turns.begin("c1", "just talk");
  assert.equal(await turns.end("c1"), false);
  turns.begin("c1", "move it");
  await tools.unity_modify_scene!.run({ action: "rename", target: "Door", name: "Gate" }, ctx).catch(() => undefined);
  assert.ok(log.some((l) => l.startsWith("open") && l.endsWith("KesherAI: move it")));
});

test("Unity turns: the Undo name is short and the Editor not answering opens nothing", async () => {
  assert.equal(turnTitle(""), "KesherAI: chat turn");
  assert.equal(turnTitle("  fix\nthe   jump "), "KesherAI: fix the jump");
  assert.ok(turnTitle("x".repeat(200)).length <= 60);
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-turns-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const unity = new UnityCli({ projects: [project], active: project }, async () => undefined, async () => ({ code: 12, stdout: "", stderr: "no editor" }));
  const turns = unityTurns(unity);
  turns.begin("c2", "make a cube");
  await turns.handle("c2").beforeEdit();
  assert.equal(await turns.end("c2"), false);
});
