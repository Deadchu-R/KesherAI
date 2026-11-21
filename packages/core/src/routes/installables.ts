import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listHubFiles } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { INSTALLABLES, type InstallableInfo } from "../installables.js";
import { ensureImageModel, ensureVideoModel, imageModelPick, videoStatus } from "../sdcpp.js";
import { ensureFfmpeg, ffmpegInstalled } from "../ffmpeg.js";
import { ensureEngine } from "./engine.js";
import { PARTS, VISION_MODELS, partOn } from "@kesher/shared";
import { apply as applyParts } from "./parts.js";
import { visionServiceOf } from "../vision-service.js";

/** One installable's live side: is it here, is it installing, how big, and how to install it with the app's own installer. */
interface Live {
  ready(): Promise<boolean>;
  busy(): Promise<boolean>;
  /** Download size in GB; undefined when the installer does not say before it starts. */
  sizeGb(): Promise<number | undefined>;
  /** Whether the size is a rough figure. */
  approx?: boolean;
  /** Starts installing; resolves when it has started (or finished, for the ones that wait). */
  start(): Promise<void>;
}

/** The Wan 2.1 1.3B video model with its text encoder and VAE (the same figure the Models page shows). */
const VIDEO_GB = 7.2;
/** FFmpeg's ready-made builds are about this big. */
const FFMPEG_GB = 0.1;
/** How long a chat waits for an install before it gives up continuing (big models on a slow line). */
const WAIT_MS = 4 * 60 * 60_000;

/**
 * The live side of each installable, from the app's services.
 *
 * @param s - Services.
 * @returns By id.
 */
function liveOf(s: KesherServices): Record<string, Live> {
  const media = { sd: s.sd, downloads: s.downloads, config: s.config, modelsDir: () => s.paths.models, save: () => s.saveConfig() };
  let ffmpegBusy = false;
  return {
    "image-model": {
      ready: async () => {
        const id = s.config.activeModels.image;
        return !!id && (!id.startsWith("sdcpp/") || existsSync(join(s.paths.models, "image", id.slice(6))));
      },
      // ensureImageModel is safe to call again while its download runs (it only answers "still downloading").
      busy: async () => false,
      sizeGb: async () => {
        const pick = await imageModelPick();
        const file = (await listHubFiles(pick.repo).catch(() => [])).find((f) => f.path === pick.file);
        const extras = (await s.sd.requirements(pick.file).catch(() => ({ extras: [] as Array<{ sizeGb: number; have: boolean }> }))).extras.filter((e) => !e.have);
        return file ? file.size / 1024 ** 3 + extras.reduce((n, e) => n + e.sizeGb, 0) : undefined;
      },
      start: async () => void (await ensureImageModel(media)),
    },
    "video-model": {
      ready: async () => (await videoStatus(media)).ready,
      busy: async () => (await videoStatus(media)).downloading,
      sizeGb: async () => VIDEO_GB,
      approx: true,
      start: async () => void (await ensureVideoModel(media)),
    },
    comfyui: {
      ready: async () => s.comfy.status().installed,
      busy: async () => !!s.comfy.status().phase,
      sizeGb: async () => undefined,
      start: async () => void s.comfy.install().catch(() => undefined),
    },
    "chat-engine": {
      ready: async () => s.engine.status().installed,
      busy: async () => s.engine.status().job?.phase === "installing",
      sizeGb: async () => undefined,
      start: async () => void ensureEngine(s).catch((err: Error) => s.engine.fail(err)),
    },
    "speech-to-text": {
      ready: async () => { const st = await s.whisper.status(); return st.engine && !!st.model; },
      busy: async () => !!(await s.whisper.status()).busy,
      sizeGb: async () => (await s.whisper.status()).recommended.sizeGb,
      start: async () => void s.whisper.prepare(false).catch(() => undefined),
    },
    "text-to-speech": {
      ready: async () => s.kokoro.status().ready,
      busy: async () => s.kokoro.status().busy,
      sizeGb: async () => s.kokoro.status().sizeMb / 1024,
      start: async () => void s.kokoro.prepare().catch(() => undefined),
    },
    // The vision models (Phase 6): saved on the heavy-data drive, run in their own slot by vision-service.ts.
    ...Object.fromEntries(
      VISION_MODELS.map((m): [string, Live] => [
        m.installId,
        {
          ready: async () => !!(await visionServiceOf(s.config)?.files(m)),
          busy: async () => !!visionServiceOf(s.config)?.busy(m.id),
          sizeGb: async () => (await visionServiceOf(s.config)?.sizeGb(m)) ?? m.sizeGb + m.mmprojGb,
          start: async () => {
            const v = visionServiceOf(s.config);
            if (!v) throw new Error("Vision models run in the main KesherAI app.");
            void v.install(m).catch(() => undefined);
          },
        },
      ]),
    ),
    // The editors are parts with an official plugin: "installed" is the part being on, installing turns it on (no download).
    ...Object.fromEntries(
      PARTS.filter((p) => p.plugin).map((p): [string, Live] => [
        p.id,
        {
          ready: async () => partOn(s.config.parts, p.id) && s.config.plugins[p.plugin!]?.enabled !== false,
          busy: async () => false,
          sizeGb: async () => 0,
          start: async () => {
            const { [p.id]: _gone, ...rest } = s.config.parts;
            s.config.parts = rest;
            await s.saveConfig();
            await applyParts(s, [p.id], []);
          },
        },
      ]),
    ),
    ffmpeg: {
      ready: () => ffmpegInstalled(s.paths.engines),
      busy: async () => ffmpegBusy,
      sizeGb: async () => FFMPEG_GB,
      approx: true,
      start: async () => {
        ffmpegBusy = true;
        void ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }).catch(() => undefined).finally(() => (ffmpegBusy = false));
      },
    },
  };
}

