import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./prompt.js";

test("the system prompt's fixed part comes first and is byte-identical in every chat (prompt cache)", async () => {
  const base = await buildSystemPrompt({ productName: "KesherAI" });
  const chatA = await buildSystemPrompt({ productName: "KesherAI", outputsFolder: "/data/chats/a/outputs", toolNotes: ["memory: likes tea"], persona: "Be brief." });
  const chatB = await buildSystemPrompt({ productName: "KesherAI", outputsFolder: "/data/chats/b/outputs", toolNotes: ["web: only example.org"], projectInstructions: "Use tabs." });
  assert.ok(chatA.startsWith(`${base}\n\n`));
  assert.ok(chatB.startsWith(`${base}\n\n`));
  assert.ok(chatA.indexOf("/data/chats/a/outputs") > base.length);
});

test("a coding chat's folder and AGENTS.md also come after the fixed part", async () => {
  const base = await buildSystemPrompt({ productName: "KesherAI" });
  const code = await buildSystemPrompt({ productName: "KesherAI", workspace: "/nonexistent/project" });
  assert.ok(code.startsWith(`${base}\n\n`));
  assert.match(code, /coding agent in the project folder/);
});

test("the prompt tells a simple current fact to be answered from the snippets", async () => {
  assert.match(await buildSystemPrompt({ productName: "KesherAI" }), /answer from the search snippets.*at most 2-3 pages at once/);
});
