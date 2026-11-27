/**
 * The run guard's watchdog model on loan (watchdog-model.ts), made from the real llama.cpp: a second, CPU-only
 * instance (`-ngl 0`) of the small router model, started for a check and stopped after a minute idle. It shares the
 * engine files of the main one and never touches the main model.
 */
import type { DataPaths, KesherConfig } from "../config.js";
import { freePort, LlamaEngine } from "../llamacpp.js";
import { WatchdogModel, type WatchEngine } from "../watchdog-model.js";
import type { CpuModels } from "./build-cpu-pool.js";

/**
 * @param p.paths - The data folders (the engines folder).
 * @param p.config - The settings (the main engine's version and arguments).
 * @param p.binary - The main engine's llama-server (undefined until installed).
 * @param p.routerFile - The small model's GGUF file, if it is on this computer.
 * @param p.cpu - The pool of CPU models (cpu-pool.ts): when it is on, CPU checks go through it.
 * @param p.log - Logs a line.
 * @returns The loan.
 */
export function buildWatchdog(p: { paths: DataPaths; config: KesherConfig; binary: () => string | undefined; routerFile: () => Promise<string | undefined>; cpu?: () => CpuModels | undefined; log: (line: string) => void }): WatchdogModel {
  return new WatchdogModel({
    modelPath: p.routerFile,
    log: p.log,
    make: async (cpu): Promise<WatchEngine | undefined> => {
      // On the processor, through the pool: it loads the model itself (its queue, threads and idle unload).
      const pool = cpu ? p.cpu?.() : undefined;
      if (pool?.enabled()) {
        return {
          load: async () => undefined,
          // The pool unloads it after its own idle minutes (CPU models card), not the loan's one minute.
          stop: async () => undefined,
          ask: (system, prompt, signal) => pool.complete("watchdog", [{ role: "system", content: system }, { role: "user", content: prompt }], { temperature: 0, maxTokens: 120 }, signal),
        };
      }
      const binaryPath = p.binary();
      if (!binaryPath) return undefined;
      const e = new LlamaEngine({
        dir: p.paths.engines,
        binaryPath,
        ...(p.config.engines.llamaVersion ? { version: p.config.engines.llamaVersion } : {}),
        port: await freePort(),
        // CPU: no layers on the card. GPU (a CPU answer was too slow): the engine's own plan, no extra argument.
        args: cpu ? ["-ngl", "0"] : p.config.engines.llamaServerArgs,
        parallel: 1,
      });
      return {
        load: (file) => e.load(file),
        stop: (reason) => e.stop(reason),
        ask: async (system, prompt, signal) => {
          const res = await fetch(`${e.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${e.apiKey}` },
            body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0, max_tokens: 120, chat_template_kwargs: { enable_thinking: false } }),
            signal,
          });
          if (!res.ok) throw new Error(`The watchdog engine answered ${res.status}`);
          return ((await res.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
        },
      };
    },
  });
}
