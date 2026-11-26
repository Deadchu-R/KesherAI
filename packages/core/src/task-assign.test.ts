import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboxTaskView } from "@kesher/shared";
import { assignTask, type AssignDeps } from "./task-assign.js";

function deps(tasks: Record<string, Partial<InboxTaskView>>) {
  const calls: string[] = [];
  const d: AssignDeps = {
    task: async (id) => (tasks[id] ? ({ id, title: "Fix the build", goal: "Make CI green", runBy: "antigravity", status: "waiting", ...tasks[id] } as InboxTaskView) : undefined),
    fromDrive: async (rid) => (rid === "drive-1" ? "r-1" : undefined),
    workItem: async (id) => (id === "w-abc" ? { title: "Write docs", text: "Write docs for X" } : undefined),
    stop: async (id) => (calls.push(`stop ${id}`), true),
    reassign: async (id, to, again, relay) => calls.push(`reassign ${id} ${to}${again ? " again" : ""}${relay ? " relay" : ""}`),
    add: async (i) => (calls.push(`add ${i.title} ${i.executor}`), { id: "r-9" }),
    toChat: async (role, title) => (calls.push(`chat ${role} ${title}`), `🛠️ ${title}`),
    movedOut: async (id) => calls.push(`moved ${id}`),
  };
  return { d, calls };
}

test("a waiting task goes to the new executor; the same one is a no-op", async () => {
  const { d, calls } = deps({ "r-1": {} });
  assert.equal((await assignTask(d, "r-1", "claude")).ok, true);
  assert.equal((await assignTask(d, "r-1", "antigravity")).text, "It is already with Antigravity.");
  assert.equal((await assignTask(d, "drive-1", "local")).ok, true, "a Drive record id finds its inbox task");
  assert.deepEqual(calls, ["reassign r-1 opus", "reassign r-1 local"]);
});

test("a running or finished task is never taken over without the user's yes", async () => {
  const { d, calls } = deps({ "r-1": { status: "running" }, "r-2": { status: "done" } });
  assert.deepEqual(await assignTask(d, "r-1", "local"), { ok: false, text: "It is running now.", ask: "running" });
  assert.deepEqual(await assignTask(d, "r-2", "claude"), { ok: false, text: "It has finished.", ask: "finished" });
  assert.deepEqual(calls, [], "nothing stopped or run");
  assert.equal((await assignTask(d, "r-1", "local", true)).ok, true);
  assert.equal((await assignTask(d, "r-2", "claude", true)).ok, true);
  assert.deepEqual(calls, ["stop r-1", "reassign r-1 local again", "reassign r-2 opus again"]);
});

test("a chat role opens a chat and the task leaves the inbox; a work-list item becomes a task or a chat", async () => {
  const { d, calls } = deps({ "r-1": {} });
  assert.equal((await assignTask(d, "r-1", "helper:build")).text, "Sent to a new chat: 🛠️ Fix the build.");
  assert.equal((await assignTask(d, "w-abc", "local")).text, "Added to the task inbox for Local model (self-work) (r-9).");
  assert.equal((await assignTask(d, "w-abc", "helper:research")).ok, true);
  assert.equal((await assignTask(d, "w-nope", "claude")).ok, false);
  assert.equal((await assignTask(d, "r-404", "claude")).text, "This PC does not have that task.");
  assert.deepEqual(calls, ["chat build Fix the build", "moved r-1", "add Write docs local", "chat research Write docs"]);
});

test("GhostCLI is OpenCode pinned to the relay: a pinned task is already with it, a plain OpenCode one is not", async () => {
  const { d, calls } = deps({ "r-1": { runBy: "opencode" }, "r-2": { runBy: "opencode", model: "ghostcli/*" } });
  assert.equal((await assignTask(d, "r-1", "ghostcli")).ok, true);
  assert.equal((await assignTask(d, "r-2", "ghostcli")).text, "It is already with GhostCLI (relay, trial).");
  assert.equal((await assignTask(d, "r-2", "opencode")).ok, true);
  assert.deepEqual(calls, ["reassign r-1 opencode relay", "reassign r-2 opencode"]);
});
