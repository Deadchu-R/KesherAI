import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unrealLogRoute } from "./unreal-log.js";

test("GET /api/unreal/log: only a found project, its log's end, filtered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-uelog-route-"));
  await mkdir(join(dir, "Saved", "Logs"), { recursive: true });
  await writeFile(join(dir, "Saved", "Logs", "Game.log"), "LogInit: hi\nLogKesherAI: Connected to KesherAI.\nLogExit: bye\n");
  const empty = await mkdtemp(join(tmpdir(), "kesher-uelog-route-"));
  const app = Fastify();
  unrealLogRoute(app, async () => [
    { kind: "unreal", name: "Game", path: dir },
    { kind: "unreal", name: "New", path: empty },
  ]);
  const ok = await app.inject({ url: `/api/unreal/log?project=${encodeURIComponent(dir)}&lines=2&grep=kesherai` });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().lines, ["LogKesherAI: Connected to KesherAI."]);
  assert.equal(ok.json().file, "Game.log");
  assert.equal(ok.json().project, "Game");
  // A path that is not in the list (or reaches out of one) is refused.
  assert.equal((await app.inject({ url: `/api/unreal/log?project=${encodeURIComponent(join(dir, "..", "x"))}` })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/unreal/log" })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/unreal/log?project=${encodeURIComponent(empty)}` })).statusCode, 404);
  await app.close();
});
