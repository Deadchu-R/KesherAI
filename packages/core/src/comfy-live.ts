import type { ComfyStatus } from "./comfy-manager.js";

/** What the ComfyUI chip under every chat box shows (GET /api/comfy/live). */
export interface ComfyLive {
  /** A ComfyUI folder is known (KesherAI's own copy or the user's). */
  installed: boolean;
  /** ComfyUI answers on its port (KesherAI started it, or the user runs their own). */
  up: boolean;
  /** KesherAI started this ComfyUI, so it can stop it too. */
  managed: boolean;
  /** Installing, starting, or the last error, while there is one. */
  phase?: ComfyStatus["phase"];
  /** Jobs running and waiting in ComfyUI's queue (0 when it is down). */
  running: number;
  pending: number;
}

/**
 * Reads ComfyUI's live state for the chip: one short call to its `/queue` (a refused connection on the
 * computer itself answers at once), so the chip can ask every few seconds without loading anything.
 *
 * @param status - The managed ComfyUI's state ({@link ComfyManager.status}).
 * @param get - fetch, injectable for tests.
 * @returns Whether it is up, and how many jobs run and wait.
 */
export async function readComfyLive(status: ComfyStatus, get: typeof fetch = fetch): Promise<ComfyLive> {
  const base = { installed: status.installed, managed: status.managed && status.running, ...(status.phase ? { phase: status.phase } : {}) };
  const queue = await get(`${status.url}/queue`, { signal: AbortSignal.timeout(1200) })
    .then((r) => (r.ok ? (r.json() as Promise<{ queue_running?: unknown; queue_pending?: unknown }>) : undefined))
    .catch(() => undefined);
  if (!queue) return { ...base, up: false, running: 0, pending: 0 };
  const count = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  return { ...base, up: true, running: count(queue.queue_running), pending: count(queue.queue_pending) };
}
