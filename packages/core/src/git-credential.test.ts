import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GcmGitHub, githubTokenEnv, gitRunner, isGcmHelper, parseCredential, TOKEN_ENV, type GitRun } from "./git-credential.js";

/** A git that reads no user or system settings (only what the test gives it). */
async function cleanEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "kesher-gcred-"));
  const global = join(home, "gitconfig");
  await writeFile(global, "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(KEY_|VALUE_|COUNT$)/.test(k) || k === TOKEN_ENV) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: global, ...extra };
}

test("parseCredential: user name and password, none without a password", () => {
  assert.deepEqual(parseCredential("protocol=https\nhost=github.com\nusername=octo\npassword=gho_a=b\n"), { username: "octo", password: "gho_a=b" });
  assert.deepEqual(parseCredential("password=x\r\n"), { password: "x" });
  assert.equal(parseCredential("protocol=https\nhost=github.com\n"), undefined);
});

test("isGcmHelper: Git for Windows' names and paths, not others", () => {
  assert.ok(isGcmHelper("manager"));
  assert.ok(isGcmHelper("manager-core"));
  assert.ok(isGcmHelper('"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"'));
  assert.ok(isGcmHelper("store\n/usr/local/bin/git-credential-manager"));
  assert.ok(!isGcmHelper("store"));
  assert.ok(!isGcmHelper("osxkeychain\ncache --timeout=900"));
  assert.ok(!isGcmHelper(""));
});

test("githubTokenEnv: git's own credential fill answers with the token, and other hosts are untouched", async () => {
  const env = await cleanEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test" });
  const add = githubTokenEnv("gho_secret", env);
  assert.equal(add.GIT_CONFIG_COUNT, "3", "entries already there are kept");
  assert.ok(!Object.entries(add).some(([k, v]) => k !== TOKEN_ENV && v.includes("gho_secret")), "the token is only in its own variable");
  const run = gitRunner(env);
  const gh = await run(["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", env: { ...add, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 20_000 });
  assert.equal(gh.code, 0, gh.out);
  assert.deepEqual(parseCredential(gh.out), { username: "x-access-token", password: "gho_secret" });
  const other = await run(["credential", "fill"], { input: "protocol=https\nhost=example.com\n\n", env: { ...add, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 20_000 });
  assert.notEqual(other.code, 0, "no credential for another host");
});

test("GcmGitHub with a fake helper: fill, approve/reject, and whether GCM is set up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-gcred-"));
  const log = join(dir, "calls.txt").replace(/\\/g, "/");
  const helper = `!f() { echo "$1" >> '${log}'; test "$1" = get && echo username=octo && echo password=gho_fromgcm; }; f`;
  const run = gitRunner(await cleanEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: helper }));
  const gcm = new GcmGitHub(run);
  assert.equal(await gcm.available(), false, "a plain helper is not GCM");
  const c = await gcm.fill(false);
  assert.deepEqual(c, { username: "octo", password: "gho_fromgcm" });
  await gcm.report(c!, true);
  await gcm.report(c!, false);
  assert.deepEqual((await readFile(log, "utf8")).trim().split(/\s+/), ["get", "store", "erase"]);

  // No helper at all: nothing, and no prompt.
  assert.equal(await new GcmGitHub(gitRunner(await cleanEnv())).fill(false), undefined);
});

test("GcmGitHub.available: reads both the general and the github.com helper", async () => {
  const seen: string[][] = [];
  const run: GitRun = async (args) => {
    seen.push(args);
    return args.includes("credential.https://github.com.helper") ? { code: 0, out: "manager\n" } : { code: 1, out: "" };
  };
  assert.equal(await new GcmGitHub(run).available(), true);
  assert.equal(seen.length, 2);
});
