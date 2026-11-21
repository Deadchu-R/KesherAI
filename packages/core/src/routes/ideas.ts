import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Ideas } from "../ideas.js";
import { modelTurnFor } from "../model-turn.js";
import { toWav, transcribeWith } from "../speech-tools.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import type { KesherServices } from "../services.js";

type S = { Params: { id: string } };

/**
 * "Open mind" (#/ideas, design IdeaSession): a recording of her thinking aloud, as long as she likes, turned into
 * sorted ideas, tasks and questions she reviews (edit, merge, split, delete); each one can go to a chat, a deep research
 * (a report document), the task inbox or a note in Knowledge.
 */
export async function ideasRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const root = join(s.paths.root, "ideas");
  /** Where "Save as a note" writes: one Markdown file per idea, read by the "Open mind notes" knowledge base. */
  const notesDir = join(s.paths.root, "ideas-notes");
  const ideas = new Ideas(root, {
    ask: async (system, user, signal, onText, strong) => {
      // Her speech stays on this computer: the deeper passes use the local chat model too (sending a transcript to a cloud
      // model waits for her choice). `strong` only asks for the more thorough prompt.
      void strong;
      const id = s.config.activeModels.chat;
      if (!id) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
      return (await modelTurnFor(s.registry, id)({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, signal ?? AbortSignal.timeout(30 * 60_000), onText ?? (() => undefined))).text;
    },
    transcribe: async (file, lang) => {
      const ffmpeg = () => ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads });
      const wav = await toWav(file, ffmpeg);
      // Detection picks from "my languages"; the recording app's language (he or en) is the hint and the fallback.
      return (await transcribeWith({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers, ffmpeg }, wav, ".wav", s.config.speech?.language ?? "auto", false, { hint: lang })).text;
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
    saveNote: async (title, markdown) => {
      await mkdir(notesDir, { recursive: true });
      // The name is made here (date, a few letters of the title, a random part): nothing from the request reaches the path.
      const slug = title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "idea";
      const name = `${new Date().toISOString().slice(0, 10)}-${slug}-${randomUUID().slice(0, 6)}.md`;
      await writeFile(join(notesDir, name), markdown);
      const old = (await s.knowledge.list()).find((k) => k.folders.length === 1 && k.folders[0] === notesDir);
      if (old) await s.knowledge.reindex(old.id).catch(() => undefined);
      else await s.knowledge.save({ name: "Open mind notes", description: "Ideas, tasks and questions she saved from her Open mind brain dumps, one note each.", folders: [notesDir], urls: [] });
      return name;
    },
    addTask: async (task) => {
      if (!s.taskInbox) throw Object.assign(new Error("The task inbox is off (Settings > Task inbox)."), { statusCode: 409 });
      return (await s.taskInbox.add(task)).id;
    },
  });

  app.get<{ Querystring: { q?: string } }>("/api/ideas", async (req) => ({ sessions: await ideas.list(String(req.query?.q ?? "").slice(0, 200)) }));
  app.get<S>("/api/ideas/:id", async (req) => ideas.get(req.params.id));
  /** "Analyse again": one level deeper, keeping what was found before (progress comes with the session). */
  app.post<S>("/api/ideas/:id/deeper", async (req) => ideas.deeper(req.params.id));
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
    const lang = /^(he|en)$/.test(String(req.headers["x-lang"] ?? "")) ? String(req.headers["x-lang"]) : undefined;
    const type = String(req.headers["x-audio-type"] ?? "");
    // WAV: the phone app's own background recording, or several resumed parts joined.
    const ext = /webm/.test(type) ? "webm" : /ogg/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : "m4a";
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
      const session = await ideas.start({ file, seconds, ...(lang ? { lang } : {}) });
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
  type I = { Params: { id: string; idea: string } };
  /** Her review: edit one, delete one, merge several, split one. */
  app.patch<I & { Body: unknown }>("/api/ideas/:id/ideas/:idea", async (req) => ideas.edit(req.params.id, req.params.idea, req.body));
  app.delete<I>("/api/ideas/:id/ideas/:idea", async (req) => ideas.removeIdea(req.params.id, req.params.idea));
  app.post<S & { Body: { ids?: unknown } }>("/api/ideas/:id/merge", async (req) => ideas.merge(req.params.id, Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 30) : []));
  app.post<I & { Body: { parts?: unknown } }>("/api/ideas/:id/ideas/:idea/split", async (req) => ideas.split(req.params.id, req.params.idea, Array.isArray(req.body?.parts) ? req.body.parts.map(String) : undefined));
  /** One idea onward: a note in Knowledge, a task in the task inbox. */
  app.post<I & { Body: { lang?: string } }>("/api/ideas/:id/ideas/:idea/note", async (req) => ideas.saveNote(req.params.id, req.params.idea, req.body?.lang !== "en"));
  app.post<I>("/api/ideas/:id/ideas/:idea/task", async (req) => ideas.toTask(req.params.id, req.params.idea));
  app.post<S & { Params: { idea: string }; Body: { lang?: string } }>("/api/ideas/:id/ideas/:idea/research", async (req) => ({ conversationId: await ideas.research(req.params.id, req.params.idea, req.body?.lang !== "en") }));
  app.post<S & { Body: { lang?: string } }>("/api/ideas/:id/research-all", async (req) => ideas.researchAll(req.params.id, req.body?.lang !== "en"));
  app.post<S>("/api/ideas/:id/research-all/stop", async (req) => ideas.stopAll(req.params.id));
}
