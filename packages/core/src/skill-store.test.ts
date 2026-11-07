import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore, parseSkillSource } from "./skill-store.js";

test("skill sources: short and github.com forms", () => {
  assert.deepEqual(parseSkillSource("a/b"), { owner: "a", repo: "b", path: "" });
  assert.deepEqual(parseSkillSource("Deadchu-R/KesherAI/community/skills/x"), { owner: "Deadchu-R", repo: "KesherAI", path: "community/skills/x" });
  assert.deepEqual(parseSkillSource("https://github.com/o/r/tree/main/skills/pdf/SKILL.md"), { owner: "o", repo: "r", path: "skills/pdf", ref: "main" });
  assert.throws(() => parseSkillSource("not a repo"));
});

test("write, list, use and delete a skill; install one from GitHub", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-skills-"));
  const files: Record<string, string> = {
    "/repos/o/r/contents/skills": JSON.stringify([{ name: "notes", path: "skills/notes", type: "dir", size: 0, download_url: null }]),
    "/repos/o/r/contents/skills/notes": JSON.stringify([
      { name: "SKILL.md", path: "skills/notes/SKILL.md", type: "file", size: 60, download_url: "https://raw/notes/SKILL.md" },
      { name: "ref", path: "skills/notes/ref", type: "dir", size: 0, download_url: null },
    ]),
    "/repos/o/r/contents/skills/notes/ref": JSON.stringify([{ name: "guide.md", path: "skills/notes/ref/guide.md", type: "file", size: 5, download_url: "https://raw/notes/ref/guide.md" }]),
    "https://raw/notes/SKILL.md": "---\nname: notes\ndescription: Take meeting notes.\n---\nWrite the decisions.",
    "https://raw/notes/ref/guide.md": "Guide",
  };
  const fake = (async (url: string) => {
    const key = url.replace("https://api.github.com", "");
    const body = files[key];
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch;
  const store = new SkillStore(dir, fake);
  await store.save({ name: "Review Code", description: "Review code carefully.", body: "Check bugs first." });
  assert.deepEqual((await store.list()).map((s) => s.name), ["review-code"]);
  assert.match(await store.promptSection(), /review-code: Review code carefully\.[\s\S]*use_skill/);
  assert.equal(store.count, 1);

  assert.deepEqual(await store.install("o/r/skills"), ["notes"]);
  assert.equal(await readFile(join(dir, "notes", "ref", "guide.md"), "utf8"), "Guide");
  const tool = store.tool();
  const used = await tool.run({ name: "notes" }, {} as never);
  assert.match(used.output, /# Skill: notes\n\nWrite the decisions\.[\s\S]*ref\/guide\.md/);
  assert.equal((await tool.run({ name: "notes", file: "ref/guide.md" }, {} as never)).output, "Guide");
  await assert.rejects(tool.run({ name: "notes", file: "../review-code/SKILL.md" }, {} as never), /not in the skill's folder/);
  await assert.rejects(store.install("o/r/missing"), /Not found/);

  await store.remove("notes");
  assert.equal(existsSync(join(dir, "notes")), false);
});
