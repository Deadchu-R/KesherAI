import { deflateSync } from "node:zlib";
import type { ApiNode } from "./comfy-flows.js";

/** What a smoke run makes: decides whether the chat model must leave the graphics card first. */
export type SmokeKind = "music" | "video" | "3d" | "image";

/** One file a smoke run produced (as ComfyUI saved it). */
export interface SmokeOutput {
  kind: "audio" | "image" | "video" | "3d" | string;
  file: string;
}

/** The answer of a smoke run. */
export interface SmokeResult {
  ok: boolean;
  seconds: number;
  outputs: SmokeOutput[];
  error?: string;
}

/** The kind of a ready-made flow, from its id (`music-…`, `sfx-…`, `video-…`, `3d-…`; the rest make pictures). */
export function smokeKind(flowId: string): SmokeKind {
  if (/^(music|sfx)-/.test(flowId)) return "music";
  if (flowId.startsWith("video-")) return "video";
  if (flowId.startsWith("3d-")) return "3d";
  return "image";
}

/** Whether the chat model must be unloaded first (video and 3D do not fit the card beside it). */
export function needsFreeCard(kind: SmokeKind): boolean {
  return kind === "video" || kind === "3d";
}

/**
 * The flow with the smallest settings that still run the whole graph: music 5 s, video 5 frames at 256 x 256, 3D with a
 * short latent and a coarse mesh, two sampler steps. A smoke run checks that the flow works, not how good it looks.
 * The input is not changed.
 *
 * @param flow - The flow in ComfyUI's API format.
 * @returns A copy with the small settings.
 */
export function smallestSettings(flow: Record<string, ApiNode>): Record<string, ApiNode> {
  const out = structuredClone(flow);
  for (const node of Object.values(out)) {
    const i = node.inputs;
    const set = (key: string, v: number) => {
      if (typeof i[key] === "number") i[key] = Math.min(i[key] as number, v);
    };
    switch (node.class_type) {
      case "KSampler":
        set("steps", 2);
        break;
      case "EmptyAceStep1.5LatentAudio":
      case "EmptyAceStepLatentAudio":
      case "EmptyLatentAudio":
        set("seconds", 5);
        break;
      case "TextEncodeAceStepAudio1.5":
        set("duration", 5);
        break;
      // Wan: the length is 4n+1 frames and the size a multiple of 32.
      case "Wan22ImageToVideoLatent":
        set("length", 5);
        set("width", 256);
        set("height", 256);
        break;
      case "EmptyLatentHunyuan3Dv2":
        set("resolution", 1024);
        break;
      case "VAEDecodeHunyuan3D":
        set("octree_resolution", 64);
        break;
      default:
    }
    set("batch_size", 1);
  }
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const b of body) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}

/**
 * A small test picture made here (no file to ship): a grey ball on a plain white background, which is what the 3D and
 * video flows expect (one object, plain background). A PNG, 8-bit grey.
 *
 * @param size - Width and height in pixels (default 256).
 */
export function testPicture(size = 256): Buffer {
  const raw = Buffer.alloc((size + 1) * size);
  const c = size / 2;
  const r = size * 0.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // Shaded like a ball: lighter near the top left, a soft edge.
      raw[y * (size + 1) + 1 + x] = d > r ? 255 : Math.round(90 + (d / r) * 60 + ((x + y) / (2 * size)) * 30);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // bit depth
  head[9] = 0; // grey
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** ComfyUI's `/history` entry, the parts used here. */
interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
  outputs?: Record<string, Record<string, unknown>>;
}

/** The files a history entry saved, with what each is. */
function outputsOf(entry: HistoryEntry): SmokeOutput[] {
  const found: SmokeOutput[] = [];
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const [key, list] of Object.entries(out)) {
      if (!Array.isArray(list)) continue;
      for (const f of list as Array<{ filename?: string; subfolder?: string; animated?: boolean }>) {
        if (!f || typeof f.filename !== "string") continue;
        const kind = key === "audio" ? "audio" : key === "images" ? (out.animated ? "video" : "image") : key;
        found.push({ kind, file: f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename });
      }
    }
  }
  return found;
}

/** What went wrong in a failed history entry, in ComfyUI's words. */
function failureOf(entry: HistoryEntry): string {
  const bad = entry.status?.messages?.find((m) => m[0] === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
  return bad ? `${bad.node_type ? `${bad.node_type}: ` : ""}${String(bad.exception_message ?? "").trim().slice(0, 400)}` : "ComfyUI reported an error.";
}

/** Options of {@link runSmoke}. */
export interface RunSmokeOptions {
  /** ComfyUI's address, e.g. `http://127.0.0.1:8188`. */
  url: string;
  /** The flow in API format (already with the small settings and the test picture's name). */
  flow: Record<string, ApiNode>;
  /** Gives up (and interrupts ComfyUI) after this long; default 10 minutes. */
  timeoutMs?: number;
  /** How often to ask ComfyUI; default 1.5 s. */
  pollMs?: number;
  /** Called at every poll (keeps ComfyUI counted as busy so it is not stopped as idle). */
  onPoll?: () => void;
}

/**
 * Queues a flow in ComfyUI (`/prompt`), waits for it (`/history/<id>`) and returns what it saved. Never throws: a
 * failure comes back as `{ ok: false, error }`.
 *
 * @param o - See {@link RunSmokeOptions}.
 */
export async function runSmoke(o: RunSmokeOptions): Promise<SmokeResult> {
  const started = Date.now();
  const done = (r: Omit<SmokeResult, "seconds">): SmokeResult => ({ ...r, seconds: Math.round((Date.now() - started) / 100) / 10 });
  const timeout = o.timeoutMs ?? 600_000;
  let id: string;
  try {
    const res = await fetch(`${o.url}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: o.flow, client_id: "kesher-smoke" }), signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as { prompt_id?: string; error?: { message?: string } | string; node_errors?: Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }> };
    if (!res.ok || !body.prompt_id) {
      const first = Object.values(body.node_errors ?? {})[0];
      const why = first?.errors?.[0] ? `${first.class_type ?? "node"}: ${first.errors[0].message}${first.errors[0].details ? ` (${first.errors[0].details})` : ""}` : typeof body.error === "string" ? body.error : (body.error?.message ?? `ComfyUI refused the flow (${res.status}).`);
      return done({ ok: false, outputs: [], error: why.slice(0, 500) });
    }
    id = body.prompt_id;
  } catch (err) {
    return done({ ok: false, outputs: [], error: `ComfyUI did not answer: ${(err as Error).message}` });
  }
  while (Date.now() - started < timeout) {
    o.onPoll?.();
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1500));
    const entry = await fetch(`${o.url}/history/${id}`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, HistoryEntry>>) : {}))
      .then((h) => (h as Record<string, HistoryEntry>)[id], () => undefined);
    if (!entry) continue;
    if (entry.status?.status_str === "error") return done({ ok: false, outputs: [], error: failureOf(entry) });
    if (entry.status?.completed || entry.status?.status_str === "success") {
      const outputs = outputsOf(entry);
      return outputs.length ? done({ ok: true, outputs }) : done({ ok: false, outputs, error: "The flow ran but saved nothing." });
    }
  }
  await fetch(`${o.url}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return done({ ok: false, outputs: [], error: `Timed out after ${Math.round(timeout / 60_000)} minutes.` });
}
