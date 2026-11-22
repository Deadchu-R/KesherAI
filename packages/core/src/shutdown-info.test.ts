import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAlive, parsePowerEvents, powerMeaning, readShutdownInfo, shutdownLine } from "./shutdown-info.js";

const ALIVE = "2026-11-22T06:02:00.000Z (pid 4, 90 s after start; this app 1753 MB, heap 457/467 MB, external 1115 MB; computer free 66057 of 95791 MB)";

test("parseAlive reads time, heap and free memory", () => {
  assert.deepEqual(parseAlive(ALIVE), { lastAlive: "2026-11-22T06:02:00.000Z", freeMb: 66057, heapMb: [457, 467] });
  assert.deepEqual(parseAlive("garbage"), {});
});

test("shutdownLine: Hebrew sentence for an unclean end and a clean one", () => {
  const l = shutdownLine({ clean: false, freeMb: 66057, lastAlive: new Date(2026, 10, 22, 8, 5).toISOString() });
  assert.equal(l.he, "הכיבוי האחרון: לא מסודר בשעה 08:05 — זיכרון פנוי 64.5 GB");
  assert.match(l.en, /not clean at 08:05/);
  assert.equal(shutdownLine({ clean: true }).he, "הכיבוי האחרון: מסודר");
});

test("power events are parsed and explained; garbage is skipped", () => {
  const ev = parsePowerEvents("2026-11-22T06:03:10.0000000Z|41|The system rebooted without cleanly shutting down\nnoise\n2026-11-20T10:00:00.0000000Z|1074|The process C:\\x.exe has initiated the restart. Reason: Operating System: Recovery (Planned). Comment:");
  assert.deepEqual(ev.map((e) => e.id), [41, 1074]);
  assert.match(ev[1]!.meaning.en, /Operating System: Recovery \(Planned\)/);
  assert.match(powerMeaning(6008, "").en, /Unexpected/);
});

test("readShutdownInfo reads the desktop record, and has none without it", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-shutdown-"));
  assert.equal((await readShutdownInfo(root)).lastRun, undefined);
  await mkdir(join(root, "logs"));
  await writeFile(join(root, "logs", "last-shutdown.json"), JSON.stringify({ clean: false, alive: ALIVE }));
  const info = await readShutdownInfo(root);
  assert.equal(info.lastRun?.clean, false);
  assert.equal(info.lastRun?.freeMb, 66057);
  assert.ok(info.line?.he.startsWith("הכיבוי האחרון: לא מסודר"));
});
