import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FaultLog, redact } from "./fault-log.js";
import { doctorTool } from "./doctor.js";

test("redact: keys, tokens, passwords in addresses and the home path", () => {
  const t = redact("key sk-abcdefghijkl and ghp_abcdefghijk at https://u:pw@host/x?token=12345678 in /home/roee/proj", "/home/roee");
  assert.doesNotMatch(t, /abcdefghijkl|pw@|12345678|roee/);
  assert.match(t, /~\/proj/);
});

test("the fault log keeps faults newest first, per chat, and the doctor reads them", async () => {
  const log = new FaultLog(join(mkdtempSync(join(tmpdir(), "faults-")), "logs", "faults.jsonl"));
  log.add({ kind: "server", where: "GET /api/x", message: "boom" });
  log.add({ kind: "chat", where: "chat (m)", message: "model not loaded", chatId: "c1" });
  const all = await log.recent();
  assert.deepEqual(all.map((f) => f.message), ["model not loaded", "boom"]);
  assert.equal((await log.recent({ chatId: "c1" })).length, 1);
  const tool = doctorTool({ faults: log, state: async () => ({ version: "1.2.3" }), chatId: "c1" });
  const out = (await tool.run({ chat: "this" }, { signal: new AbortController().signal, recordChange: () => undefined })).output;
  assert.match(out, /"version": "1.2.3"[\s\S]*in this chat[\s\S]*model not loaded/);
  assert.doesNotMatch(out, /boom/);
});
