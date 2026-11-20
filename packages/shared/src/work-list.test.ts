import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSyncBody } from "./hub-sync.js";
import { parseWorkList, stripMarkdown, workListId, WORK_LIST_LIMITS } from "./work-list.js";

const SAMPLE = `# Work list (Roee and Claude)

Status: ✅ done · 🔨 in progress · ⬜ next · 👤 waits on Roee.

## Now (2026-11-19): research
- ✅ **Mark it and let the model work** (FUTURE_FEATURES), in all four editors:
  - ✅ Pictures: repaint the selection (earlier).
  - ✅ 3D: the "what to do with this part" box.
- 🔨 Video: transitions between clips (Send to the chat → Between clips). Not in a build yet.
- A plain line without a mark.
- ⏸️ Paused: research on the hub as a [Claude connector](https://example.com/x). Stopped at: docs.

- ⬜ Long item that continues
  on the next line. And a second sentence.

## Waiting on Roee 👤
- 👤 Install \`0.6.400\` from the app and check.
* ⬜ Star bullet.
1. ✅ Numbered.
\`\`\`
- ✅ inside a code block
\`\`\`
`;

test("parseWorkList reads marked items with their sections, statuses and sub-lines", () => {
  const items = parseWorkList(SAMPLE);
  assert.deepEqual(
    items.map((i) => [i.section, i.status, i.title]),
    [
      ["Now (2026-11-19): research", "done", "Mark it and let the model work (FUTURE_FEATURES), in all four editors:"],
      ["Now (2026-11-19): research", "doing", "Video: transitions between clips (Send to the chat → Between clips)."],
      ["Now (2026-11-19): research", "paused", "Paused: research on the hub as a Claude connector."],
      ["Now (2026-11-19): research", "next", "Long item that continues on the next line."],
      ["Waiting on Roee 👤", "roee", "Install 0.6.400 from the app and check."],
      ["Waiting on Roee 👤", "next", "Star bullet."],
      ["Waiting on Roee 👤", "done", "Numbered."],
    ],
  );
  assert.equal(items[0]!.text, "Mark it and let the model work (FUTURE_FEATURES), in all four editors:\n- ✅ Pictures: repaint the selection (earlier).\n- ✅ 3D: the \"what to do with this part\" box.");
  assert.equal(items[3]!.text, "Long item that continues on the next line. And a second sentence.");
  assert.deepEqual(items.map((i) => i.order), [0, 1, 2, 3, 4, 5, 6]);
  for (const i of items) assert.match(i.id, /^[\w-]{8,64}$/);
});

test("an item's id survives a status change and edits after its start, not a new section", () => {
  const a = parseWorkList("## S\n- ⬜ Build the thing for the phone and the PC, with tests, and more words to pass sixty chars\n")[0]!;
  const b = parseWorkList("## S\n- ✅ Build the thing for the phone and the PC, with tests, and more words to pass sixty chars. Done in 0.6.401.\n")[0]!;
  const c = parseWorkList("## Other\n- ✅ Build the thing for the phone and the PC, with tests, and more words to pass sixty chars\n")[0]!;
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal(a.id, workListId("S", a.title));
});

test("the same start twice in a section gives two ids", () => {
  const items = parseWorkList("## S\n- ⬜ Same.\n- ✅ Same.\n");
  assert.equal(items.length, 2);
  assert.equal(items[1]!.id, `${items[0]!.id}-2`);
});

test("titles and texts are cut to their limits", () => {
  const long = "word ".repeat(200);
  const [i] = parseWorkList(`## S\n- ⬜ ${long}\n  - ${"ש".repeat(3000)}\n`);
  assert.ok(i!.title.length <= WORK_LIST_LIMITS.titleChars);
  assert.ok(i!.title.endsWith("…"));
  assert.ok(new TextEncoder().encode(i!.text).length <= WORK_LIST_LIMITS.textBytes);
});

test("stripMarkdown keeps the words", () => {
  assert.equal(stripMarkdown("**bold** and *it* `code` [link](http://x) ~~old~~ snake_case_name"), "bold and it code link old snake_case_name");
});

test("a work-list task body keeps its info through cleanSyncBody; other origins drop it", () => {
  const body = { type: "task", title: "T", spec: "S", origin: "work-list", executor: "claude", createdAt: "2026-11-20T00:00:00Z", workList: { section: "Now", status: "doing", order: 3 } };
  assert.deepEqual(cleanSyncBody(body, "task")?.workList, { section: "Now", status: "doing", order: 3 });
  assert.equal(cleanSyncBody({ ...body, origin: "pc" }, "task")?.workList, undefined);
  assert.equal(cleanSyncBody({ ...body, workList: { section: "Now", status: "bogus", order: 3 } }, "task")?.workList, undefined);
});

test("the real work list parses", async () => {
  const { readFile } = await import("node:fs/promises");
  const md = await readFile(new URL("../../../docs/WORK_LIST.md", import.meta.url), "utf8").catch(() => "");
  if (!md) return;
  const items = parseWorkList(md);
  assert.ok(items.length > 10);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});
