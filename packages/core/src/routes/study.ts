/**
 * Study (students): courses, lectures, summaries, flashcards with spaced repetition, quizzes graded by code, and
 * recall per study format. The phone reaches it through remote like every other page.
 */
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardsToTsv, examPlan, formatStats, weakLectures, type StudyFormat } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { cleanYoutube, ensureYtDlp, youtubeId, youtubeLecture } from "../youtube-lecture.js";
import { readMedia } from "../speech-tools.js";
import { ensureFfmpeg } from "../ffmpeg.js";
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
  /** Her study streak and this week's focus minutes. */
  app.get("/api/study/progress", async () => st.progress());
  /** "What to study now": one next step (or null without courses). */
  app.get("/api/study/next", async () => ({ next: await st.next() }));
  /** A finished focus-timer session: `{ minutes }`. */
  app.post<C & { Body: { minutes?: number } }>("/api/study/courses/:id/focus", async (req) => st.addFocus(req.params.id, Number(req.body?.minutes)));
  /** The course's tutor: `{ question, history? }` → an answer from her lectures, with the lectures it used. */
  app.post<C & { Body: { question?: string; history?: Array<{ role: "user" | "assistant"; content: string }>; mode?: string } }>("/api/study/courses/:id/ask", async (req) => st.askCourse(req.params.id, String(req.body?.question ?? ""), Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [], undefined, req.body?.mode === "study" ? "study" : req.body?.mode === "homework" ? "homework" : "ask"));
  /** Why a card she got wrong has that answer (a sentence or two, from her lecture). */
  app.post<C & { Params: { cid: string } }>("/api/study/courses/:id/cards/:cid/explain", async (req) => st.explainCard(req.params.id, req.params.cid));
  /** Cards for Anki or Quizlet (tab-separated text), and cards from their exports (`{ text }`). */
  app.get<C>("/api/study/courses/:id/anki", async (req, reply) => {
    const d = await st.get(req.params.id);
    const name = encodeURIComponent(`${d.course.name}.anki.txt`);
    return reply.header("content-type", "text/plain; charset=utf-8").header("content-disposition", `attachment; filename*=UTF-8''${name}`).send(`#separator:tab\n#html:true\n${cardsToTsv(d.cards)}\n`);
  });
  app.post<C & { Body: { text?: string } }>("/api/study/courses/:id/cards/import", { bodyLimit: 8 * 1024 * 1024 }, async (req) => st.importCards(req.params.id, String(req.body?.text ?? "")));
  /** A field tool (case brief, formula sheet, code trace…): `{ text }` for the tools that take pasted text. */
  app.post<C & { Params: { tool: string }; Body: { text?: string } }>("/api/study/courses/:id/tools/:tool", { bodyLimit: 1024 * 1024 }, async (req) => st.runTool(req.params.id, req.params.tool, String(req.body?.text ?? "")));
  /** Free pictures from Wikimedia Commons for a lecture's topic (with credit). */
  app.get<L & { Querystring: { kind?: string } }>("/api/study/courses/:id/lectures/:lid/pictures", async (req) => st.lecturePictures(req.params.id, req.params.lid, undefined, req.query.kind === "gif" || req.query.kind === "video" ? req.query.kind : "image"));
  /** Search across all courses: `?q=`. */
  // Kept lecture recordings: sent as audio, played back with ranges (so the player can jump to any minute).
  app.addContentTypeParser(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"], { parseAs: "buffer", bodyLimit: 400 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<L>("/api/study/courses/:id/lectures/:lid/recording", { bodyLimit: 400 * 1024 * 1024 }, async (req, reply) => {
    const mime = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "Send the recording as audio (WebM, Ogg, MP4 or WAV)." });
    return st.saveRecording(req.params.id, req.params.lid, req.body, mime);
  });
  app.get<L>("/api/study/courses/:id/lectures/:lid/recording", async (req, reply) => {
    const f = await st.recordingFile(req.params.id, req.params.lid);
    const size = f ? await stat(f.path).then((x) => x.size, () => -1) : -1;
    if (!f || size < 0) return reply.code(404).send({ error: "This lecture has no kept recording." });
    reply.header("accept-ranges", "bytes").type(f.mime);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (!m || (!m[1] && !m[2])) return reply.header("content-length", size).send(createReadStream(f.path));
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
    return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1).send(createReadStream(f.path, { start, end }));
  });
  app.delete<L>("/api/study/courses/:id/lectures/:lid/recording", async (req) => {
    await st.removeRecording(req.params.id, req.params.lid);
    return { ok: true };
  });
  app.get("/api/study/recordings", async () => st.recordingSettings());
  app.put<{ Body: { keep?: boolean; deleteAfter?: "never" | "30" | "90" | "semester"; asked?: boolean } }>("/api/study/recordings", async (req) => st.setRecordingSettings(req.body ?? {}));

  // The course models: which Hebrew model is on the computer, the models to choose from, and a course waiting for its own.
  app.get("/api/study/model", async () => (st.modelState ? st.modelState() : { switched: false, models: [] }));
  app.post("/api/study/model/now", async () => {
    st.switchNow?.();
    return { ok: true };
  });
  app.get<{ Querystring: { q?: string } }>("/api/study/search", async (req) => ({ hits: await st.search(String(req.query.q ?? "").slice(0, 200)) }));
  /** Grows the course's summary by topic from newly summarized lectures. */
  app.post<C>("/api/study/courses/:id/summary", async (req) => st.courseSummary(req.params.id));
  /** A syllabus: `{ text }` → what it says (exams, assignments, weekly topics) for her to confirm; then PUT keeps it. */
  app.post<C & { Body: { text?: string } }>("/api/study/courses/:id/syllabus/read", { bodyLimit: 4 * 1024 * 1024 }, async (req) => st.readSyllabus(String(req.body?.text ?? "")));
  app.put<C & { Body: { syllabus?: unknown } }>("/api/study/courses/:id/syllabus", async (req) => ({ syllabus: await st.setSyllabus(req.params.id, req.body?.syllabus ?? null) }));
  /** Past exams: `{ title, text }` in (the text from /api/study/extract); practice tests can follow their style. */
  app.post<C & { Body: { title?: string; text?: string } }>("/api/study/courses/:id/past-exams", { bodyLimit: 4 * 1024 * 1024 }, async (req) => st.addPastExam(req.params.id, req.body ?? {}));
  app.delete<C & { Params: { pid: string } }>("/api/study/courses/:id/past-exams/:pid", async (req) => { await st.removePastExam(req.params.id, req.params.pid); return { ok: true }; });
  /** Live translation of the lecture recorder's transcript: `{ text, to: he | en }`. */
  app.post<{ Body: { text?: string; to?: string } }>("/api/study/translate", async (req) => st.translate(String(req.body?.text ?? ""), req.body?.to === "he" ? "he" : "en"));
  /** "Explain this": a passage she selected in a lecture, explained (`{ text, kind: explain | simple | example }`). */
  app.post<L & { Body: { text?: string; kind?: string } }>("/api/study/courses/:id/lectures/:lid/explain", async (req) => st.explainPassage(req.params.id, req.params.lid, String(req.body?.text ?? "").slice(0, 3000), req.body?.kind === "simple" ? "simple" : req.body?.kind === "example" ? "example" : "explain"));
  /** A lecture's spoken review (audio overview), written by the chat model and kept. */
  app.post<L>("/api/study/courses/:id/lectures/:lid/audio", async (req) => st.audioOverview(req.params.id, req.params.lid));
  /** A YouTube lecture by its link: its captions (or its sound, through whisper) become a lecture with minute marks. */
  app.post<C & { Body: { url?: string } }>("/api/study/courses/:id/lectures/youtube", async (req, reply) => {
    const id = youtubeId(String(req.body?.url ?? ""));
    if (!id) return reply.code(400).send({ error: "A YouTube link (youtube.com/watch?v=… or youtu.be/…)." });
    const ytdlp = await ensureYtDlp({ dir: s.paths.engines, downloads: s.downloads });
    const got = await youtubeLecture(ytdlp, id, [s.config.speech?.language && s.config.speech.language !== "auto" ? s.config.speech.language : "he", "iw", "en"]);
    try {
      let text = got.text;
      if (!text && got.audio) {
        const r = await readMedia({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers, ffmpeg: () => ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }) }, got.audio, 0);
        text = r.transcript;
      }
      if (!text?.trim()) return reply.code(422).send({ error: "This video has no captions and no speech was found in it." });
      return await st.addLecture(req.params.id, { title: got.title, text, youtube: id });
    } finally {
      await cleanYoutube(got.tmp);
    }
  });
  app.post<L & { Body: { topic?: string; text?: string } }>("/api/study/courses/:id/lectures/:lid/teach-back", async (req) => st.teachBack(req.params.id, req.params.lid, String(req.body?.topic ?? ""), String(req.body?.text ?? "")));
  app.post<L>("/api/study/courses/:id/lectures/:lid/video", async (req) => st.videoOverview(req.params.id, req.params.lid));
  /** The course as a file to share with classmates, and a shared file opened as a new course. */
  app.get<C>("/api/study/courses/:id/export", async (req, reply) => {
    const f = await st.exportCourse(req.params.id);
    const name = encodeURIComponent(`${f.name}.kesherai-course.json`);
    return reply.header("content-disposition", `attachment; filename*=UTF-8''${name}`).send(f);
  });
  app.post<{ Body: unknown }>("/api/study/import", { bodyLimit: 80 * 1024 * 1024 }, async (req) => st.importCourse(req.body));
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
  app.post<{ Body: { action?: "install" | "start" | "test" | "stop" | "set"; enabled?: boolean; cable?: string; mic?: string } }>("/api/study/avatar/lipsync", async (req, reply) => {
    const action = req.body?.action;
    // The 7 GB install happens at the computer; on, off and the settings also from the phone.
    if (action === "install" && !isLocalRequest(req)) return reply.code(403).send({ error: "Install lip sync at the computer." });
    try {
      if (action === "install") void lip.install().catch(() => undefined);
      else if (action === "start") await lip.start();
      // The self-test: a sample recording instead of the microphone, for 20 seconds.
      else if (action === "test") {
        await lip.start(true);
        setTimeout(() => lip.stop(), 20_000).unref?.();
      }
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
      quizzes: d.quizzes.filter((z) => z.answers).map((z) => ({ id: z.id, t: z.t, score: z.score, of: z.questions.length, ...(z.kind ? { kind: z.kind } : {}) })).slice(-20),
      plan: examPlan(d, now) ?? null,
      pastExams: (d.pastExams ?? []).map(({ id, title, t, text }) => ({ id, title, t, chars: text.length })),
      syllabus: d.syllabus ?? null,
      courseSummary: d.courseSummary ?? null,
    };
  });
  app.patch<C & { Body: { name?: string; field?: string; examDate?: string; model?: string; semesterEnd?: string } }>("/api/study/courses/:id", async (req) => {
    if (typeof req.body?.examDate === "string") return st.setExam(req.params.id, req.body.examDate);
    if (typeof req.body?.model === "string") return st.setModel(req.params.id, req.body.model);
    if (typeof req.body?.semesterEnd === "string") return st.setSemesterEnd(req.params.id, req.body.semesterEnd);
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
  app.patch<L & { Body: { title?: string; date?: string; text?: string; summary?: string; notes?: string } }>("/api/study/courses/:id/lectures/:lid", async (req) => st.updateLecture(req.params.id, req.params.lid, req.body ?? {}));
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

  app.post<C & { Body: { lectureIds?: string[]; count?: number; weak?: boolean; style?: "licensing" | "past"; kind?: string; level?: string } }>("/api/study/courses/:id/quiz", async (req) => {
    const b = req.body ?? {};
    return st.makeQuiz(req.params.id, {
      ...(Array.isArray(b.lectureIds) ? { lectureIds: b.lectureIds.map(String).slice(0, 200) } : {}),
      ...(b.count ? { count: Number(b.count) } : {}),
      ...(b.weak ? { weak: true } : {}),
      ...(b.style === "licensing" || b.style === "past" ? { style: b.style } : {}),
      ...(b.kind === "open" || b.kind === "case" ? { kind: b.kind } : {}),
      ...(b.level === "easy" || b.level === "normal" || b.level === "hard" ? { level: b.level } : {}),
    });
  });
  /** Her written answers to an open or case quiz, graded one by one. */
  app.post<{ Params: { id: string; qid: string }; Body: { texts?: string[] } }>("/api/study/courses/:id/quiz/:qid/open-answers", { bodyLimit: 1024 * 1024 }, async (req) => st.answerOpenQuiz(req.params.id, req.params.qid, Array.isArray(req.body?.texts) ? req.body.texts.map((t) => String(t ?? "")).slice(0, 30) : []));
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
