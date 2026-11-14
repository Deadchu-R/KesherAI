import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile, projectAgents } from "./agents.js";

test("reads a Claude Code agent file, mapping its tools and model", () => {
  const a = parseAgentFile("---\nname: code-reviewer\ndescription: Reviews code after changes\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\n---\nYou are a careful reviewer.\n", "x");
  assert.equal(a?.name, "code-reviewer");
  assert.equal(a?.instructions, "You are a careful reviewer.");
  assert.equal(a?.model, undefined, "Claude's model names mean the chat's model");
  assert.deepEqual(a?.tools, ["read_file", "view_image", "read_document", "search", "find_symbol", "list_files", "code_map", "Bash"]);
  assert.equal(parseAgentFile("no frontmatter", "x"), undefined);
  assert.equal(parseAgentFile("---\nname: a\n---\nbody", "x"), undefined, "needs a description");
});

test("a project's agents: .kesher first, then .claude; the first of a name wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  mkdirSync(join(dir, ".kesher", "agents"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(dir, ".kesher", "agents", "a.md"), "---\nname: Docs\ndescription: d1\nmodel: ollama/qwen3\n---\nmine");
  writeFileSync(join(dir, ".claude", "agents", "b.md"), "---\nname: docs\ndescription: d2\n---\ntheirs");
  writeFileSync(join(dir, ".claude", "agents", "c.md"), "---\ndescription: tests\n---\nrun tests");
  const list = projectAgents(dir);
  assert.deepEqual(list.map((a) => [a.name, a.instructions, a.model ?? ""]), [["Docs", "mine", "ollama/qwen3"], ["c", "run tests", ""]]);
});

test("an agent file with Edit or Write is a worker", () => {
  const a = parseAgentFile("---\nname: fixer\ndescription: fixes bugs\ntools: Read, Edit, Grep\n---\nFix it.", "x");
  assert.equal(a?.write, true);
  assert.ok(a?.tools?.includes("edit_file"));
  assert.equal(parseAgentFile("---\nname: r\ndescription: reads\ntools: Read\n---\nRead.", "x")?.write, undefined);
});
