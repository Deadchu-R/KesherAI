import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";

test("continue on the computer: a phone chat becomes a chat here, a new copy when it grew", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-phone-chat-")), autodetect: false, pluginRoots: [] });
  const app = server.app;
  try {
    const messages = [{ role: "user", content: "מה ההבדל בין סוג 1 לסוג 2?" }, { role: "assistant", content: "בסוג 1 אין אינסולין." }, { role: "system", content: "dropped" }, { role: "user", content: 5 }];
    const a = (await app.inject({ method: "POST", url: "/api/import/phone-chat", payload: { id: "p1", title: "סוכרת", messages } })).json() as { id: string; added: number };
    assert.equal(a.added, 1);
    const c = (await app.inject({ method: "GET", url: `/api/conversations/${a.id}` })).json() as { title: string; importedFrom: string; events: Array<{ type: string }> };
    assert.equal(c.title, "סוכרת");
    assert.equal(c.importedFrom, "phone");
    assert.deepEqual(c.events.map((e) => e.type), ["user", "assistant"]);
    const again = (await app.inject({ method: "POST", url: "/api/import/phone-chat", payload: { id: "p1", messages } })).json() as { id: string; skipped: number };
    assert.equal(again.id, a.id);
    assert.equal(again.skipped, 1);
    const grew = (await app.inject({ method: "POST", url: "/api/import/phone-chat", payload: { id: "p1", messages: [...messages, { role: "user", content: "ועוד?" }] } })).json() as { id: string };
    assert.notEqual(grew.id, a.id);
    assert.equal((await app.inject({ method: "POST", url: "/api/import/phone-chat", payload: { messages: [] } })).statusCode, 400);
    // And back: the chat's last messages for "continue on the phone" when the computer drops.
    const h = (await app.inject({ method: "GET", url: `/api/conversations/${a.id}/handoff` })).json() as { title: string; messages: Array<{ role: string; content: string }> };
    assert.equal(h.title, "סוכרת");
    assert.deepEqual(h.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/conversations/nope/handoff" })).statusCode, 404);
  } finally {
    await server.close();
  }
});
