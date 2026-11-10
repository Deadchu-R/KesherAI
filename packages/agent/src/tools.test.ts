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
