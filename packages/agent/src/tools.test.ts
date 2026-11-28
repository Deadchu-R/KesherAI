import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardPlaceholders, guardRewrite, looseEdit } from "./tools.js";

describe("looseEdit", () => {
  const file = ["function a() {", "    if (x) {", "      return 1;", "    }", "}"].join("\n");

  it("matches despite wrong indentation and keeps the file's", () => {
    const out = looseEdit(file, "if (x) {\n  return 1;\n}", "if (y) {\n  return 2;\n}", "\n");
    assert.equal(out, ["function a() {", "    if (y) {", "      return 2;", "    }", "}"].join("\n"));
  });

  it("drops read_file's line numbers", () => {
    const out = looseEdit(file, "    3        return 1;", "    3        return 3;", "\n");
    assert.ok(out?.includes("      return 3;"));
    assert.doesNotMatch(out ?? "", /\d {2}/);
  });

  it("keeps CRLF", () => {
    assert.ok(looseEdit(file.replace(/\n/g, "\r\n"), "return 1;", "return 4;", "\r\n")?.includes("\r\n      return 4;\r\n"));
  });

  it("refuses when the match is not unique or missing", () => {
    assert.equal(looseEdit("a\nb\na\n", "a", "c", "\n"), undefined);
    assert.equal(looseEdit(file, "nope", "c", "\n"), undefined);
  });
});

describe("guardRewrite", () => {
  const big = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");

  it("stops replacing a big file with much less", () => {
    assert.throws(() => guardRewrite("a.tsx", big, "short"), /edit_file/);
  });

  it("allows new files, small files and full rewrites", () => {
    assert.doesNotThrow(() => guardRewrite("a.tsx", null, "x"));
    assert.doesNotThrow(() => guardRewrite("a.tsx", "a\nb", "c"));
    assert.doesNotThrow(() => guardRewrite("a.tsx", big, `${big}\nmore`));
  });
});

import { shortenOldToolOutputs } from "./context.js";

describe("shortenOldToolOutputs in steps", () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "tool" as const, content: `out ${i} ${"x".repeat(2000)}`, toolCallId: `c${i}` }));
  const short = (list: ReturnType<typeof shortenOldToolOutputs>) => list.filter((m) => m.content.includes("[shortened")).length;

  it("moves the line 8 messages at a time, so a local engine's cache survives most steps", () => {
    assert.equal(short(shortenOldToolOutputs(msgs(16), 8, 8)), 8);
    assert.equal(short(shortenOldToolOutputs(msgs(17), 8, 8)), 8, "one more message: the earlier messages are unchanged");
    assert.equal(short(shortenOldToolOutputs(msgs(23), 8, 8)), 8);
    assert.equal(short(shortenOldToolOutputs(msgs(24), 8, 8)), 16);
    assert.equal(short(shortenOldToolOutputs(msgs(17), 8)), 9, "step 1 keeps the old behaviour");
  });
});

