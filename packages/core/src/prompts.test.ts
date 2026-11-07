import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prompts, commandName, fillPrompt } from "./prompts.js";

test("command names and filling", () => {
  assert.equal(commandName("/Fix Bug!"), "fix-bug");
  assert.equal(commandName("סכם קצר"), "סכם-קצר");
  assert.equal(fillPrompt("Translate:\n\n{{input}}", " hello "), "Translate:\n\nhello");
  assert.equal(fillPrompt("Be brief.", "what is BM25"), "Be brief.\n\nwhat is BM25");
});

test("prompts are saved, unique by command, and kept", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "kesher-prompts-")), "prompts.json");
  const p = new Prompts(file);
  const a = await p.save({ command: "Summarize", text: "Sum up: {{input}}" });
  assert.equal(a.command, "summarize");
  await assert.rejects(p.save({ command: "summarize", text: "other" }), /already exists/);
  await p.save({ id: a.id, command: "summarize", text: "Short summary: {{input}}" });
  assert.equal((await new Prompts(file).list())[0]?.text, "Short summary: {{input}}");
  await p.remove(a.id);
  assert.equal((await p.list()).length, 0);
});
