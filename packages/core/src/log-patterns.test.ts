import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLog } from "./log-parse.js";
import { groupPatterns, maskMessage, patternId, templateMatches, TREND_BUCKETS } from "./log-patterns.js";

test("masking hides numbers, ids, paths (both kinds), hex, quoted values, urls and addresses", () => {
  assert.equal(maskMessage('took 12 ms for "a b.png"'), "took <num> ms for <str>");
  assert.equal(maskMessage("open C:\\Users\\someone\\x.log failed"), "open <path> failed");
  assert.equal(maskMessage("read /home/someone/x/y.txt"), "read <path>");
  assert.equal(maskMessage("job 3f2a9c1e-1234-4abc-9def-0123456789ab at 0xDEADBEEF commit a1b2c3d4e5"), "job <id> at <hex> commit <hex>");
  assert.equal(maskMessage("connect 192.168.1.20:8080 via https://example.com/a?b=1"), "connect <ip> via <url>");
  assert.equal(maskMessage("task r-20261122-01 used 3.5GB"), "task <id> used <num>");
});

test("lines with the same shape group together; similar templates merge with <*>", () => {
  const e = parseLog(
    [
      "2026-11-24T10:00:00Z [ERROR] Failed to load model alpha after 3 tries",
      "2026-11-24T10:05:00Z [ERROR] Failed to load model beta after 4 tries",
      "2026-11-24T10:10:00Z [ERROR] Failed to load model gamma after 5 tries",
      "2026-11-24T10:20:00Z [INFO] Server started on port 3000",
      "2026-11-24T11:00:00Z [ERROR] Failed to load model delta after 9 tries",
    ].join("\n"),
  );
  const p = groupPatterns("src", e);
  assert.equal(p.length, 2);
  assert.equal(p[0]!.template, "Failed to load model <*> after <num> tries");
  assert.equal(p[0]!.count, 4);
  assert.equal(p[0]!.first, Date.parse("2026-11-24T10:00:00Z"));
  assert.equal(p[0]!.last, Date.parse("2026-11-24T11:00:00Z"));
  assert.equal(p[0]!.sample, "Failed to load model delta after 9 tries");
  assert.equal(p[0]!.trend.length, TREND_BUCKETS);
  assert.equal(p[0]!.trend.reduce((a, b) => a + b, 0), 4);
  assert.equal(p[0]!.id, patternId("src", "error", undefined, p[0]!.template));
});

test("different levels, categories and short lines never merge", () => {
  const e = parseLog(["E: boom", "W: boom", "E: crash", "LogTemp: Error: disk full", "LogNet: Error: disk full"].join("\n"));
  const p = groupPatterns("s", e);
  assert.equal(p.length, 5);
});

test("rising: most of the lines in the last quarter of the time read", () => {
  const lines = ["2026-11-24T00:00:00Z start", ...Array.from({ length: 8 }, (_, i) => `2026-11-24T11:5${i}:00Z E: timeout ${i}`)];
  const p = groupPatterns("s", parseLog(lines.join("\n")));
  assert.equal(p.find((x) => x.level === "error")!.rising, true);
});

test("a saved template still matches after more <*> appear", () => {
  assert.equal(templateMatches("Failed to load model alpha after <num> tries", "Failed to load model <*> after <num> tries"), true);
  assert.equal(templateMatches("Failed to load model alpha", "Something else entirely here"), false);
});
