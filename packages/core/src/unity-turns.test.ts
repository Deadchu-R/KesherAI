import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, isReloading, type CliRunner } from "./unity-cli.js";
import { unityTools } from "./unity-tools.js";
import { compileErrors, turnTitle, unityTurns } from "./unity-turns.js";

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

test("Unity compile errors: file:line: message only, at most 10", () => {
  const json = JSON.stringify({ success: false, errors: [{ code: "COMPILE_FAILED", message: "Compilation failed" }], data: { errors: [{ file: "Assets\\Door.cs", line: 12, column: 5, code: "CS1002", message: "; expected" }, { file: "Assets/Door.cs", line: 12, code: "CS1002", message: "; expected" }], warnings: [{ file: "Assets/A.cs", line: 1, message: "unused" }] } });
  assert.deepEqual(compileErrors(json), ["Assets/Door.cs:12: CS1002: ; expected"]);
  assert.deepEqual(compileErrors("", "Assets/Scripts/Player.cs(7,3): error CS0103: The name 'speed' does not exist\n"), ["Assets/Scripts/Player.cs:7: CS0103: The name 'speed' does not exist"]);
  const many = JSON.stringify({ errors: Array.from({ length: 14 }, (_, i) => ({ file: "Assets/A.cs", line: i + 1, message: `bad ${i}` })) });
  const list = compileErrors(many);
  assert.equal(list.length, 11);
  assert.equal(list.at(-1), "… and 4 more");
});

test("Unity compile-fix loop: two automatic fixes per script per turn, then stop and tell the user", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-fix-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  let compiles = false;
  const run: CliRunner = async (args) => args[0] === "recompile"
    ? { code: compiles ? 0 : 6, stdout: compiles ? "{}" : JSON.stringify({ errors: [{ file: "Assets/Door.cs", line: 3, message: "; expected" }] }), stderr: "" }
    : { code: 0, stdout: "1", stderr: "" };
  const unity = new UnityCli({ projects: [project], active: project }, async () => undefined, run);
  const turns = unityTurns(unity);
  const write = Object.fromEntries(unityTools(unity, join(root, "out"), async () => "a", () => [], undefined, turns.handle("c3")).map((t) => [t.spec.name, t])).unity_write_script!;
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
  const go = async () => (await write.run({ path: "Assets/Door.cs", content: "class Door {" }, ctx)).output;

  turns.begin("c3", "make a door script");
  assert.match(await go(), /Compile errors:\nAssets\/Door.cs:3: ; expected\nFix them .*automatic fix 1 of 2/);
  assert.match(await go(), /automatic fix 2 of 2/);
  assert.match(await go(), /STOP changing Assets\/Door.cs.*Hebrew or English/);
  assert.match(await go(), /^Not written: .*after 2 automatic fixes/);
  // Another script has its own count; a new turn starts again.
  assert.match((await write.run({ path: "Assets/Gate.cs", content: "class Gate {" }, ctx)).output, /fix 1 of 2/);
  await turns.end("c3");
  turns.begin("c3", "try once more");
  assert.match(await go(), /fix 1 of 2/);
  // A clean compile clears the count.
  compiles = true;
  assert.match(await go(), /Compiled with no errors/);
  compiles = false;
  assert.match(await go(), /fix 1 of 2/);
});

test("Unity domain reload: a command that lands while the Editor reloads waits for it and runs once more", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-reload-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const calls: string[] = [];
  let busy = 2; // the next two commands land during a reload
  const waits: number[] = [];
  const run: CliRunner = async (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "--version") return { code: 0, stdout: "1.0", stderr: "" };
    if (args[0] === "status") return waits.length < 3 ? { code: 17, stdout: '{"success":false,"errors":[{"code":"UNAVAILABLE"}]}', stderr: "" } : { code: 0, stdout: '{"success":true}', stderr: "" };
    if (busy-- > 0) return { code: 17, stdout: '{"success":false,"errors":[{"code":"UNAVAILABLE","message":"The Editor is compiling"}]}', stderr: "" };
    return { code: 0, stdout: '"Done"', stderr: "" };
  };
  const unity = new UnityCli({ projects: [project], active: project }, async () => undefined, run);
  let seenReloading = false;
  unity.sleep = async (ms) => {
    waits.push(ms);
    seenReloading ||= unity.reloading && (await unity.status()).reloading === true;
  };
  const tools = Object.fromEntries(unityTools(unity, join(root, "out"), async () => "a").map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };

  // The first try is refused (busy), status is checked until ready, then one more try (refused again: reported).
  await assert.rejects(tools.unity_command!.run({ command: "editor.selection set" }, ctx), /compiling/);
  assert.ok(seenReloading, "the chip's status says reloading meanwhile");
  assert.equal(unity.reloading, false);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  // The next command works at once.
  assert.match((await tools.unity_script_eval!.run({ code: "return 1;" }, ctx)).output, /Done/);
  // A closed Editor is not a reload: no waiting.
  waits.length = 0;
  const closed = new UnityCli({ projects: [project], active: project }, async () => undefined, async () => ({ code: 12, stdout: "", stderr: "No running Editor" }));
  closed.sleep = async (ms) => void waits.push(ms);
  assert.equal((await closed.cliRawReady(["command", "x"], 1000)).code, 12);
  assert.deepEqual(waits, []);
  assert.equal(isReloading({ code: 102, stdout: "", stderr: "" }), true);
  assert.equal(isReloading({ code: 6, stdout: "EDITOR_NOT_READY", stderr: "" }), true);
  assert.equal(isReloading({ code: 6, stdout: "error CS1002", stderr: "" }), false);
  assert.equal(calls.filter((c) => c === "command editor.selection").length, 2);
});
