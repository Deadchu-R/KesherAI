import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuestInvites, GuestQuota, GuestWatch, guestFileTools, guestName, guestOf, guestScope } from "./guests.js";

test("an invite works once, for its project and role, and only its hash is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-guests-"));
  try {
    const inv = new GuestInvites(join(dir, "guest-invites.json"));
    const { token } = await inv.create("p1", "edit", 24);
    assert.ok(!(await readFile(join(dir, "guest-invites.json"), "utf8")).includes(token), "the token itself is not stored");
    assert.equal((await inv.open(token))?.projectId, "p1");
    assert.equal((await inv.use(token, "Dani <script>"))?.usedBy, "Dani script");
    assert.equal(await inv.open(token), undefined, "used: it stops working");
    assert.equal(await inv.use(token, "Again"), undefined);
    assert.equal(await inv.open("short"), undefined);
    await assert.rejects(() => inv.create("p1", "edit", 0), /1 hour to 7 days/);
    await assert.rejects(() => inv.create("p1", "admin" as "edit", 1), /read or edit/);
    const { invite } = await inv.create("p1", "read", 1);
    assert.equal(await inv.cancel(invite.id), true);
    assert.equal((await inv.list("p1")).length, 1, "the used one stays listed, the cancelled one goes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a guest key's scope names one project and a role; anything else is not a guest", () => {
  assert.deepEqual(guestOf(guestScope("p-1", "read")), { projectId: "p-1", role: "read" });
  assert.equal(guestOf("mcp"), undefined);
  assert.equal(guestOf("project:p1:admin"), undefined);
  assert.equal(guestOf("project:../x:edit"), undefined);
  assert.equal(guestName("  Noa   K.  "), "Noa K.");
});

test("a guest's daily answers run out", () => {
  const q = new GuestQuota();
  assert.equal(q.take("g", 2), 1);
  assert.equal(q.take("g", 2), 0);
  assert.equal(q.take("g", 2), -1);
  assert.equal(q.left("g", 2), 0);
  assert.equal(q.left("other", 2), 2);
});

test("the owner hears about a guest going outside, a new address, or a flood; each at most once in 10 minutes", () => {
  const w = new GuestWatch();
  assert.deepEqual(w.see("g", "1.1.1.1", 200, 0), [], "the first address is learnt quietly");
  assert.deepEqual(w.see("g", "1.1.1.1", 403, 1000), ["outside"]);
  assert.deepEqual(w.see("g", "1.1.1.1", 403, 2000), [], "not again within 10 minutes");
  assert.deepEqual(w.see("g", "2.2.2.2", 200, 3000), ["new-address"]);
  assert.deepEqual(w.see("g", "1.1.1.1", 403, 700_000), ["outside"], "again after 10 minutes");
  const f = new GuestWatch();
  let said: string[] = [];
  for (let i = 0; i < 125; i++) said = [...said, ...f.see("h", "3.3.3.3", 200, 1_000_000 + i * 100)];
  assert.deepEqual(said, ["busy"]);
});

test("quiet hours: said only when the owner turned it on, and only at night", () => {
  const w = new GuestWatch();
  const at = (h: number) => new Date(2026, 10, 18, h, 30).getTime();
  assert.deepEqual(w.see("g", "1.1.1.1", 200, at(23), false), []);
  assert.deepEqual(w.see("g", "1.1.1.1", 200, at(14), true), []);
  assert.deepEqual(w.see("g", "1.1.1.1", 200, at(2) + 86_400_000, true), ["night"]);
});

test("a guest reads the project's files but never its secrets, and gets no tool that writes or runs", async () => {
  const fake = (name: string, out: string) => ({ spec: { name }, run: async () => out });
  const tools = guestFileTools([
    fake("list_files", "src/a.ts\n.env\nconfig/.env.local\nkeys/server.pem\n.git/config\nREADME.md"),
    fake("read_file", "1: hello"),
    fake("search", "src/a.ts:3: token\n.env:1: TOKEN=x\nsecrets.yaml:2: key"),
    fake("write_file", "x"),
    fake("run_command", "x"),
  ] as never);
  assert.deepEqual(tools.map((t) => t.spec.name), ["list_files", "read_file", "search"]);
  const run = (n: string, input: Record<string, unknown> = {}) => tools.find((t) => t.spec.name === n)!.run(input, undefined as never);
  assert.equal(await run("list_files"), "src/a.ts\nREADME.md");
  assert.equal(await run("search"), "src/a.ts:3: token");
  assert.equal(await run("read_file", { path: ".env" }), "This file is private to the project's owner.");
  assert.equal(await run("read_file", { path: "keys/id_rsa" }), "This file is private to the project's owner.");
  assert.equal(await run("read_file", { path: "src/a.ts" }), "1: hello");
});
