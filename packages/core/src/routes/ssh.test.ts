import { test } from "node:test";
import assert from "node:assert/strict";
import { sshLogin, sshfsPath } from "./ssh.js";
import { sshTarget } from "@kesher/agent";

test("SSH: logins checked, and the SSHFS-Win path round-trips to where commands run", () => {
  assert.deepEqual(sshLogin("roee@192.168.1.20", 2222), { login: "roee@192.168.1.20", port: 2222 });
  assert.equal(sshLogin("roee@box;rm -rf /"), undefined);
  assert.equal(sshLogin("box"), undefined);
  assert.equal(sshLogin("a@b", 70000), undefined);
  const abs = sshfsPath("roee@box", 2222, "/home/roee/game");
  assert.equal(abs, "\\\\sshfs.kr\\roee@box!2222\\home\\roee\\game");
  assert.deepEqual(sshTarget(abs), { user: "roee", host: "box", port: 2222, dir: "/home/roee/game", fromRoot: true });
  const home = sshfsPath("me@box", 22, "~/game");
  assert.equal(home, "\\\\sshfs.k\\me@box\\game");
  assert.deepEqual(sshTarget(home), { user: "me", host: "box", port: 22, dir: "game", fromRoot: false });
});
