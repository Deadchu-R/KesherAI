import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";
import { UNITY_TOOL_NAMES, csString, projectPath, unityTools } from "./unity-tools.js";

test("chat Unity tools: names checked, flags after the fence, screenshots shown", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-tools-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const calls: string[][] = [];
  const run: CliRunner = async (args) => {
    calls.push(args);
    const out = args.indexOf("--output");
    if (out >= 0) await writeFile(args[out + 1]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, run);
  const tools = Object.fromEntries(unityTools(u, join(root, "out"), async () => "asset1").map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };

  await tools.unity_command!.run({ command: "console write", args: { message: "Hi", timeout: 5 } }, ctx);
  const c = calls.at(-1)!;
  assert.deepEqual(c.slice(0, 5), ["command", "console", "write", "--project-path", project]);
  assert.deepEqual(c.slice(c.indexOf("--")), ["--", "--message", "Hi", "--timeout", "5"]);

  const bad = await tools.unity_command!.run({ command: "x; rm -rf /" }, ctx);
  assert.match(bad.output, /not a command name/);
  const badFlag = await tools.unity_command!.run({ command: "console write", args: { "--evil": 1 } }, ctx);
  assert.match(badFlag.output, /not a parameter name/);

  const shot = await tools.unity_screenshot!.run({}, ctx);
  assert.deepEqual(shot.assetIds, ["asset1"]);
  assert.equal(shot.images?.[0]?.mimeType, "image/png");
  assert.equal(tools.unity_script_eval!.risk, "exec");
  assert.equal(tools.unity_status!.risk, "read");
});

test("Unity code tools: paths stay in the project, scripts compile after writing, C# text is escaped", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-code-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const calls: string[][] = [];
  let recompileCode = 1;
  const run: CliRunner = async (args) => {
    calls.push(args);
    if (args[0] === "recompile") return { code: recompileCode, stdout: recompileCode ? '{"errors":[{"message":"CS1002: ; expected"}]}' : '{"ok":true}', stderr: "" };
    return { code: 0, stdout: JSON.stringify("Added Door; added Rigidbody"), stderr: "" };
  };
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, run);
  const tools = Object.fromEntries(unityTools(u, join(root, "out"), async () => "a").map((t) => [t.spec.name, t]));
  const changes: Array<[string, string | null]> = [];
  const ctx = { signal: new AbortController().signal, recordChange: (p: string, b: string | null) => void changes.push([p, b]) };

  assert.throws(() => projectPath(project, "../outside.cs", ["Assets"]), /outside/);
  assert.throws(() => projectPath(project, "ProjectSettings/x.cs", ["Assets"]), /Only Assets/);
  assert.equal(projectPath(project, "Assets\\Scripts\\A.cs", ["Assets"]).rel, "Assets/Scripts/A.cs");
  await assert.rejects(tools.unity_write_script!.run({ path: "/etc/passwd", content: "x" }, ctx), /outside/);
  assert.match((await tools.unity_write_script!.run({ path: "Assets/a.dll", content: "x" }, ctx)).output, /Only code files/);

  const bad = await tools.unity_write_script!.run({ path: "Assets/Scripts/Door.cs", content: "class Door {" }, ctx);
  assert.match(bad.output, /Created Assets\/Scripts\/Door.cs/);
  assert.match(bad.output, /Compile errors/);
  assert.equal(await readFile(join(project, "Assets/Scripts/Door.cs"), "utf8"), "class Door {");
  assert.deepEqual(changes[0], [join(project, "Assets/Scripts/Door.cs"), null]);
  assert.deepEqual(calls.at(-1)!.slice(0, 3), ["recompile", "--project-path", project]);
  recompileCode = 0;
  const ok = await tools.unity_write_script!.run({ path: "Assets/Scripts/Door.cs", content: "class Door {}" }, ctx);
  assert.match(ok.output, /Updated .*Compiled with no errors/s);
  assert.equal(changes[1]![1], "class Door {");

  const made = await tools.unity_create_gameobject!.run({ name: 'Door"); System.IO.File.Delete("x', components: ["Rigidbody"] }, ctx);
  assert.match(made.output, /Added Door/);
  const code = calls.at(-1)!.at(-1)!;
  assert.ok(code.includes('go.name = "Door\\"); System.IO.File.Delete(\\"x";'));
  assert.match((await tools.unity_add_component!.run({ gameObject: "Door", components: ["Rigid body;"] }, ctx)).output, /not a component type name/);
  assert.equal(csString('a\\b"c\n'), '"a\\\\b\\"c"');
  for (const n of UNITY_TOOL_NAMES) assert.ok(tools[n], n);
});
