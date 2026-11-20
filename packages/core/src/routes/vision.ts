import type { FastifyInstance } from "fastify";
import { VISION_MODELS, type VisionChoice } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { visionServiceOf } from "../vision-service.js";
import { BENCH_TASKS, runVisionBench, type BenchTask, type Drawn } from "../vision-bench.js";
import type { BrowserBridge } from "../browser-bridge.js";

/** What Settings shows about one vision model. */
export interface VisionModelView {
  id: string;
  name: string;
  repo: string;
  sizeGb: number;
  approx: boolean;
  vramGb: number;
  license: string;
  source: string;
  installId: string;
  note: { en: string; he: string };
  installed: boolean;
  busy: boolean;
}

const CHOICES: readonly VisionChoice[] = ["auto", "qwen3-vl-8b", "ui-tars-1.5-7b"];

/**
 * Draws a fixture page in a new tab of KesherAI's own browser pane and takes its picture with the target's box: no app
 * on the computer is opened or clicked. The tab is closed after.
 *
 * @param b - The browser bridge (the desktop app's pane).
 * @returns A drawer for the bench, and how to close its tab.
 */
async function paneDrawer(b: BrowserBridge): Promise<{ draw: (t: BenchTask) => Promise<Drawn>; close: () => Promise<void> }> {
  await b.paneCall("pane-new");
  const tabs = (await b.paneCall<{ tabs: Array<{ id: number }> }>("pane-state")).tabs;
  const id = Math.max(...tabs.map((t) => t.id));
  // The tab's debugger reaches the bridge right after the tab is made; wait a little for it.
  for (let i = 0; i < 20; i++) {
    const ok = await b.userCdp(async (_p, tab) => tab === id).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    draw: (t) =>
      b.userCdp(async (p, tab) => {
        if (tab !== id) throw new Error("The test tab is not in front.");
        await p.evaluate(`document.open();document.write(${JSON.stringify(t.html)});document.close();new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>r("ok"))))`);
        const box = JSON.parse(await p.evaluate(`(()=>{const r=document.getElementById("target").getBoundingClientRect();return JSON.stringify([r.x,r.y,r.width,r.height,innerWidth])})()`)) as number[];
        const shot = await p.screenshot();
        const k = shot.width / Math.max(1, box[4]!);
        return { png: shot.data, width: shot.width, height: shot.height, target: [box[0]! * k, box[1]! * k, box[2]! * k, box[3]! * k] };
      }),
    close: () => b.paneCall("pane-close", { id }).then(() => undefined, () => undefined),
  };
}

/**
 * The vision models' routes (Phase 6). From the phone they run on the computer, like every route.
 *
 * - GET  /api/vision → `{ models, choice, dir, loaded?, bench, runs }`
 * - PUT  /api/vision/choice `{ model }` → saves which model finds things (auto / an id)
 * - POST /api/vision/bench → starts "Test vision models" (202); 409 when it runs, nothing is installed or no pane
 * - POST /api/vision/unload → frees the vision slot's memory
 * Installing goes through the Install button's routes (/api/installables/vision-model…).
 */
export async function visionRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const v = () => visionServiceOf(s.config);

  app.get("/api/vision", async (_req, reply) => {
    const vs = v();
    if (!vs) return reply.code(404).send({ error: "Vision models run in the main KesherAI app." });
    const installed = await vs.refresh();
    const models: VisionModelView[] = VISION_MODELS.map((m) => ({
      id: m.id, name: m.name, repo: m.repo, sizeGb: Math.round((m.sizeGb + m.mmprojGb) * 10) / 10, approx: !!m.approx, vramGb: m.vramGb,
      license: m.license, source: m.source, installId: m.installId, note: m.note, installed: installed.includes(m.id), busy: vs.busy(m.id),
    }));
    return { models, choice: s.config.computer.visionModel, dir: vs.dir(), ...vs.status(), bench: vs.bench, runs: await vs.runs(), pane: s.browser.status().pane };
  });

  app.put<{ Body: { model?: unknown } }>("/api/vision/choice", async (req, reply) => {
    const model = req.body?.model as VisionChoice;
    if (!CHOICES.includes(model)) return reply.code(400).send({ error: `model: one of ${CHOICES.join(", ")}` });
    s.config.computer.visionModel = model;
    await s.saveConfig();
    return { choice: model };
  });

  app.post("/api/vision/unload", async () => {
    await v()?.unload();
    return { ok: true };
  });

  app.post("/api/vision/bench", async (_req, reply) => {
    const vs = v();
    if (!vs) return reply.code(404).send({ error: "Vision models run in the main KesherAI app." });
    if (vs.bench.running) return reply.code(409).send({ error: "The test is already running." });
    const installed = await vs.refresh();
    const models = VISION_MODELS.filter((m) => installed.includes(m.id));
    if (!models.length) return reply.code(409).send({ error: "No vision model is installed yet.", code: "none-installed" });
    if (!s.browser.status().pane) return reply.code(409).send({ error: "The test draws its pages in KesherAI's own browser: open KesherAI on the computer.", code: "no-pane" });
    vs.bench = { running: true, done: 0, of: models.length * BENCH_TASKS.length };
    void (async () => {
      let drawer: Awaited<ReturnType<typeof paneDrawer>> | undefined;
      try {
        drawer = await paneDrawer(s.browser);
        const run = await runVisionBench({
          models,
          load: (m) => vs.load(m),
          ground: (m, r) => vs.grounder.ground(m, r),
          draw: drawer.draw,
          progress: (done, of, model) => (vs.bench = { running: true, done, of, model }),
        });
        await vs.saveRun(run);
        vs.bench = { running: false, done: vs.bench.of, of: vs.bench.of };
      } catch (err) {
        vs.bench = { running: false, done: vs.bench.done, of: vs.bench.of, error: (err as Error).message };
      } finally {
        await drawer?.close();
        // The test loads models one after another; free the card again.
        await vs.unload().catch(() => undefined);
      }
    })();
    return reply.code(202).send({ bench: vs.bench });
  });
}
