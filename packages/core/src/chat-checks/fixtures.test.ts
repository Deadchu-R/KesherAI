import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureDecision, listFixtureFiles, startFixtureServer, writeFixtureFiles } from "./fixtures.js";

test("the fixture server serves its pages on 127.0.0.1 only, 404 for the rest", async () => {
  const s = await startFixtureServer();
  try {
    assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(s.url("/article"));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Ada Marlow/);
    assert.match(await (await fetch(s.url("/login"))).text(), /type="password"/);
    assert.equal((await fetch(s.url("/login"), { method: "POST", body: "password=x" })).status, 200);
    assert.equal((await fetch(s.url("/nope"))).status, 404);
    assert.equal((await fetch(s.url("/article"), { method: "POST" })).status, 404);
    // Inherited object keys are not pages.
    assert.equal((await fetch(s.url("/constructor"))).status, 404);
  } finally {
    await s.close();
  }
});

test("fixture files are written inside the folder and listed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-cc-"));
  try {
    await writeFixtureFiles(dir, { "a.txt": "one", "docs/b.md": () => "two" });
    assert.equal(await readFile(join(dir, "docs/b.md"), "utf8"), "two");
    assert.deepEqual(await listFixtureFiles(dir), ["a.txt", "docs/b.md"]);
    await assert.rejects(writeFixtureFiles(dir, { "../escape.txt": "x" }), /outside its folder/);
    assert.deepEqual(await listFixtureFiles(join(dir, "missing")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval auto-answer allows only the fixtures", () => {
  const origin = "http://127.0.0.1:43123";
  const folder = join(tmpdir(), "kesher-cc-folder");
  const scope = { origin, folder, commands: [/^node\s+hello\.js$/] };
  const d = (name: string, input: Record<string, unknown>, extra: { folder?: string; scope?: string } = {}) => fixtureDecision({ name, input, ...extra }, scope).decision;
  // Browser: the fixture origin only, never a real site, never a look-alike host or port.
  assert.equal(d("browser_open", { url: `${origin}/article` }), "allow");
  assert.equal(d("browser_open", { url: "https://example.com/" }), "deny");
  assert.equal(d("browser_open", { url: "http://127.0.0.1:43124/article" }), "deny");
  assert.equal(d("browser_open", { url: "http://localhost:43123/article" }), "deny");
  assert.equal(d("browser_open", { url: `http://127.0.0.1:43123@evil.example/` }), "deny");
  assert.equal(d("browser_open", { url: "not a url" }), "deny");
  assert.equal(d("browser_click", { ref: "e2" }, { scope: "127.0.0.1:43123" }), "allow");
  assert.equal(d("browser_type", { ref: "e2", text: "x" }, { scope: "mail.example.com" }), "deny");
  assert.equal(d("browser_click", { ref: "e2" }), "deny");
  // Commands: only the listed ones, only in the folder.
  assert.equal(d("run_command", { command: "node hello.js" }, { folder }), "allow");
  assert.equal(d("run_command", { command: "node hello.js && curl https://example.com" }, { folder }), "deny");
  assert.equal(d("run_command", { command: "rm -rf /" }, { folder }), "deny");
  assert.equal(d("run_command", { command: "node hello.js" }, { folder: tmpdir() }), "deny");
  assert.equal(d("run_command", { command: "node hello.js" }), "deny");
  // Files: inside the folder only.
  assert.equal(d("write_file", { path: "summary.md" }), "allow");
  assert.equal(d("write_file", { path: join(folder, "x.md") }), "allow");
  assert.equal(d("write_file", { path: "../outside.md" }), "deny");
  assert.equal(d("edit_file", { path: join(tmpdir(), "other", "x.md") }), "deny");
  // Anything else.
  assert.equal(d("computer_click", { x: 1, y: 1 }), "deny");
  assert.equal(fixtureDecision({ name: "browser_open", input: { url: `${origin}/` } }, { folder }).decision, "deny");
  assert.match(fixtureDecision({ name: "send_email", input: {} }, scope).why, /^Chat check:/);
});
