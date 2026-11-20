/**
 * ComfyUI's live progress (its `/ws` socket), as ComfyUI's own page, SwarmUI and Krita AI Diffusion read it: step x of
 * y while a sampler runs, which node runs, and preview frames (binary messages). Also Cancel: a queued prompt is taken
 * off the queue and our running one is interrupted, so Stop in the chat frees the card at once.
 */
import type { JobProgress } from "@kesher/shared";

/** ComfyUI's binary message type for a preview frame (the first 4 bytes, big-endian). */
const PREVIEW_IMAGE = 1;
/** Frames larger than this are skipped (a preview is a small JPEG; a huge one would flood the chat). */
const MAX_FRAME = 200_000;

/**
 * Reads one text message from ComfyUI's socket into progress for one prompt.
 *
 * @param text - The message (JSON `{ type, data }`).
 * @param promptId - The prompt being watched (messages about other prompts are skipped); undefined while it is queued.
 * @returns The progress it carries, `"done"` when the prompt finished, or undefined for anything else.
 */
export function comfyMessage(text: string, promptId: string | undefined): JobProgress | "done" | undefined {
  let m: { type?: unknown; data?: Record<string, unknown> };
  try {
    m = JSON.parse(text) as typeof m;
  } catch {
    return undefined;
  }
  const d = m.data ?? {};
  const mine = !promptId || d.prompt_id === undefined || d.prompt_id === promptId;
  if (!mine) return undefined;
  switch (m.type) {
    case "progress": {
      const step = Number(d.value);
      const steps = Number(d.max);
      return Number.isFinite(step) && Number.isFinite(steps) && steps > 0 ? { phase: "sampling", step, steps } : undefined;
    }
    case "execution_start":
      return { phase: "loading" };
    case "executing":
      return d.node === null ? "done" : undefined;
    case "execution_success":
      return "done";
    case "status": {
      const left = Number((d.status as { exec_info?: { queue_remaining?: unknown } } | undefined)?.exec_info?.queue_remaining);
      return !promptId && left > 1 ? { phase: "queued" } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Reads one binary message from ComfyUI's socket: a preview frame as a `data:` URL.
 *
 * @param bytes - The message: event type (4 bytes), image format (4 bytes: 1 JPEG, 2 PNG), then the picture.
 * @returns The frame, or undefined for other messages and frames that are too big.
 */
export function comfyFrame(bytes: ArrayBuffer): string | undefined {
  if (bytes.byteLength < 9 || bytes.byteLength > MAX_FRAME + 8) return undefined;
  const view = new DataView(bytes);
  if (view.getUint32(0) !== PREVIEW_IMAGE) return undefined;
  const mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${Buffer.from(bytes, 8).toString("base64")}`;
}

/**
 * Watches one prompt on ComfyUI's socket and reports its progress. Fails quietly: without the socket the job still
 * runs (the provider polls `/history` for the result), only the live view is missing.
 *
 * @param baseUrl - ComfyUI's address (http or https).
 * @param clientId - The `client_id` the prompt is queued with (ComfyUI sends previews only to that client).
 * @param onProgress - Called with each update.
 * @returns `setPrompt` (the id once queued) and `close`.
 */
export function watchComfy(baseUrl: string, clientId: string, onProgress: (p: JobProgress) => void): { setPrompt(id: string): void; close(): void } {
  let promptId: string | undefined;
  let ws: WebSocket | undefined;
  try {
    ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const p = comfyMessage(ev.data, promptId);
        if (p && p !== "done") onProgress(p);
      } else if (ev.data instanceof ArrayBuffer) {
        const preview = comfyFrame(ev.data);
        if (preview) onProgress({ preview });
      }
    };
    ws.onerror = () => undefined;
  } catch {
    ws = undefined;
  }
  return {
    setPrompt: (id) => {
      promptId = id;
    },
    close: () => {
      try {
        ws?.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Cancels a prompt: interrupts it when it is the one running, else takes it off the queue. Errors are ignored
 * (ComfyUI may already be done or gone). Someone else's running prompt is never interrupted.
 *
 * @param baseUrl - ComfyUI's address.
 * @param promptId - The prompt.
 */
export async function cancelComfy(baseUrl: string, promptId: string): Promise<void> {
  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  const queue = await fetch(`${baseUrl}/queue`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ queue_running?: unknown[][] }>) : {}), () => ({}) as { queue_running?: unknown[][] });
  if (runningIn(queue, promptId)) await post("/interrupt", { prompt_id: promptId });
  else await post("/queue", { delete: [promptId] });
}

/**
 * Whether a prompt is the one ComfyUI runs now, from `GET /queue` (`queue_running` entries are `[number, prompt_id, …]`).
 *
 * @param queue - The answer of `GET /queue`.
 * @param promptId - The prompt.
 */
export function runningIn(queue: { queue_running?: unknown[][] }, promptId: string): boolean {
  return (queue.queue_running ?? []).some((e) => Array.isArray(e) && e[1] === promptId);
}
