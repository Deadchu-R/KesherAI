import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Ideas } from "../ideas.js";
import { modelTurnFor } from "../model-turn.js";
import { toWav, transcribeWith } from "../speech-tools.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import type { KesherServices } from "../services.js";

type S = { Params: { id: string } };

/**
 * "Open mind" (#/ideas, design IdeaSession): a recording of her thinking aloud, as long as she likes, turned into
 * sorted ideas; research on one idea or on all of them in a row, as chats with the web.
 */
export async function ideasRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const root = join(s.paths.root, "ideas");
  const ideas = new Ideas(root, {
    ask: async (system, user, signal) => {
      const id = s.config.activeModels.chat;
      if (!id) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
      return (await modelTurnFor(s.registry, id)({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, signal ?? AbortSignal.timeout(30 * 60_000), () => undefined)).text;
    },
    transcribe: async (file) => {
      const ffmpeg = () => ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads });
      const wav = await toWav(file, ffmpeg);
      return (await transcribeWith({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers, ffmpeg }, wav, ".wav", s.config.speech?.language ?? "auto")).text;
    },
    projects: () => s.library.listProjects().map((p) => p.name),
    // Hits go to a model: a guest's words come marked as untrusted (conversation-search.ts forModel).
    search: (q) => s.conversationSearch.search(q, 6, { forModel: true }),
    startResearch: async (title, text) => {
      const c = await s.conversations.create({ kind: "chat", title });
      await s.conversations.send(c.id, text, { web: true });
      return c.id;
    },
    settle: async (id) => {
      const until = Date.now() + 60 * 60_000;
      await new Promise((r) => setTimeout(r, 1500));
      for (;;) {
        const opened = await s.conversations.open(id).catch(() => undefined);
        if (!opened) return "error";
        const info = opened.session.info();
        if (info.status === "error") return "error";
        if (!(info.status === "running" || opened.session.busy)) return "done";
        if (Date.now() > until) return "done";
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
  });

  app.get("/api/ideas", async () => ({ sessions: await ideas.list() }));
  app.get<S>("/api/ideas/:id", async (req) => ideas.get(req.params.id));
  app.delete<S>("/api/ideas/:id", async (req) => {
    await ideas.remove(req.params.id);
    return { ok: true };
  });
  /** Text instead of a recording (typed, or a transcript she already has). */
  app.post<{ Body: { text?: string } }>("/api/ideas/text", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "Write or paste what you thought." });
    return ideas.start({ text });
  });
  // The recording streams to disk (no length cap: it stops only when the disk is nearly full), then is sorted in the
  // background; the audio is deleted once transcribed.
  app.addContentTypeParser("application/x-kesher-audio", (_req, payload, done) => done(null, payload));
  app.post("/api/ideas/record", { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
    const seconds = Number(req.headers["x-seconds"] ?? 0);
    const ext = /webm/.test(String(req.headers["x-audio-type"] ?? "")) ? "webm" : /ogg/.test(String(req.headers["x-audio-type"] ?? "")) ? "ogg" : "m4a";
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, ".rec-"));
    const file = join(dir, `audio.${ext}`);
    let ok = false;
    try {
      const out = createWriteStream(file);
      let bytes = 0;
      let checked = 0;
      try {
        for await (const chunk of req.body as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          if (bytes - checked > 64 * 1024 ** 2) {
            checked = bytes;
            const f = await statfs(root).catch(() => undefined);
            if (f && Number(f.bavail) * Number(f.bsize) < 2 * 1024 ** 3) throw Object.assign(new Error("The disk is almost full: free some space and record again."), { statusCode: 507 });
          }
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } finally {
        await new Promise<void>((done, bad) => out.end((e?: Error | null) => (e ? bad(e) : done())));
      }
      if (bytes < 1000) return reply.code(400).send({ error: "The recording is empty." });
      ok = true;
      // The session deletes the file once it is transcribed; the folder goes with it below when that is done.
      const session = await ideas.start({ file, seconds });
      void (async () => {
        for (let i = 0; i < 24 * 60; i++) {
          const st = (await ideas.get(session.id).catch(() => undefined))?.status;
          if (st !== "transcribing") break;
          await new Promise((r) => setTimeout(r, 60_000));
        }
        await rm(dir, { recursive: true, force: true });
      })();
      return session;
    } finally {
      if (!ok) await rm(dir, { recursive: true, force: true });
    }
  });
  app.post<S & { Params: { idea: string }; Body: { lang?: string } }>("/api/ideas/:id/ideas/:idea/research", async (req) => ({ conversationId: await ideas.research(req.params.id, req.params.idea, req.body?.lang !== "en") }));
  app.post<S & { Body: { lang?: string } }>("/api/ideas/:id/research-all", async (req) => ideas.researchAll(req.params.id, req.body?.lang !== "en"));
  app.post<S>("/api/ideas/:id/research-all/stop", async (req) => ideas.stopAll(req.params.id));
}
