import type { FastifyInstance, FastifyReply } from "fastify";
import type { KesherServices } from "../services.js";
import { redactUrl } from "../browser-safety.js";
import { encodeRecording } from "../browser-record.js";
import { findFfmpeg } from "../ffmpeg.js";

/**
 * The browser pane's Debug drawer (docs/research/browser-computer-control.md, Phase 3): the console, the network
 * (headers with sign-ins hidden), the elements (the accessibility tree, inspect, pick on the page), the view (390 px
 * phone, desktop, dark), "Try my change" and recordings, for the tab in front of KesherAI's own browser. The same on
 * the computer and on the phone (it is all pictures and text over HTTP). These are the user's own looks: they use
 * their own refs (never the model's) and are not stopped by the model's Stop.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function browserDebugRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const answer = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  };
  const asset = async (data: Buffer, mimeType: string) => (await s.assets.save(data, mimeType)).id;

  /** What the drawer polls: the view, pick and recording state, the console and the network list. */
  app.get("/api/browser/debug", (_req, reply) =>
    answer(reply, () =>
      s.browser.userCdp(async (p, tabId) => ({
        tabId,
        url: redactUrl((await p.where()).url),
        emulation: p.emulation,
        picking: p.picking,
        picked: p.picked !== undefined,
        recording: p.recording,
        console: p.consoleLines({ last: 200 }),
        network: p.requests({ last: 200 }).map((r) => ({ n: r.n, at: r.at, method: r.method, url: redactUrl(r.url), type: r.type, status: r.status, size: r.size, failed: r.failed })),
      })),
    ),
  );

  /** One request in full (sign-in headers and secret fields hidden). */
  app.get<{ Querystring: { n?: string } }>("/api/browser/debug/request", (req, reply) => answer(reply, () => s.browser.userCdp(async (p) => ({ text: await p.requestDetail(Number(req.query.n)) }))));

  /** The page's elements as the accessibility tree, with the drawer's own refs. */
  app.get("/api/browser/debug/elements", (_req, reply) => answer(reply, () => s.browser.userCdp((p) => p.snapshot({ forUser: true }))));

  /** One element: by the drawer's ref, a tap on the phone's picture (fractions), or what was picked; shown on the page. */
  app.post<{ Body: { ref?: string; fx?: number; fy?: number; picked?: boolean } }>("/api/browser/debug/inspect", (req, reply) => {
    const b = req.body ?? {};
    const at = b.ref ? { ref: String(b.ref).slice(0, 20), user: true } : b.picked ? { picked: true } : { fx: Number(b.fx), fy: Number(b.fy) };
    if (!b.ref && !b.picked && !(Number.isFinite(at.fx) && Number.isFinite(at.fy))) return reply.code(400).send({ error: "Give ref, picked, or fx and fy." });
    return answer(reply, () => s.browser.userCdp((p) => p.inspect({ ...at, highlight: true })));
  });

  /** Pick mode on the computer: the next click on the page picks an element instead of clicking it. */
  app.post<{ Body: { on?: boolean } }>("/api/browser/debug/pick", (req, reply) => answer(reply, () => s.browser.userCdp(async (p) => (await p.pick(req.body?.on === true), { picking: p.picking }))));

  /** The view: a 390 px phone, a desktop or the pane's size, and dark / light / the page's colors. */
  app.post<{ Body: { device?: string; scheme?: string } }>("/api/browser/debug/emulate", (req, reply) => {
    const b = req.body ?? {};
    const device = b.device === "phone" || b.device === "desktop" || b.device === "none" ? b.device : undefined;
    const scheme = b.scheme === "dark" || b.scheme === "light" || b.scheme === "auto" ? b.scheme : undefined;
    return answer(reply, () => s.browser.userCdp((p) => p.emulate({ ...(device ? { device } : {}), ...(scheme ? { scheme } : {}) })));
  });

  /** Empties the console (to see only what comes next). */
  app.post("/api/browser/debug/clear", (_req, reply) => answer(reply, () => s.browser.userCdp(async (p) => (p.consoleLines({ clear: true }), { ok: true }))));

  /** "Try my change": reload, then errors, failed requests and pictures at 390 px and on a desktop (kept as assets). */
  app.post("/api/browser/debug/try", (_req, reply) =>
    answer(reply, () =>
      s.browser.userCdp(async (p) => {
        const r = await p.tryChange();
        return {
          url: redactUrl(r.url),
          errors: r.errors,
          failed: r.failed.map((q) => ({ n: q.n, method: q.method, url: redactUrl(q.url), status: q.status, failed: q.failed })),
          views: await Promise.all(r.views.map(async (v) => ({ device: v.device, width: v.width, height: v.height, overflow: v.overflow, asset: await asset(v.data, "image/png") }))),
        };
      }),
    ),
  );

  /** Recording: start, then stop to get a GIF (or a WebM with FFmpeg on the computer) as an asset. */
  app.post<{ Body: { action?: string; format?: string } }>("/api/browser/debug/record", (req, reply) =>
    answer(reply, () =>
      s.browser.userCdp(async (p) => {
        if (req.body?.action !== "stop") return (await p.startRecording(), { recording: true });
        const frames = await p.stopRecording();
        const file = await encodeRecording(frames, req.body?.format === "webm" ? "webm" : "gif", () => findFfmpeg(s.paths.engines));
        return { recording: false, asset: await asset(file.data, file.mimeType), mimeType: file.mimeType, frames: frames.length, ...(file.note ? { note: file.note } : {}) };
      }),
    ),
  );
}
