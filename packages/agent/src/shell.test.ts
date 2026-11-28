import { test } from "node:test";
import assert from "node:assert/strict";
import { runShell } from "./shell.js";

test("a program left running in the background does not hold the command", { skip: process.platform === "win32" }, async () => {
  const t0 = Date.now();
  // The background sleep keeps stdout open after the shell exits.
  const r = await runShell("echo started; sleep 20 &", process.cwd(), 30_000, new AbortController().signal);
  assert.match(r.output, /started/);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
});

test("commands the agent runs commit as KesherAI, never as the computer's git user", async () => {
  const r = await runShell('node -e "console.log(process.env.GIT_AUTHOR_EMAIL + \' \' + process.env.GIT_COMMITTER_NAME)"', process.cwd(), 30_000, new AbortController().signal);
  assert.match(r.output, /kesherai@noreply\.invalid KesherAI/);
});

test("a WSL project folder runs its commands in that Linux distribution", async () => {
  const { wslTarget } = await import("./shell.js");
  assert.deepEqual(wslTarget("\\\\wsl.localhost\\Ubuntu\\home\\me\\game"), { distro: "Ubuntu", dir: "/home/me/game" });
  assert.deepEqual(wslTarget("\\\\wsl$\\Debian"), { distro: "Debian", dir: "/" });
  assert.equal(wslTarget("C:\\Users\\me\\game"), undefined);
});

test("an SSHFS-Win path runs commands on the other computer, in its folder, never asking for a password", async () => {
  const { sshTarget, sshArgs } = await import("./shell.js");
  assert.deepEqual(sshTarget("\\\\sshfs.kr\\roee@192.168.1.20!2222\\home\\roee\\game"), { user: "roee", host: "192.168.1.20", port: 2222, dir: "/home/roee/game", fromRoot: true });
  assert.deepEqual(sshTarget("\\\\sshfs.k\\me@box\\game"), { user: "me", host: "box", port: 22, dir: "game", fromRoot: false });
  assert.equal(sshTarget("C:\\projects\\x"), undefined);
  assert.equal(sshTarget("\\\\sshfs\\me;rm@box\\x"), undefined);
  const args = sshArgs(sshTarget("\\\\sshfs.k\\me@box\\it's here")!, "npm test && echo 'ok'");
  assert.deepEqual(args.slice(0, 7), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-p", "22", "me@box"]);
  assert.equal(args[7], `cd "$HOME"/'it'\\''s here' && exec bash -lc 'npm test && echo '\\''ok'\\'''`);
});

test("detach: a command at its timeout moves on (not killed); without detach it is stopped", { skip: process.platform === "win32" }, async () => {
  let adopted: import("node:child_process").ChildProcess | undefined;
  let seen = "";
  const r = await runShell("echo hi; sleep 30", process.cwd(), 400, new AbortController().signal, undefined, {}, {
    adopt: (child, output) => {
      adopted = child;
      seen = output;
      return "moved to the background as abc";
    },
  });
  assert.equal(r.status, "moved to the background as abc");
  assert.match(seen, /hi/);
  assert.ok(adopted && adopted.exitCode === null && !adopted.killed, "still running");
  adopted!.kill("SIGKILL");
  const plain = await runShell("sleep 30", process.cwd(), 300, new AbortController().signal);
  assert.match(plain.status, /timeout/);
});

test("detach: the button hands the process over at once; Stop still kills; a refused handoff kills", { skip: process.platform === "win32" }, async () => {
  let handoff: (() => void) | undefined;
  let child: import("node:child_process").ChildProcess | undefined;
  const p = runShell("sleep 30", process.cwd(), 30_000, new AbortController().signal, undefined, {}, { adopt: (c) => ((child = c), "bg 1"), onReady: (h) => (handoff = h) });
  handoff!();
  assert.equal((await p).status, "bg 1");
  child!.kill("SIGKILL");
  const stop = new AbortController();
  const q = runShell("sleep 30", process.cwd(), 30_000, stop.signal, undefined, {}, { adopt: () => "never" });
  setTimeout(() => stop.abort(), 100);
  assert.equal((await q).code, null);
  let refused: (() => void) | undefined;
  const t = runShell("sleep 30", process.cwd(), 30_000, new AbortController().signal, undefined, {}, { adopt: () => undefined, onReady: (h) => (refused = h) });
  refused!();
  assert.match((await t).status, /timeout/);
});

test("a command's status always ends with its exit code, and says when it was killed", { skip: process.platform === "win32" }, async () => {
  const ok = await runShell("echo hi", process.cwd(), 30_000, new AbortController().signal);
  assert.equal(ok.status, "Exit code 0.");
  const bad = await runShell("exit 3", process.cwd(), 30_000, new AbortController().signal);
  assert.equal(bad.status, "Exit code 3.");
  const slow = await runShell("sleep 20", process.cwd(), 300, new AbortController().signal);
  assert.match(slow.status, /^Killed by timeout after 0\.3 s\. Exit code unknown\.$/);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const stopped = await runShell("sleep 20", process.cwd(), 30_000, ctl.signal);
  assert.match(stopped.status, /^Killed by stop\. Exit code /);
});
