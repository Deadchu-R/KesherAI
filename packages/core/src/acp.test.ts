import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpAgent, mapUpdate, type AcpUpdate } from "./acp.js";
import { fakeAgent } from "./acp-fake.test.js";

test("ACP: KesherAI connects, signs in with the agent's own method, prompts, and answers its permission question", async () => {
  const seen: { auth?: string; cancelled?: boolean; caps?: unknown } = {};
  const updates: AcpUpdate[] = [];
  const asked: string[] = [];
  const a = await AcpAgent.connect(fakeAgent(seen), {
    update: (u) => updates.push(u),
    permission: async (p) => {
      asked.push(`${p.title}:${p.options.map((o) => o.kind).join(",")}`);
      return "yes";
    },
  });
  try {
    assert.equal(a.info?.name, "fake-agy");
    assert.deepEqual(a.info?.authMethods, [{ id: "oauth-personal", name: "Log in with Google" }]);
    const caps = seen.caps as { fs?: unknown; terminal?: unknown };
    assert.deepEqual([caps.fs, caps.terminal], [{ readTextFile: false, writeTextFile: false }, false], "the agent keeps its own files and terminal");
    await a.authenticate("oauth-personal");
    assert.equal(seen.auth, "oauth-personal");
    await a.newSession("/p");
    assert.equal(await a.prompt("change a to b"), "end_turn");
    assert.deepEqual(asked, ["Edit a.ts:allow_once,reject_once"]);
    assert.deepEqual(updates.map((u) => u.kind), ["thought", "tool", "tool", "text"]);
    const done = updates[2] as Extract<AcpUpdate, { kind: "tool" }>;
    assert.equal(done.status, "completed");
    assert.deepEqual(done.diffs, [{ path: "/p/a.ts", oldText: "a", newText: "b" }]);
    await a.cancel();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.cancelled, true);
  } finally {
    a.close();
  }
});

test("ACP: an unknown or missing answer to a permission question is a cancel, never an allow", async () => {
  const updates: AcpUpdate[] = [];
  const a = await AcpAgent.connect(fakeAgent({}), { update: (u) => updates.push(u), permission: async () => "allow-everything" });
  try {
    await a.newSession("/p");
    await a.prompt("x");
    assert.equal((updates.find((u) => u.kind === "text") as { text: string }).text, "Skipped.");
  } finally {
    a.close();
  }
});

test("ACP: updates the chat does not show are dropped", () => {
  assert.equal(mapUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] }), undefined);
  assert.deepEqual(mapUpdate({ sessionUpdate: "plan", entries: [{ content: "Read", priority: "high", status: "pending" }] }), { kind: "plan", entries: [{ content: "Read", status: "pending" }] });
});
