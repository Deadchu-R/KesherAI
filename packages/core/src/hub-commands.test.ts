import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxCommand, type InboxCommandDeps } from "./hub-commands.js";

/** An inbox with two tasks: `agy-1` waits for Run, `agy-2` runs; `d-rec` is a Drive record queued as `agy-1`. */
function inbox() {
  const did: string[] = [];
  const d: InboxCommandDeps = {
    ids: async () => ["agy-1", "agy-2"],
    fromDrive: async (id) => (id === "d-rec" ? "agy-1" : undefined),
    run: async (id, by) => {
      if (by !== "hub:dphone") throw new Error("bad sender");
      did.push(`run ${id}`);
    },
    running: async (id) => id === "agy-2",
    stop: async (id) => (did.push(`stop ${id}`), true),
    skip: async (id) => void did.push(`skip ${id}`),
    ask: async (id) => void did.push(`ask ${id}`),
  };
  return { d, did };
}

test("Run and Cancel: by inbox id or Drive record id; Cancel stops a running task and skips a waiting one", async () => {
  const { d, did } = inbox();
  assert.deepEqual(await inboxCommand(d, "inbox-run", "agy-1", { id: "dphone" }), { ok: true, text: "Started on the PC." });
  assert.equal((await inboxCommand(d, "inbox-run", "d-rec", { id: "dphone" })).ok, true);
  assert.equal((await inboxCommand(d, "inbox-cancel", "agy-2", { id: "dphone" })).ok, true);
  assert.equal((await inboxCommand(d, "inbox-cancel", "agy-1", { id: "dphone" })).ok, true);
  assert.deepEqual(did, ["run agy-1", "run agy-1", "stop agy-2", "skip agy-1"]);
});

test("Run: an unknown task does nothing; the inbox's refusal comes back as the reason", async () => {
  const { d, did } = inbox();
  assert.deepEqual(await inboxCommand(d, "inbox-run", "nope", { id: "dphone" }), { ok: false, text: "This PC does not have that task." });
  d.run = async () => {
    throw new Error("Today's limit of 3 Antigravity tasks is reached (Settings > Task inbox).");
  };
  assert.deepEqual(await inboxCommand(d, "inbox-run", "agy-1", { id: "dphone" }), { ok: false, text: "Today's limit of 3 Antigravity tasks is reached (Settings > Task inbox)." });
  assert.deepEqual(did, []);
});

test("Ask again: the PC asks \"Run this?\" once more; nothing runs; a PC without it says so", async () => {
  const { d, did } = inbox();
  assert.deepEqual(await inboxCommand(d, "inbox-ask", "agy-1", { id: "dphone" }), { ok: true, text: "Asked again on the PC." });
  assert.deepEqual(did, ["ask agy-1"]);
  assert.equal((await inboxCommand({ ...d, ask: undefined }, "inbox-ask", "agy-1", { id: "dphone" })).ok, false);
});
