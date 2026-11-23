import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { budgetOf, detectHardwareCached } from "@kesher/downloads";
import { ROUTER_MODEL } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { buildModelJobs, setupAllPlan } from "../model-jobs.js";
import { matchRecommended } from "../model-scan.js";
import { imageDownloadPending, imagePickFor } from "../sdcpp.js";
import { RECOMMENDED_VIDEO_MODEL, videoStatus } from "../video-setup.js";
import { engineBusy, modelsOnComputer } from "./engine.js";
import { classifySpeechModels } from "../hebrew-tts.js";
import { speechModelsOnComputer } from "./speech.js";

/**
 * "Models per job" (Settings › General): `GET /api/models/jobs?lang=he` → `{ jobs, plan: { ids, totalGb }, freeGb }`.
 * Only reads: each job's one-tap setup posts the job's existing route (`suggestion.setup`), so every download still
 * goes through the downloads manager and starts only on the user's tap. Picking: model-jobs.ts.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function modelJobRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get<{ Querystring: { lang?: string } }>("/api/models/jobs", async (req) => {
    const hw = await detectHardwareCached().catch(() => undefined);
    const found = await modelsOnComputer(s).catch(() => []);
    const ggufs = found.filter((m) => m.format === "gguf");
    const image = s.config.activeModels.image;
    const [video, stt, embFound] = await Promise.all([
      videoStatus({ sd: s.sd, config: s.config, modelsDir: () => s.paths.models }).catch((): { ready: boolean; downloading: boolean; model?: string } => ({ ready: false, downloading: false })),
      s.whisper.status(),
      s.semantic.onComputer().catch(() => undefined),
    ]);
    const tts = s.kokoro.status();
    const [hebrewTts, speech] = await Promise.all([s.f5Hebrew.status(), speechModelsOnComputer(s).then(classifySpeechModels, () => undefined)]);
    const emb = s.semantic.status();
    const engine = s.engine.status();
    const router = matchRecommended(found, ROUTER_MODEL.repo, ROUTER_MODEL.filePattern);
    const jobs = buildModelJobs(
      {
        active: s.config.activeModels,
        ...(hw ? { budget: budgetOf(hw) } : {}),
        hebrew: req.query.lang === "he",
        local: isLocalRequest(req),
        chatFiles: ggufs.map((m) => ({ path: m.path, name: m.name, size: m.size })),
        engineBusy: engineBusy(s),
        engineInstalled: !!engine.binaryPath,
        ...(router ? { routerFile: router.name } : {}),
        // The same check as the Install buttons (installables.ts): a built-in engine picture model's file must be there.
        image: { fileMissing: !!image && image.startsWith("sdcpp/") && !existsSync(join(s.paths.models, "image", image.slice(6))), busy: imageDownloadPending() },
        video: { ready: video.ready, busy: video.downloading, ...(video.model ? { model: video.model } : {}), name: RECOMMENDED_VIDEO_MODEL.name, sizeGb: 7.2 },
        stt: { ready: stt.engine && !!stt.model, busy: !!stt.busy, ...(stt.model ? { model: stt.model.split(/[\\/]/).pop()! } : {}), possible: stt.localPossible, label: stt.recommended.label, sizeGb: stt.recommended.sizeGb },
        tts: { ready: tts.ready, busy: tts.busy, sizeGb: tts.sizeMb / 1024 },
        hebrewTts: { engine: s.config.speech.ttsHebrew, installed: hebrewTts.installed, busy: hebrewTts.phase === "installing", ...(hebrewTts.model ? { model: hebrewTts.model } : {}), sizeGb: hebrewTts.sizeGb },
        ...(speech ? { speechUnused: { zonos: speech.zonos.map((f) => f.name), otherStt: speech.otherStt.map((f) => f.name) } } : {}),
        embedding: { ready: emb.usable, busy: emb.phase === "downloading" || emb.phase === "loading", ...(emb.active ? { model: emb.active.split("/").pop()! } : {}), name: emb.model.name, sizeGb: emb.model.sizeGb, ...(embFound ? { onComputer: embFound.name } : {}) },
        translator: s.config.translator ?? "main",
        vision: s.config.computer.visionModel,
      },
      imagePickFor,
    );
    const plan = setupAllPlan(jobs);
    const disk = await statfs(s.paths.models).then((st) => (st.bavail * st.bsize) / 1024 ** 3, () => undefined);
    return { jobs, plan: { ids: plan.jobs.map((j) => j.id), totalGb: plan.totalGb }, ...(disk !== undefined ? { freeGb: Math.round(disk * 10) / 10 } : {}) };
  });
}
