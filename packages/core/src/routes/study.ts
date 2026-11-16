/**
 * Study (students): courses, lectures, summaries, flashcards with spaced repetition, quizzes graded by code, and
 * recall per study format. The phone reaches it through remote like every other page.
 */
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { examPlan, formatStats, weakLectures, type StudyFormat } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import WebSocket from "ws";

/**
 * Routes for study.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function studyRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const st = s.study;
  type C = { Params: { id: string } };
  type L = { Params: { id: string; lid: string } };

  app.get("/api/study", async () => ({ courses: await st.list() }));
  /** The course's tutor: `{ question, history? }` → an answer from her lectures, with the lectures it used. */
  app.post<C & { Body: { question?: string; history?: Array<{ role: "user" | "assistant"; content: string }> } }>("/api/study/courses/:id/ask", async (req) => st.askCourse(req.params.id, String(req.body?.question ?? ""), Array.isArray(req.body?.history) ? req.body.history.slice(-6) : []));
  /** The text of a file for a new lecture (`{ name, data }`, data in base64): slides, PDF, Word, text or a photo. */
  app.post<{ Body: { name?: string; data?: string } }>("/api/study/extract", { bodyLimit: 70 * 1024 * 1024 }, async (req) => st.extract(String(req.body?.name ?? "file"), Buffer.from(String(req.body?.data ?? ""), "base64")));
  /** Two-way sync with the phone's own Study tab: `{ courses, removedCourses }` in, every course here out. */
  app.post<{ Body: { courses?: unknown[]; removedCourses?: unknown[] } }>("/api/study/sync", { bodyLimit: 80 * 1024 * 1024 }, async (req) => st.sync(req.body?.courses ?? [], req.body?.removedCourses ?? []));

  // The avatar camera: the student's own recorded "listening" video, looped as a camera (OBS or softcam).
  const avatarDir = join(s.paths.root, "study", "avatar");
  const clip = join(avatarDir, "clip.webm");
  const meta = join(avatarDir, "meta.json");
  const readMeta = async () => JSON.parse(await readFile(meta, "utf8").catch(() => "{}")) as { accepted?: number; size?: number; at?: number };
  app.get("/api/study/avatar", async () => {
    const m = await readMeta();
    const st2 = await stat(clip).catch(() => undefined);
    return { accepted: !!m.accepted, clip: st2 ? { size: st2.size, at: m.at ?? st2.mtimeMs } : null };
  });
  // The warning was read and accepted (shown before first use).
  app.post("/api/study/avatar/accept", async () => {
    await mkdir(avatarDir, { recursive: true });
    await writeFile(meta, JSON.stringify({ ...(await readMeta()), accepted: Date.now() }));
    return { ok: true };
  });
  app.addContentTypeParser(["video/webm", "video/mp4"], { parseAs: "buffer", bodyLimit: 400 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.put("/api/study/avatar/clip", { bodyLimit: 400 * 1024 * 1024 }, async (req, reply) => {
    if (!(await readMeta()).accepted) return reply.code(409).send({ error: "Read and accept the warning first." });
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 10_000) return reply.code(400).send({ error: "Send the recorded video as video/webm." });
    await mkdir(avatarDir, { recursive: true });
    await writeFile(`${clip}.tmp`, buf);
    await rename(`${clip}.tmp`, clip);
    await writeFile(meta, JSON.stringify({ ...(await readMeta()), size: buf.length, at: Date.now() }));
    return { ok: true, size: buf.length };
  });
  app.get("/api/study/avatar/clip", async (req, reply) => {
    const st2 = await stat(clip).catch(() => undefined);
    if (!st2) return reply.code(404).send({ error: "No avatar video yet." });
    // Ranges, so the video player can seek and loop.
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    reply.header("accept-ranges", "bytes").header("cache-control", "no-store").type("video/webm");
    if (!m) return reply.header("content-length", st2.size).send(createReadStream(clip));
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), st2.size - 1) : st2.size - 1;
    if (start > end || start >= st2.size) return reply.code(416).header("content-range", `bytes */${st2.size}`).send();
    return reply.code(206).header("content-range", `bytes ${start}-${end}/${st2.size}`).header("content-length", end - start + 1).send(createReadStream(clip, { start, end }));
  });
  // The camera device (Windows desktop app): add it to Windows once, then start or stop it. Only on this computer.
  app.get("/api/study/avatar/camera", async () => (s.virtualCamera ? s.virtualCamera.status() : { available: false, installed: false, running: false }));
  // What the camera shows: the avatar loop, or the real camera (switched from the computer or from the phone, the
  // remote control). The feed page asks every second.
  let mode: "avatar" | "live" = "avatar";
  app.get("/api/study/avatar/mode", async () => ({ mode }));
  app.post<{ Body: { mode?: string } }>("/api/study/avatar/mode", async (req) => {
    mode = req.body?.mode === "live" ? "live" : "avatar";
    return { mode };
  });
  app.post<{ Body: { action?: "install" | "start" | "stop" } }>("/api/study/avatar/camera", async (req, reply) => {
    // Adding the camera to Windows happens at the computer (Windows asks there); on and off also from the phone.
    if (req.body?.action === "install" && !isLocalRequest(req)) return reply.code(403).send({ error: "Add the camera to Windows at the computer." });
    const cam = s.virtualCamera;
    if (!cam) return reply.code(409).send({ error: "The avatar camera without OBS is in the Windows app." });
    try {
      if (req.body?.action === "install") await cam.install();
      else if (req.body?.action === "start") {
        await cam.start();
        // With lip sync turned on, it starts with the camera (and stops with it).
        const ls = await lip.status();
        if (ls.enabled && ls.installed) void lip.start().catch(() => undefined);
      } else {
        cam.stop();
        lip.stop();
      }
      return await cam.status();
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  // Lip sync (optional, strong NVIDIA cards): MuseTalk moves the clip's lips while she talks.
  const lip = s.lipSync;
  app.get("/api/study/avatar/lipsync", async () => lip.status());
  app.get("/api/study/avatar/lipsync/mics", async () => ({ mics: await lip.mics() }));
  app.post<{ Body: { action?: "install" | "start" | "stop" | "set"; enabled?: boolean; cable?: string; mic?: string } }>("/api/study/avatar/lipsync", async (req, reply) => {
    const action = req.body?.action;
    // The 7 GB install happens at the computer; on, off and the settings also from the phone.
    if (action === "install" && !isLocalRequest(req)) return reply.code(403).send({ error: "Install lip sync at the computer." });
    try {
      if (action === "install") void lip.install().catch(() => undefined);
      else if (action === "start") await lip.start();
      else if (action === "stop") lip.stop();
      else if (action === "set") await lip.set({ ...(typeof req.body?.enabled === "boolean" ? { enabled: req.body.enabled } : {}), ...(typeof req.body?.cable === "string" ? { cable: req.body.cable } : {}), ...(typeof req.body?.mic === "string" ? { mic: req.body.mic } : {}) });
      return await lip.status();
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  // The lip-synced frames, relayed from the local MuseTalk server (the page may only connect to KesherAI itself).
  app.get("/api/study/avatar/lipsync/stream", { websocket: true }, (client) => {
    const url = lip.upstream();
    if (!url) {
      client.close(1013, "not running");
      return;
    }
    const up = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
    up.on("message", (data, binary) => client.readyState === client.OPEN && client.send(data, { binary }));
    const end = () => {
      up.close();
      client.close();
    };
    up.on("close", end);
    up.on("error", end);
    client.on("close", end);
  });
  app.delete("/api/study/avatar/clip", async () => {
    await rm(clip, { force: true });
    return { ok: true };
  });
  app.post<{ Body: { name?: string } }>("/api/study/courses", async (req) => st.addCourse(String(req.body?.name ?? "")));
  app.get<C>("/api/study/courses/:id", async (req) => {
    const d = await st.get(req.params.id);
    const now = Date.now();
    return {
      course: d.course,
      // The list without the full texts (they can be long); a lecture is opened on its own.
      lectures: d.lectures.map(({ text, summary, ...l }) => ({ ...l, chars: text.length, summarized: !!summary, cards: d.cards.filter((c) => c.lectureId === l.id).length })),
      cards: d.cards.length,
      due: d.cards.filter((c) => Date.parse(c.due) <= now).length,
      drugs: d.drugs ?? [],
      quizzes: d.quizzes.filter((z) => z.answers).map((z) => ({ id: z.id, t: z.t, score: z.score, of: z.questions.length })).slice(-20),
      plan: examPlan(d, now) ?? null,
    };
  });
  app.patch<C & { Body: { name?: string; field?: string; examDate?: string } }>("/api/study/courses/:id", async (req) => {
    if (typeof req.body?.examDate === "string") return st.setExam(req.params.id, req.body.examDate);
    return typeof req.body?.field === "string" ? st.setField(req.params.id, req.body.field) : st.renameCourse(req.params.id, String(req.body?.name ?? ""));
  });
  app.delete<C>("/api/study/courses/:id", async (req) => {
    await st.removeCourse(req.params.id);
    return { ok: true };
  });

  app.post<C & { Body: { title?: string; text?: string; date?: string } }>("/api/study/courses/:id/lectures", async (req) => st.addLecture(req.params.id, { title: req.body?.title, text: String(req.body?.text ?? ""), date: req.body?.date }));
  app.get<L>("/api/study/courses/:id/lectures/:lid", async (req, reply) => {
    const l = (await st.get(req.params.id)).lectures.find((x) => x.id === req.params.lid);
    return l ?? reply.code(404).send({ error: "No such lecture." });
  });
  app.patch<L & { Body: { title?: string; date?: string; text?: string; summary?: string } }>("/api/study/courses/:id/lectures/:lid", async (req) => st.updateLecture(req.params.id, req.params.lid, req.body ?? {}));
  app.delete<L>("/api/study/courses/:id/lectures/:lid", async (req) => {
    await st.removeLecture(req.params.id, req.params.lid);
    return { ok: true };
  });
  app.post<L>("/api/study/courses/:id/lectures/:lid/summarize", async (req) => st.summarize(req.params.id, req.params.lid));
  app.post<L & { Body: { format?: StudyFormat; count?: number } }>("/api/study/courses/:id/lectures/:lid/cards", async (req) => ({ cards: await st.makeCards(req.params.id, req.params.lid, req.body ?? {}) }));

  app.post<L>("/api/study/courses/:id/lectures/:lid/drugs", async (req) => ({ drugs: await st.makeDrugs(req.params.id, req.params.lid) }));
  app.delete<{ Params: { id: string; did: string } }>("/api/study/courses/:id/drugs/:did", async (req) => {
    await st.removeDrug(req.params.id, req.params.did);
    return { ok: true };
  });
  app.get<C & { Querystring: { lecture?: string } }>("/api/study/courses/:id/cards", async (req) => ({ cards: (await st.get(req.params.id)).cards.filter((c) => !req.query.lecture || c.lectureId === req.query.lecture) }));
  app.post<C & { Body: { front: string; back: string; format?: StudyFormat; kind?: string; lectureId?: string } }>("/api/study/courses/:id/cards", async (req) => st.addCard(req.params.id, req.body));
  app.delete<{ Params: { id: string; cid: string } }>("/api/study/courses/:id/cards/:cid", async (req) => {
    await st.removeCard(req.params.id, req.params.cid);
    return { ok: true };
  });
  app.get<C>("/api/study/courses/:id/review", async (req) => ({ cards: await st.due(req.params.id) }));
  app.post<{ Params: { id: string; cid: string }; Body: { rating?: number } }>("/api/study/courses/:id/cards/:cid/review", async (req) => st.review(req.params.id, req.params.cid, Number(req.body?.rating)));

  app.post<C & { Body: { lectureIds?: string[]; count?: number; weak?: boolean; style?: "licensing" } }>("/api/study/courses/:id/quiz", async (req) => st.makeQuiz(req.params.id, req.body ?? {}));
  app.post<{ Params: { id: string; qid: string }; Body: { answers?: number[] } }>("/api/study/courses/:id/quiz/:qid/answers", async (req) => st.answerQuiz(req.params.id, req.params.qid, Array.isArray(req.body?.answers) ? req.body.answers : []));

  app.get<C>("/api/study/courses/:id/progress", async (req) => {
    const d = await st.get(req.params.id);
    const kinds = [...new Set(d.reviews.map((r) => r.kind).filter((k): k is string => !!k))];
    return {
      formats: formatStats(d.reviews),
      byKind: kinds.map((kind) => ({ kind, formats: formatStats(d.reviews.filter((r) => r.kind === kind)) })),
      weak: weakLectures(d.quizzes).map((w) => ({ ...w, title: d.lectures.find((l) => l.id === w.lectureId)?.title ?? "" })),
      reviews: d.reviews.length,
    };
  });
}
