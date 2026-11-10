import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaudeSessions, readClaudeSession, sessionToChat, toolLine } from "./claude-code-import.js";

const lines = (cwd: string) => [
  { type: "user", uuid: "u1", parentUuid: null, cwd, timestamp: "2026-11-10T10:00:00Z", message: { role: "user", content: "Fix the login bug" } },
  { type: "assistant", uuid: "a1", parentUuid: "u1", cwd, message: { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] } },
  { type: "user", uuid: "r1", parentUuid: "a1", cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "AWS_SECRET=abc... 300 lines", is_error: false }] } },
  // A subagent's work and an abandoned branch are left out.
  { type: "assistant", uuid: "s1", parentUuid: "r1", isSidechain: true, message: { role: "assistant", content: "sub work" } },
  { type: "assistant", uuid: "x1", parentUuid: "u1", cwd, message: { role: "assistant", content: "old branch" } },
  { type: "assistant", uuid: "a2", parentUuid: "r1", cwd, message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/login.ts" } }, { type: "text", text: "Fixed the check." }] } },
  { type: "user", uuid: "u2", parentUuid: "a2", cwd, message: { role: "user", content: "<system-reminder>ignore</system-reminder>" } },
  { type: "ai-title", aiTitle: "Login bug" },
];

test("a Claude Code session becomes a chat: words kept, tool calls as short lines, no thinking, tool output, subagents or old branches", () => {
  const chat = sessionToChat(lines("/proj") as never, "/x/abc.jsonl")!;
  assert.equal(chat.source, "claude-code");
  assert.equal(chat.originalId, "abc");
  assert.equal(chat.title, "Login bug");
  assert.equal(chat.workspace, "/proj");
  const all = chat.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
  assert.match(all, /^user: Fix the login bug/);
  assert.match(all, /assistant: Looking\.\n\(ran: pnpm test\)/);
  assert.match(all, /\(edited: src\/login\.ts\)\nFixed the check\./);
  for (const gone of ["secret plan", "AWS_SECRET", "sub work", "old branch", "system-reminder"]) assert.ok(!all.includes(gone), gone);
  assert.match(chat.messages.at(-1)!.text, /continues a Claude Code session/);
  assert.equal(toolLine("WebSearch", { query: "q" }), "searched the web: q");
});

test("sessions are found under ~/.claude/projects, and nothing outside it is read", async () => {
  const home = await mkdtemp(join(tmpdir(), "cc-"));
  const dir = join(home, ".claude", "projects", "-proj");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "abc.jsonl"), lines("/proj").map((l) => JSON.stringify(l)).join("\n"));
  const found = await findClaudeSessions(home);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.title, "Login bug");
  assert.equal((await readClaudeSession(found[0]!.file, home))?.messages[0]?.text, "Fix the login bug");
  await writeFile(join(home, "other.jsonl"), "{}");
  await assert.rejects(readClaudeSession(join(home, "other.jsonl"), home), /not a Claude Code session/);
  await assert.rejects(readClaudeSession(join(dir, "..", "..", "..", "other.jsonl"), home), /not a Claude Code session/);
});
