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
import { GameWatch } from "../game-watch.js";
import { PlayStandby } from "../play-standby.js";
import { unityInPlay } from "../unity-play.js";
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
  const games = new GameWatch();
  const { app, services, guard, engine, comfy, config, faults, registry, afterTerminate } = p;
  // Protect the graphics card: hold local work while it is too hot or paused, unload idle models.
  /** The last model's load at start-up, while it runs. */
  let startLoad: Promise<unknown> | undefined;
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
      // No one's chat asked (a background job did): while a game runs it waits for the game to close instead of
      // taking the card (Roee, 27.11: the 27B model loaded itself as Slay the Spire 2 started). A chat the user opens
      // still loads it.
      if (!titles.length && config.guard.freeForPlay !== false) {
        const playing = await games.running();
        if (playing.length) {
          app.log.info(`chat model: not loaded for a background request while a game runs (${playing.slice(0, 2).join(", ")})`);
          throw new Error(`A game is running (${playing[0]}): the chat model loads after it closes.`);
        }
      }
      await loadModel(services, path, undefined, titles.length ? { kind: "chat", chats: titles as string[] } : { kind: "request" });
    },
    pids: () => (engine.pid ? [engine.pid] : []),
    // Load on demand: unloaded after its idle minutes (Settings → graphics card), 0 keeps it loaded.
    idleMinutes: () => config.guard.unloadAfterMinutes,
  });
  guard.add({
    name: "ComfyUI",
    providers: ["comfyui"],
    loaded: () => comfy.status().running,
    // Load on demand: a picture, video or music job starts ComfyUI when it is not running.
    reload: async () => {
      if (config.parts.nodes !== false && comfy.status().installed) await comfy.start();
    },
    // Frees ComfyUI's memory, then stops it (it starts again for the next job). Its own editor open in a page keeps
    // it running, with only the models freed.
    unload: async () => {
      await fetch(`${comfy.status().url}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      if (!comfy.editors) await comfy.stop();
    },
    // Started by hand (Models → ComfyUI) counts as a use, so it is not stopped at the next check.
    lastUsed: () => comfy.startedAt,
    // A job queued in ComfyUI's own editor runs without the guard seeing it: kept while the editor is open and busy.
    busy: () => comfy.editors > 0 && Date.now() - comfy.editorActiveAt < 60_000,
    idleMinutes: () => config.guard.idleComfy ?? 5,
    pids: () => (comfy.pid ? [comfy.pid] : []),
  });
  registry.setGate(guard);
  wirePlayStandby(app, services, guard, config);
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
  // Nothing heavy at start (Roee, 2026-11-21): the last model comes back at start only when it is kept loaded
  // (Settings → load on demand → chat model: keep loaded); otherwise the first message loads it through the guard.
  if (config.engines.autoLoadLast && config.guard.unloadAfterMinutes === 0 && !afterTerminate && !config.engines.lastUnloaded && last && existsSync(last) && engine.status().installed) {
    startLoad = loadModel(services, last, undefined, { kind: "startup" })
      .catch((err) => engine.fail(err))
      .finally(() => (startLoad = undefined));
  }
}

/**
 * Free the graphics card while the game plays (play-standby.ts): Unreal's plugin tells Play over its WebSocket
 * (`{event:"play", on}`), Unity's package through `Temp/KesherPlay.json`, read every 3 seconds while the setting is on.
 */
function wirePlayStandby(app: FastifyInstance, services: KesherServices, guard: GpuGuard, config: KesherConfig): void {
  // No notification: Play starts and ends all the time; the state shows in Models, the model chip and the chat.
  const standby = new PlayStandby(guard, () => config.guard.freeForPlay !== false);
  services.playStandby = standby;
  guard.playStatus = () => standby.status();
  guard.onIdle = () => void standby.poke().catch(() => undefined);
  // Downloads give way to the chat and to the game: the guard knows a local model answers, standby knows Play.
  services.downloads.busySource = () => ({ chat: guard.runningCount() > 0, playing: standby.isPlaying("unity") || standby.isPlaying("unreal") });
  const busyTimer = setInterval(() => services.downloads.refreshBusy(), 1000);
  busyTimer.unref();
  app.addHook("onClose", async () => clearInterval(busyTimer));
  services.unreal.on((event) => {
    if (event === "play") void standby.setPlay("unreal", services.unreal.playing).catch(() => undefined);
    // A closed editor is not in Play.
    if (event === "disconnected") void standby.setPlay("unreal", false).catch(() => undefined);
  });
  const timer = setInterval(() => {
    if (config.guard.freeForPlay === false && !standby.status()) return;
    const projects = [...new Set([...config.unity.projects, ...(services.unity.activeProject ? [services.unity.activeProject] : [])])];
    if (!projects.length) return;
    void unityInPlay(projects).then((on) => standby.setPlay("unity", on)).catch(() => undefined);
  }, 3000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
