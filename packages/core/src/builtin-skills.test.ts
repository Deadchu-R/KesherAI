import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SKILLS, seedBuiltinSkills } from "./builtin-skills.js";
import { SkillStore } from "./skill-store.js";

test("the specialist skills are written once, found by the skill store, and a user's own edit is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-"));
  assert.deepEqual(await seedBuiltinSkills(dir), BUILTIN_SKILLS.map((s) => s.name));
  assert.deepEqual(await seedBuiltinSkills(dir), [], "already there");
  const names = (await new SkillStore(dir).list()).map((s) => s.name).sort();
  assert.deepEqual(names, ["level-design-specialist", "materials-specialist", "vfx-specialist"]);
  // The user removes the marker and edits: kept.
  const file = join(dir, "vfx-specialist", "SKILL.md");
  await writeFile(file, "---\nname: vfx-specialist\ndescription: \"mine\"\n---\nmy own text\n");
  await seedBuiltinSkills(dir);
  assert.match(await readFile(file, "utf8"), /my own text/);
  // An older built-in copy is replaced.
  const mat = join(dir, "materials-specialist", "SKILL.md");
  await writeFile(mat, "<!-- kesher-builtin: materials-specialist v0 -->\nold");
  assert.deepEqual(await seedBuiltinSkills(dir), ["materials-specialist"]);
  assert.match(await readFile(mat, "utf8"), /Materials specialist/);
});
