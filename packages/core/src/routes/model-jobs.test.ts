import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "../server.js";

test("GET /api/models/jobs lists every job, offers setups for the empty ones and never starts a download", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-jobs-")), autodetect: false, pluginRoots: [] });
  try {
    const res = await server.app.inject({ method: "GET", url: "/api/models/jobs?lang=he" });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { jobs: Array<{ id: string; state: string; suggestion?: { setup: string } }>; plan: { ids: string[]; totalGb: number } };
    assert.deepEqual(body.jobs.map((j) => j.id), ["chat", "router", "image", "video", "speech-to-text", "text-to-speech", "hebrew-voice", "embedding", "music", "3d", "translator", "vision"]);
    for (const j of body.jobs) if (j.suggestion) assert.match(j.suggestion.setup, /^\/api\//);
    assert.ok(body.plan.ids.every((id) => body.jobs.some((j) => j.id === id && j.suggestion)));
    assert.equal(server.services.downloads.list().length, 0, "reading the card downloads nothing");
  } finally {
    await server.close();
  }
});
