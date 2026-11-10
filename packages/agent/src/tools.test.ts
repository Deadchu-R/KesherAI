import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardRewrite, looseEdit } from "./tools.js";

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
    assert.ok(md1.output.split("\n").some((l) => l === j(granted, "README.md")), md1.output);
    assert.doesNotMatch(md1.output, /a\.md/, "the glob is relative to the granted folder");
  });
});
