import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { KesherServices } from "../services.js";
import { engineRoutes } from "./engine.js";

// The "memory check" (fit) and "calibrate" routes only touch s.paths.models and
// s.config.modelFolders on a refused path, before any engine work runs, so a
// minimal fake is enough to prove they refuse a bad path.
async function badPathApp(): Promise<{ app: FastifyInstance; models: string; cleanup: () => Promise<void> }> {
  const models = await mkdtemp(join(tmpdir(), "kesher-models-"));
  const s = {
    paths: { models },
    config: { modelFolders: [] as Array<{ folder: string }> },
    engine: { status: () => ({ running: false, modelPath: undefined }) },
  } as unknown as KesherServices;
  const app = Fastify();
  await engineRoutes(app, s);
  return { app, models, cleanup: () => rm(models, { recursive: true, force: true }) };
}

test("/api/models/fit and /api/models/calibrate refuse paths outside the models folders", async () => {
  const { app, models, cleanup } = await badPathApp();
  try {
    const outside = join(tmpdir(), "kesher-not-a-model.gguf");
    assert.ok(!outside.toLowerCase().startsWith(models.toLowerCase()), "the path is really outside the models folder");
    const fit = await app.inject({ method: "POST", url: "/api/models/fit", payload: { modelPath: outside } });
    assert.equal(fit.statusCode, 400);
    assert.match(String((fit.json() as { error: string }).error), /models folder/i);
    const cal = await app.inject({ method: "POST", url: "/api/models/calibrate", payload: { modelPath: outside } });
    assert.equal(cal.statusCode, 400);
    assert.match(String((cal.json() as { error: string }).error), /models folder/i);
  } finally {
    await cleanup();
    await app.close();
  }
});

test("/api/models/fit and /api/models/calibrate refuse a file inside the models folder that is not a GGUF", async () => {
  const { app, models, cleanup } = await badPathApp();
  try {
    const notGguf = join(models, "notes.txt");
    const fit = await app.inject({ method: "POST", url: "/api/models/fit", payload: { modelPath: notGguf } });
    assert.equal(fit.statusCode, 400);
    assert.match(String((fit.json() as { error: string }).error), /GGUF/i);
    const cal = await app.inject({ method: "POST", url: "/api/models/calibrate", payload: { modelPath: notGguf } });
    assert.equal(cal.statusCode, 400);
    assert.match(String((cal.json() as { error: string }).error), /GGUF/i);
  } finally {
    await cleanup();
    await app.close();
  }
});
