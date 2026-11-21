import { test } from "node:test";
import assert from "node:assert/strict";
import { checklistTemplate, isSpecialist, parseChecklist, SPECIALISTS } from "./engine-specialists.js";
import { ASSIGN_CHOICES, helperHandoff, parseAssignTo, roleOf } from "./task-assign.js";

test("a specialist's checklist is read from its report, in the role's order", () => {
  const marks = parseChecklist("vfx", "Made FX_fire.\n- [x] created: in the scene\n- [X] spec: fire, 60/s\n- [ ] budget: 800 particles\n- [x] unknown: ignored");
  assert.deepEqual(marks.map((m) => [m.key, m.done]), [["spec", true], ["created", true], ["placed", false], ["tuned", false], ["budget", false]]);
  assert.equal(marks[4]!.note, "800 particles");
  assert.equal(parseChecklist("level", "no checklist").every((m) => !m.done), true);
  assert.equal(checklistTemplate("materials").split("\n").length, SPECIALISTS.materials.checklist.length);
});

test("the specialists are in 'who does it' and their hand-off names the agent", () => {
  for (const id of ["materials", "vfx", "level"] as const) {
    const c = ASSIGN_CHOICES.find((x) => x.to === `helper:${id}`)!;
    assert.ok(c.he && c.en && c.icon);
    assert.equal(parseAssignTo(`helper:${id}`), `helper:${id}`);
    assert.equal(roleOf(c.to), id);
  }
  assert.match(helperHandoff("level", "Arena", "a small arena"), /delegate with agent "level"/);
  assert.match(helperHandoff("build", "t", "x"), /delegate with kind "build"/);
  assert.equal(isSpecialist("vfx"), true);
  assert.equal(isSpecialist("build"), false);
});
