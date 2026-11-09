import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newLines, parseConsole, runUnityTest } from "./unity-test.js";

const row = (message: string, level = "Log") => ({ message, level });

test("reads the Console and keeps only what Play added", () => {
  const before = parseConsole(JSON.stringify({ data: { items: [row("old 1"), row("old 2", "Warning")] } }));
  const after = parseConsole(JSON.stringify({ data: { items: [row("old 1"), row("old 2", "Warning"), row("Hello"), row("NullReferenceException", "Exception")] } }));
  assert.deepEqual(newLines(before, after).map((l) => [l.kind, l.text]), [["log", "Hello"], ["error", "NullReferenceException"]]);
  assert.deepEqual(parseConsole("not json"), []);
});

test("plays, takes a picture, and always stops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ut-"));
  const calls: string[] = [];
  let logs = [row("old")];
  const unity = {
    activeProject: "/p",
    cliRaw: async (args: string[]) => {
      calls.push(args.filter((a) => !["--project-path", "/p", "--result-only", "--"].includes(a)).join(" "));
      if (args[0] === "logs") return { code: 0, stdout: JSON.stringify({ data: { items: logs } }), stderr: "" };
      if (args.includes("start")) logs = [row("old"), row("Started")];
      if (args.includes("screenshot")) await writeFile(args[args.indexOf("--output-path") + 1]!, "png");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const run = await runUnityTest(unity, { seconds: 1, dir });
  assert.equal(run.played, true);
  assert.equal(run.picture?.toString(), "png");
  assert.deepEqual(run.log.map((l) => l.text), ["Started"]);
  assert.ok(calls.some((c) => c.startsWith("command editor set_auto_tick")));
  assert.equal(calls.filter((c) => c.includes("editor.playmode stop")).length, 1);
});

test("says why when Play Mode does not start", async () => {
  const unity = { activeProject: "/p", cliRaw: async (args: string[]) => (args.includes("start") ? { code: 1, stdout: "", stderr: "Compile errors" } : { code: 0, stdout: "[]", stderr: "" }) };
  const run = await runUnityTest(unity, { seconds: 1, dir: tmpdir() });
  assert.equal(run.played, false);
  assert.match(run.reason ?? "", /Compile errors/);
});