/** What the Install window shows. */
export interface InstallView extends InstallableInfo {
  sizeGb?: number;
  approx?: boolean;
  /** The folder it is saved in, as set in Settings (the engines folder lives on the heavy-data drive when one is set). */
  where: string;
  /** Where in the app that folder is changed. */
  changeHref: string;
  ready: boolean;
  busy: boolean;
}

/**
 * The Install button's routes (installables.ts). From the phone they run on the computer, like every route.
 *
 * - GET  /api/installables/:id → {@link InstallView}
 * - POST /api/installables/:id/install `{ chatId?, continueText? }` → starts the app's own installer; when it is ready,
 *   `continueText` is sent to the chat so it goes on with the request (the user's text, at most 300 characters).
 */
export async function installableRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const live = liveOf(s);
  /** Chats waiting for an install, by installable id, with the text that continues each. */
  const waiting = new Map<string, Map<string, string>>();
  s.conversations.installReady = (id) => live[id]?.ready() ?? Promise.resolve(false);

  const view = async (info: InstallableInfo): Promise<InstallView> => {
    const l = live[info.id]!;
    const [ready, busy, sizeGb] = await Promise.all([l.ready().catch(() => false), l.busy().catch(() => false), l.sizeGb().catch(() => undefined)]);
    return {
      ...info,
      ...(sizeGb !== undefined ? { sizeGb: Math.round(sizeGb * 10) / 10 } : {}),
      ...(l.approx ? { approx: true } : {}),
      where: info.folder === "plugins" ? s.paths.plugins : info.folder === "vision" ? (visionServiceOf(s.config)?.dir() ?? s.paths.models) : info.folder === "models" ? s.paths.models : s.paths.engines,
      changeHref: info.folder === "models" ? "#/models" : info.folder === "plugins" ? "#/parts" : "#/settings/computer",
      ready,
      busy: busy && !ready,
    };
  };

  /** Waits until it is ready, then sends each waiting chat its continue text. */
  const follow = async (id: string): Promise<void> => {
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await live[id]!.ready().catch(() => false)) break;
    }
    const chats = waiting.get(id);
    waiting.delete(id);
    if (!chats || !(await live[id]!.ready().catch(() => false))) return;
    for (const [chatId, text] of chats) await s.conversations.send(chatId, text).catch(() => undefined);
  };

  app.get<{ Params: { id: string } }>("/api/installables/:id", async (req, reply) => {
    const info = INSTALLABLES.find((i) => i.id === req.params.id);
    return info ? view(info) : reply.code(404).send({ error: "Unknown item" });
  });

  app.post<{ Params: { id: string }; Body: { chatId?: unknown; continueText?: unknown } }>("/api/installables/:id/install", async (req, reply) => {
    const info = INSTALLABLES.find((i) => i.id === req.params.id);
    if (!info) return reply.code(404).send({ error: "Unknown item" });
    const chatId = typeof req.body?.chatId === "string" && s.library.summary(req.body.chatId) ? req.body.chatId : undefined;
    const text = typeof req.body?.continueText === "string" ? req.body.continueText.trim().slice(0, 300) : "";
    const l = live[info.id]!;
    if (await l.ready().catch(() => false)) {
      if (chatId && text) await s.conversations.send(chatId, text).catch(() => undefined);
      return view(info);
    }
    const first = !waiting.has(info.id);
    const chats = waiting.get(info.id) ?? new Map<string, string>();
    if (chatId && text) chats.set(chatId, text);
    waiting.set(info.id, chats);
    try {
      // Once per install: a second press (or another chat) only waits for the same one.
      if (first && !(await l.busy().catch(() => false))) await l.start();
    } catch (err) {
      waiting.delete(info.id);
      return reply.code(502).send({ error: (err as Error).message });
    }
    if (first) void follow(info.id);
    return reply.code(202).send(await view(info));
  });
}
