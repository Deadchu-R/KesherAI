/**
 * What runs once the server is made (docs/ARCHITECTURE_REVIEW.md B8): the graphics card guard (holds local work while
 * the card is too hot or paused, unloads idle models), closing KesherAI's own engines left running by an update or a
 * crash, and bringing back the model loaded last time without delaying start-up.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "@kesher/providers";
import type { ComfyManager } from "../comfy-manager.js";
import type { KesherConfig } from "../config.js";
import type { FaultLog } from "../fault-log.js";
import type { GpuGuard } from "../gpu-guard.js";
import type { LlamaEngine } from "../llamacpp.js";
import { closeLeftOverEngines, parseGpuApps, processParent } from "../pc-fix.js";
import { loadModel } from "../routes/engine.js";
import type { KesherServices } from "../services.js";

/**
 * Starts the guard and the start-up load.
 *
 * @param p - The server (the guard stops with it), the services, the guard, the chat engine, ComfyUI, the settings,
 *   the fault log, the models, and whether this start follows Terminate (then nothing is loaded until asked).
 */
export function startEngines(p: { app: FastifyInstance; services: KesherServices; guard: GpuGuard; engine: LlamaEngine; comfy: ComfyManager; config: KesherConfig; faults: FaultLog; registry: ProviderRegistry; afterTerminate: boolean }): void {
  const { app, services, guard, engine, comfy, config, faults, registry, afterTerminate } = p;
  // Protect the graphics card: hold local work while it is too hot or paused, unload idle models.
  /** The last model's load at start-up, while it runs. */
  let startLoad: Promise<unknown> | undefined;
  let comfyUsed = false;
  guard.add({
    name: "chat model",
    providers: ["llamacpp"],
    // While the start-up load is still going, a message waits for it instead of failing.
    loaded: () => engine.status().running && !startLoad,
    unload: async () => {
      await engine.stop("unused for a while (Settings → graphics card: unload after)");
      // Remembered, so a restart (an update) does not load it again into a card nobody is using.
      config.engines.lastUnloaded = true;
      await services.saveConfig().catch(() => undefined);
    },
    reload: async () => {
      if (startLoad) return void (await startLoad);
      const path = config.engines.lastModel;
      if (!path || !existsSync(path) || !engine.status().installed) return;
      // Which part asked, so the engine's line says it (Roee, 2026-11-18: "loaded again in the background" with nothing
      // of his running; it was a start-up routine's chat).
      const busy = Object.keys(services.conversations.activity());
      const titles = busy.map((id) => services.library.listConversations().find((c) => c.id === id)?.title).filter(Boolean).slice(0, 2);
      await loadModel(services, path, undefined, titles.length ? `needed by the chat "${titles.join('", "')}"` : "a request needed the model (not a chat: a title, a report, a pipeline or the phone)");
    },
    pids: () => (engine.pid ? [engine.pid] : []),
  });
  guard.add({
    name: "ComfyUI models",
    providers: ["comfyui"],
    loaded: () => comfyUsed && comfy.status().running,
    // Frees ComfyUI's memory without stopping it; the next flow loads what it needs.
    unload: async () => {
      comfyUsed = false;
      await fetch(`${comfy.status().url}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) });
    },
    used: () => void (comfyUsed = true),
    pids: () => (comfy.pid ? [comfy.pid] : []),
  });
  registry.setGate(guard);
  // KesherAI's own engines left running (an update or a crash) are closed before the card is used, and at start.
  const closeStale = async () => {
    const closed = await closeLeftOverEngines({
      ownPids: guard.ownPids(),
      parentOf: processParent,
      gpuApps: () => new Promise((done) => execFile("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 8000 }, (err, out) => done(err ? [] : parseGpuApps(String(out))))),
    });
    if (closed.length) faults.add({ kind: "engine", where: "left-over engines", message: `Closed ${closed.length} KesherAI engine(s) left running: ${closed.map((c) => `${c.name.split(/[\\/]/).pop()} (${Math.round(c.bytes / 1024 ** 3)} GB)`).join(", ")}` });
  };
  guard.beforeUse = closeStale;
  setTimeout(() => void closeStale().catch(() => undefined), 5_000).unref();
  guard.start();
  app.addHook("onClose", async () => guard.stop());

  // Bring back the model that was loaded last time, without delaying start-up.
  const last = config.engines.lastModel;
  // The engine is chosen from the start, so a message sent while the model loads (or after Terminate, when it is
  // not loaded) waits for it through the guard instead of failing with "No provider llamacpp" (found on the phone,
  // and on the PC half a minute after an update).
  if (last && existsSync(last) && engine.status().installed) services.registerEngineProvider();
  if (config.engines.autoLoadLast && !afterTerminate && !config.engines.lastUnloaded && last && existsSync(last) && engine.status().installed) {
    startLoad = loadModel(services, last, undefined, "the last model, at start-up")
      .catch((err) => engine.fail(err))
      .finally(() => (startLoad = undefined));
  }
}