describe("list_files in a granted folder", () => {
  it("lists it by its own paths, so a glob matches and read_file can take them", async () => {
    const { mkdtemp, mkdir: md, writeFile: wf } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const { CODE_TOOLS } = await import("./tools.js");
    const own = await mkdtemp(j(tmpdir(), "kesher-own-"));
    const granted = await mkdtemp(j(tmpdir(), "kesher-granted-"));
    await md(j(granted, "docs"));
    await wf(j(granted, "README.md"), "# hi");
    await wf(j(granted, "docs", "a.md"), "a");
    const tool = CODE_TOOLS.find((t) => t.spec.name === "list_files")!;
    const ctx = { workspace: own, extraRoots: [granted] } as unknown as Parameters<typeof tool.run>[1];
    const all = await tool.run({ path: granted }, ctx);
    assert.match(all.output, /README\.md/);
    const md1 = await tool.run({ path: granted, glob: "*.md" }, ctx);
    // In full (Windows may spell the temp folder as RUNNER~1 or runneradmin, so not compared letter for letter).
    const { isAbsolute: abs, basename: base } = await import("node:path");
    assert.ok(md1.output.split("\n").some((l) => abs(l) && base(l) === "README.md"), md1.output);
    assert.doesNotMatch(md1.output, /a\.md/, "the glob is relative to the granted folder");
    const own1 = await tool.run({}, ctx);
    assert.ok(own1.output.includes(granted), "an empty own folder points at the granted one");
    const search = CODE_TOOLS.find((x) => x.spec.name === "search")!;
    const hit = await search.run({ pattern: "hi", path: granted, glob: "*.md" }, { ...ctx, signal: new AbortController().signal } as typeof ctx);
    assert.match(hit.output, /README\.md:1: # hi/);
  });
});

describe("read_file on long lines", () => {
  it("returns whole lines up to the budget and says where to read on, never cutting the middle out", async () => {
    const { mkdtemp, writeFile: wf, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const { CODE_TOOLS } = await import("./tools.js");
    const dir = await mkdtemp(j(tmpdir(), "kesher-read-"));
    try {
      // 500 lines of 200 characters: about 100 KB, far over the 30 KB budget; the target is in the middle.
      const lines = Array.from({ length: 500 }, (_, i) => (i === 250 ? "function target() {}" : `const x${i} = "${"a".repeat(190)}";`));
      await wf(j(dir, "big.js"), lines.join("\n"));
      const tool = CODE_TOOLS.find((t) => t.spec.name === "read_file")!;
      const ctx = { workspace: dir } as unknown as Parameters<typeof tool.run>[1];
      const first = await tool.run({ path: "big.js", offset: 1, limit: 500 }, ctx);
      assert.ok(first.output.length <= 30_000);
      assert.doesNotMatch(first.output, /characters cut/);
      const next = Number(/read on with offset (\d+)/.exec(first.output)?.[1]);
      assert.ok(next > 100 && next < 250, String(next));
      // Reading on reaches the target, in full.
      let at = next;
      let seen = "";
      while (at && !seen.includes("function target")) {
        const part = await tool.run({ path: "big.js", offset: at, limit: 500 }, ctx);
        seen = part.output;
        at = Number(/read on with offset (\d+)/.exec(part.output)?.[1]);
      }
      assert.match(seen, /\s251 {2}function target\(\) \{\}/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("guardPlaceholders", () => {
  it("refuses a write that adds the privacy guard's placeholders", () => {
    assert.throws(() => guardPlaceholders("a.env", "KEY=abc\n", "KEY=[key hidden]\n"), /placeholder/);
    assert.doesNotThrow(() => guardPlaceholders("a.env", "KEY=[key hidden]\n", "KEY=[key hidden]\nB=1\n"));
    assert.doesNotThrow(() => guardPlaceholders("a.ts", null, "const a = [1];\n"));
  });
});

describe("changeSummary and the write tools' results", () => {
  it("gives size and a short hash, and the changed lines when the file existed", async () => {
    const { changeSummary } = await import("./tools.js");
    assert.match(changeSummary(null, "a\nb\n"), /^4 B, sha256 [0-9a-f]{8}$/);
    assert.match(changeSummary("a\nb\nc\n", "a\nB\nc\nd\n"), /^8 B, sha256 [0-9a-f]{8}, \+2 −1 lines$/);
    assert.notEqual(changeSummary(null, "x"), changeSummary(null, "y"));
  });

  it("write_file and edit_file end their result with it", async () => {
    const { CODE_TOOLS } = await import("./tools.js");
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "kesher-chg-"));
    const ctx = { workspace: dir, extraRoots: [], signal: new AbortController().signal, recordChange: () => undefined } as never;
    const write = CODE_TOOLS.find((t) => t.spec.name === "write_file")!;
    const edit = CODE_TOOLS.find((t) => t.spec.name === "edit_file")!;
    const w = await write.run({ path: "a.txt", content: "one\ntwo\n" }, ctx);
    assert.match(w.output, /^Created a\.txt \(3 lines\)\.\nNow 8 B, sha256 [0-9a-f]{8}\.$/);
    const e = await edit.run({ path: "a.txt", old_text: "two", new_text: "2\nthree" }, ctx);
    assert.match(e.output, /^Edited a\.txt\.\nNow \d+ B, sha256 [0-9a-f]{8}, \+2 −1 lines\.$/);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "one\n2\nthree\n");
  });
});

describe("read_file on a large file read whole", () => {
  it("returns the head, the total and how to read on; a small file stays whole; a range is honoured", async () => {
    const { mkdtemp, writeFile: wf, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: j } = await import("node:path");
    const { CODE_TOOLS, LARGE_FILE_HEAD, LARGE_FILE_LINES } = await import("./tools.js");
    const dir = await mkdtemp(j(tmpdir(), "kesher-read-"));
    try {
      await wf(j(dir, "big.log"), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
      await wf(j(dir, "small.txt"), Array.from({ length: LARGE_FILE_LINES }, (_, i) => `row ${i + 1}`).join("\n"));
      const tool = CODE_TOOLS.find((t) => t.spec.name === "read_file")!;
      const ctx = { workspace: dir } as unknown as Parameters<typeof tool.run>[1];
      const whole = await tool.run({ path: "big.log" }, ctx);
      assert.match(whole.output, new RegExp(`${LARGE_FILE_HEAD}  line ${LARGE_FILE_HEAD}\\b`));
      assert.doesNotMatch(whole.output, /line 201\b/);
      assert.match(whole.output, /This file has 5000 lines; only the first 200 are shown/);
      assert.match(whole.output, /offset 201/);
      const small = await tool.run({ path: "small.txt" }, ctx);
      assert.match(small.output, new RegExp(`row ${LARGE_FILE_LINES}$`));
      assert.doesNotMatch(small.output, /only the first/);
      const part = await tool.run({ path: "big.log", offset: 4000, limit: 100 }, ctx);
      assert.match(part.output, /line 4000\b/);
      assert.doesNotMatch(part.output, /only the first/);
      assert.match(CODE_TOOLS.find((t) => t.spec.name === "read_file")!.spec.description, /offset and limit/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
