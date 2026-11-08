import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";
import { unityTools } from "./unity-tools.js";

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
