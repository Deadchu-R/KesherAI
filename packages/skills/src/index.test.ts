import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, loadSkillBody, parseSkillMarkdown } from "./index.js";

test("parses frontmatter with quoted and unquoted values", () => {
  const { frontmatter, body } = parseSkillMarkdown('---\nname: pdf\ndescription: "Read PDFs"\n---\n# Steps\nDo it.');
  assert.deepEqual(frontmatter, { name: "pdf", description: "Read PDFs" });
  assert.equal(body, "# Steps\nDo it.");
});

test("discovers skills, skips invalid ones and loads bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-skills-"));
  await mkdir(join(root, "good"));
  await writeFile(join(root, "good", "SKILL.md"), "---\nname: good\ndescription: A good skill\n---\nBody here");
  await mkdir(join(root, "no-description"));
  await writeFile(join(root, "no-description", "SKILL.md"), "---\nname: x\n---\n");
  await mkdir(join(root, "empty"));

  const skills = await discoverSkills([root, join(root, "missing")]);
  assert.deepEqual(skills.map((s) => s.name), ["good"]);
  assert.equal(await loadSkillBody(skills[0]!), "Body here");
});
