import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLabels } from "./agent-labels.js";
import { AgentActivity, type ActivityBatch, type RunSnapshot } from "./agent-activity.js";
import { agentLabelCommand } from "./hub-commands.js";
import { agentBody } from "./tasks-sync.js";

test("labels are set, cleaned, cleared and kept across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-labels-"));
  try {
    const file = join(dir, "agent-labels.json");
    const a = new AgentLabels(file, () => 42);
    const changed: string[] = [];
    a.on("change", (id: string) => changed.push(id));
    assert.deepEqual(a.set("h-1", { name: " Login\n bug ", note: "check the token" }), { name: "Login bug", note: "check the token", at: 42 });
    assert.equal(a.set("../x", { name: "n" }), undefined, "not a run id");
    a.set("in-7", { name: "Docs" });
    a.set("in-7", { name: "", note: "" });
    assert.equal(a.get("in-7"), undefined, "both empty clears it");
    await a.flush();
    assert.deepEqual(changed, ["h-1", "in-7", "in-7"]);
    const b = new AgentLabels(file);
    await b.load();
    assert.deepEqual(b.get("h-1"), { name: "Login bug", note: "check the token", at: 42 });
    assert.ok(!(await readFile(file, "utf8")).includes("in-7"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hub's agent-label command labels only a run this PC has", async () => {
  const a = new AgentLabels(undefined);
  const deps = { known: async (id: string) => id === "h-1", set: (id: string, l: object) => a.set(id, l) };
  assert.deepEqual(await agentLabelCommand(deps, "h-2", { name: "x" }), { ok: false, text: "This PC does not have that agent." });
  assert.equal((await agentLabelCommand(deps, "h-1", { name: "Login" })).ok, true);
  assert.equal(a.get("h-1")?.name, "Login");
  assert.equal((await agentLabelCommand(deps, "h-1", {})).text, "Cleared on the PC.");
});

const snap = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({ runId: "h-1", source: "chat-helper", title: "Look into the login bug", state: "running", step: 1, startedAt: 1, ...over });

test("a new name goes to the viewers: a going run at the next flush, an ended one at once", () => {
  const sent: ActivityBatch[][] = [];
  const act = new AgentActivity({ send: (b) => sent.push(b), enabled: () => true, fileNames: () => false, now: () => 1000, manual: true });
  act.observe(snap());
  act.flush();
  act.observe(snap({ name: "Login", note: "mine", labelAt: 900 }));
  const [b] = act.flush();
  assert.equal(b!.events.length, 0, "no new events, only the state");
  assert.equal(b!.state.name, "Login");
  assert.equal(b!.state.note, "mine");
  assert.equal(act.flush().length, 0, "sent once");
  act.relabel(snap({ runId: "h-9", state: "done", endedAt: 500, name: "Old one", labelAt: 950 }));
  const last = sent.at(-1)![0]!;
  assert.equal(last.runId, "h-9");
  assert.equal(last.state.name, "Old one");
  assert.equal(last.state.state, "done");
});

test("the Drive snapshot carries the name and note, scrubbed of the home folder", () => {
  const body = agentBody(snap({ name: "Fix /home/someone/x", note: "see /home/someone/notes" }), undefined, "/home/someone");
  assert.ok(body.name && !body.name.includes("/home/someone"));
  assert.ok(body.note && !body.note.includes("/home/someone"));
});
