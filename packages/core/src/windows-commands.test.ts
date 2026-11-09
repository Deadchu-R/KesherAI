import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./jobs.js";

/**
 * Windows command lines, checked on every version. Twice a release broke
 * here: `cmd /s /c` removes the first and last quote of the line, so a line
 * that starts with a quoted path loses its quotes ("The system cannot find
 * the path specified"). Every `"/s", "/c"` line in the source must start
 * with its own extra quote, or with a word (e.g. `start`).
 */
test("every cmd /s /c line keeps its quotes", async () => {
  const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const bad: string[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    const text = await readFile(join(dir, f), "utf8");
    // The argument after "/c" up to the end of the array: a template literal.
    for (const m of text.matchAll(/"\/s",\s*"\/c",\s*`([^`]*)`/g)) {
      const line = m[1] ?? "";
      if (line.startsWith('"') && !line.startsWith('""') && !/^"\$\{/.test(line)) bad.push(`${f}: ${line.slice(0, 80)}`);
      // `"${…}"` around a whole joined line is the safe form; `"${uat}" Build…` (a path, then more) is not.
      if (/^"\$\{[a-z]+\}" /i.test(line)) bad.push(`${f}: ${line.slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, [], "cmd /s /c strips the outer quotes: wrap the whole line in one more pair");
});

test("Windows: a .bat in a folder with spaces runs, with arguments with spaces", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher test "));
  const bat = join(dir, "say it.bat");
  await writeFile(bat, "@echo off\r\necho [%~1]\r\nexit /b 3\r\n");
  const out = await new Promise<{ code: number; text: string }>((res) => {
    const c = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${bat}" "two words""`], { windowsVerbatimArguments: true });
    let text = "";
    c.stdout.on("data", (d) => (text += d));
    c.on("close", (code) => res({ code: code ?? -1, text }));
  });
  assert.match(out.text, /\[two words\]/);
  assert.equal(out.code, 3);
  // The long-job runner (Unreal builds) the same way, detached, with its exit code.
  const jobs = new JobStore(join(dir, "jobs"));
  const rec = await jobs.start("t", bat, ["two words"]);
  const done = await jobs.wait(rec, { timeoutMs: 30_000 });
  assert.equal(done.state, "done");
  assert.equal(done.code, 3);
  assert.match(done.output, /\[two words\]/);
});
