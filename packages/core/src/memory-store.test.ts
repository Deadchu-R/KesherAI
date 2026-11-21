import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./memory-store.js";

test("the monthly recap is opt-in, hides while paused and after this month's dismiss; merge and move save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-memory-"));
  try {
    const m = new MemoryStore(join(dir, "memory.json"));
    await m.add({ topic: "Work", text: "Makes games in Unreal", source: "you" });
    await m.add({ topic: "Job", text: "Looking for a Unity role", source: "auto" });
    assert.deepEqual(await m.recap(), []);
    await m.settings({ recap: true });
    assert.equal((await m.recap()).length, 2);
    await m.settings({ paused: true });
    assert.deepEqual(await m.recap(), []);
    await m.settings({ paused: false });
    await m.dismissRecap();
    assert.deepEqual(await m.recap(), []);
    // Next month's card shows again (a day ahead stays inside the 30 days when it is still this month's last day).
    const tomorrow = new Date(Date.now() + 86_400_000);
    assert.equal((await m.recap(tomorrow)).length, tomorrow.getMonth() === new Date().getMonth() ? 0 : 2);
    const d = await m.data();
    const [work, job] = [d.topics.find((t) => t.title === "Work")!, d.topics.find((t) => t.title === "Job")!];
    await m.moveFact(job.id, 0, { title: "Career" });
    assert.ok((await m.data()).topics.some((t) => t.title === "Career"));
    const career = (await m.data()).topics.find((t) => t.title === "Career")!;
    await m.mergeTopic(career.id, work.id);
    const again = await new MemoryStore(join(dir, "memory.json")).data();
    assert.deepEqual(again.topics.map((t) => [t.title, t.facts.length]), [["Work", 2]]);
    assert.equal(again.recap, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
