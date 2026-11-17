/**
 * Study (students): courses, lectures, summaries, flashcards with spaced repetition, quizzes graded by code, and
 * recall per study format. The phone reaches it through remote like every other page.
 */
import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { whereTerm, cardsToTsv, examPlan, formatStats, GOAL_KINDS, recentMistakes, topicMastery, weakLectures, type StudyFormat, mockHistory } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { cleanYoutube, ensureYtDlp, webLectureVideo, youtubeId, youtubeLecture } from "../youtube-lecture.js";
import { readMedia, toWav, transcribeWith } from "../speech-tools.js";
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
  /** Her daily goal and reminder (design DailyGoal); off until she turns it on. */
  app.get("/api/study/goal", async () => {
    const { lastReminded: _l, ...g } = await st.goal();
    return g;
  });
  app.put<{ Body: { on?: boolean; targets?: Record<string, number>; remind?: string; phone?: boolean } }>("/api/study/goal", async (req) => {
    const b = req.body ?? {};
    const targets = b.targets && typeof b.targets === "object" ? Object.fromEntries(Object.entries(b.targets).filter(([k]) => GOAL_KINDS.includes(k as never)).map(([k, v]) => [k, Number(v) || 0])) : undefined;
    return st.setGoal({ ...(typeof b.on === "boolean" ? { on: b.on } : {}), ...(targets ? { targets } : {}), ...(typeof b.remind === "string" ? { remind: b.remind } : {}), ...(typeof b.phone === "boolean" ? { phone: b.phone } : {}) });
  });
  /** "How am I today" (design FocusComfort): a low day halves the goal, so the streak survives it. */
  app.put<{ Body: { level?: string } }>("/api/study/energy", async (req, reply) => {
    const level = req.body?.level;
    if (level !== "high" && level !== "ok" && level !== "low") return reply.code(400).send({ error: "high, ok or low." });
    await st.setEnergy(level);
    return st.progress();
  });
  /** Simple mode and the first visit (design StudyWelcome / StudySimple). */
  app.get("/api/study/prefs", async () => st.prefs());
  app.get("/api/study/grades", async () => st.grades());
  app.put("/api/study/grades", { bodyLimit: 512 * 1024 }, async (req) => st.setGrades(req.body));
  app.get("/api/study/timetable", async () => st.timetable());
  app.put("/api/study/timetable", { bodyLimit: 256 * 1024 }, async (req) => st.setTimetable(req.body));
  app.put<{ Body: { simple?: boolean; welcomed?: boolean; easyRead?: boolean; path?: boolean } }>("/api/study/prefs", async (req) => {
    const b = req.body ?? {};
    return st.setPrefs(Object.fromEntries((["simple", "welcomed", "easyRead", "path"] as const).filter((k) => typeof b[k] === "boolean").map((k) => [k, b[k]])));
  });
  /** A video she watched to the end (a video lecture or a video overview), for the goal. */
  app.post("/api/study/activity/video", async () => {
    await st.logActivity("videos");
    return { ok: true };
  });
  // The reminder: looked at every minute; a note at most once a day, only when today's goal is not reached.
  const remind = setInterval(() => {
    void st.remindIfDue((title, body, path, phone) => s.notifier.send({ title, body, path, tags: ["dart"], ...(phone ? {} : { computerOnly: true }) })).catch(() => undefined);
    // A class starting (design Timetable): record it.
    void st.remindClassIfDue((title, body, path, phone) => s.notifier.send({ title, body, path, tags: ["studio_microphone"], ...(phone ? {} : { computerOnly: true }) })).catch(() => undefined);
  }, 60_000);
  remind.unref?.();
  app.addHook("onClose", async () => clearInterval(remind));
  /** The week in one card. */
  app.get("/api/study/week", async () => st.week());
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
  app.post<L>("/api/study/courses/:id/lectures/:lid/podcast", async (req) => st.podcast(req.params.id, req.params.lid));
  // ---- Video lectures (design VideoLecture): her MP4, or a Panopto/Kaltura/Vimeo video, kept and split into chapters.
  const speechDeps = () => ({ whisper: s.whisper, speech: () => s.config.speech, providers: () => s.config.providers, ffmpeg: () => ensureFfmpeg({ dir: s.paths.engines, downloads: s.downloads }) });
  /** A video's speech as text with a [m:ss] mark per line (whisper on this computer, or the chosen cloud service). */
  const stampedTranscript = async (file: string) => {
    const d = speechDeps();
    const wav = await toWav(file, d.ffmpeg);
    return (await transcribeWith(d, wav, ".wav", s.config.speech?.language ?? "auto", true)).text;
  };
  const sendRange = (req: { headers: Record<string, unknown> }, reply: import("fastify").FastifyReply, path: string, size: number, mime: string) => {
    reply.header("accept-ranges", "bytes").type(mime);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (!m || (!m[1] && !m[2])) return reply.header("content-length", size).send(createReadStream(path));
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
    return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1).send(createReadStream(path, { start, end }));
  };
  // Her video arrives as a stream straight to disk (lectures run to gigabytes), never held in memory. No size cap
  // (Roee, 2026-11-17): it is written next to where it is kept (the same disk, so keeping it is a rename, never a
  // second copy), and stops only when the disk would be left with under 2 GB free.
  app.addContentTypeParser("application/x-kesher-video", (_req, payload, done) => done(null, payload));
  app.post<C>("/api/study/courses/:id/lectures/video-upload", { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "video.mp4")).replace(/[\\/:*?"<>|]+/g, "").slice(0, 120) || "video.mp4";
    const mime = String(req.headers["x-video-type"] ?? "video/mp4").slice(0, 40);
    await st.get(req.params.id);
    const home = dirname(st.videoPath(req.params.id, "x"));
    await mkdir(home, { recursive: true });
    // An upload cut off by a crash leaves its folder: clear any older than a day.
    for (const n of await readdir(home).catch(() => [] as string[])) {
      if (!n.startsWith(".up-")) continue;
      const at = (await stat(join(home, n)).catch(() => undefined))?.mtimeMs ?? Date.now();
      if (Date.now() - at > 86_400_000) await rm(join(home, n), { recursive: true, force: true });
    }
    const dir = await mkdtemp(join(home, ".up-"));
    const file = join(dir, "video");
    const KEEP_FREE = 2 * 1024 ** 3;
    const freeBytes = async () => {
      const f = await statfs(home).catch(() => undefined);
      return f ? Number(f.bavail) * Number(f.bsize) : Infinity;
    };
    try {
      let bytes = 0;
      let checked = 0;
      const out = createWriteStream(file);
      try {
        for await (const chunk of req.body as AsyncIterable<Buffer>) {
          bytes += chunk.length;
          // Every 256 MB: is there still room?
          if (bytes - checked > 256 * 1024 ** 2) {
            checked = bytes;
            if ((await freeBytes()) < KEEP_FREE) throw Object.assign(new Error("The disk is almost full: free some space and add the video again."), { statusCode: 507 });
          }
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } finally {
        await new Promise<void>((ok, bad) => out.end((e?: Error | null) => (e ? bad(e) : ok())));
      }
      const text = await stampedTranscript(file);
      if (!text.trim()) return reply.code(422).send({ error: "No speech was found in this video." });
      const l = await st.addLecture(req.params.id, { title: name.replace(/\.[^.]+$/, ""), text });
      return await st.keepVideo(req.params.id, l.id, file, mime);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  /** A lecture video from Panopto, Kaltura, Vimeo, Zoom… with her sign-in in KesherAI's browser (read through yt-dlp). */
  app.post<C & { Body: { url?: string } }>("/api/study/courses/:id/lectures/web-video", async (req, reply) => {
    const url = String(req.body?.url ?? "").trim();
    if (!/^https:\/\/[\w.-]+(:\d+)?\/\S*$/.test(url)) return reply.code(400).send({ error: "A video link (https)." });
    if (youtubeId(url)) return reply.code(400).send({ error: "That is a YouTube link: use \"Lecture from YouTube\"." });
    const ytdlp = await ensureYtDlp({ dir: s.paths.engines, downloads: s.downloads });
    const cdir = await mkdtemp(join(tmpdir(), "kesher-ck-"));
    const cookies = join(cdir, "cookies.txt");
    let got: Awaited<ReturnType<typeof webLectureVideo>> | undefined;
    try {
      if (s.browser.status().pane) await writeFile(cookies, await s.browser.call<string>("site-cookies", { url }), { mode: 0o600 });
      got = await webLectureVideo(ytdlp, url, existsSync(cookies) ? cookies : undefined);
      if (!got.video) return reply.code(422).send({ error: "No video was found at that link (are you signed in to it in KesherAI's browser?)." });
      const text = got.text ?? (await stampedTranscript(got.video));
      if (!text.trim()) return reply.code(422).send({ error: "No captions or speech were found in this video." });
      const l = await st.addLecture(req.params.id, { title: got.title, text });
      return await st.keepVideo(req.params.id, l.id, got.video, "video/mp4", new URL(url).hostname);
    } finally {
      await rm(cdir, { recursive: true, force: true });
      if (got) await cleanYoutube(got.tmp);
    }
  });
  app.get<L>("/api/study/courses/:id/lectures/:lid/video-file", async (req, reply) => {
    const path = st.videoPath(req.params.id, req.params.lid);
    const size = await stat(path).then((x) => x.size, () => -1);
    if (size < 0) return reply.code(404).send({ error: "This lecture has no kept video." });
    const l = (await st.get(req.params.id)).lectures.find((x) => x.id === req.params.lid);
    return sendRange(req, reply, path, size, l?.videoFile?.mime ?? "video/mp4");
  });
  app.post<L>("/api/study/courses/:id/lectures/:lid/chapters", async (req) => st.makeChapters(req.params.id, req.params.lid));
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
      mocks: mockHistory(d.quizzes).map(({ t, grade }) => ({ t, grade })),
    };
  });
  app.patch<C & { Body: { name?: string; field?: string; examDate?: string; model?: string; semesterEnd?: string; groups?: unknown } }>("/api/study/courses/:id", async (req) => {
    if (Array.isArray(req.body?.groups)) return st.setGroups(req.params.id, req.body.groups);
    if (typeof req.body?.examDate === "string") return st.setExam(req.params.id, req.body.examDate);
    if (typeof req.body?.model === "string") return st.setModel(req.params.id, req.body.model);
    if (typeof req.body?.semesterEnd === "string") return st.setSemesterEnd(req.params.id, req.body.semesterEnd);
    return typeof req.body?.field === "string" ? st.setField(req.params.id, req.body.field) : st.renameCourse(req.params.id, String(req.body?.name ?? ""));
  });
  app.delete<C>("/api/study/courses/:id", async (req) => {
    await st.removeCourse(req.params.id);
    return { ok: true };
  });

  /** A web page or her selection from it, from KesherAI's browser or the extension (design SaveToCourse). */
  app.post<C & { Body: { title?: string; url?: string; text?: string; lectureId?: string } }>("/api/study/courses/:id/clip", { bodyLimit: 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    return st.clipToCourse(req.params.id, { title: String(b.title ?? ""), url: String(b.url ?? ""), text: String(b.text ?? ""), ...(typeof b.lectureId === "string" ? { lectureId: b.lectureId } : {}) });
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
  app.post<L & { Body: { format?: StudyFormat; count?: number; cloze?: boolean; highlights?: boolean } }>("/api/study/courses/:id/lectures/:lid/cards", async (req) => ({ cards: await st.makeCards(req.params.id, req.params.lid, { ...(req.body ?? {}), cloze: req.body?.cloze === true, highlights: req.body?.highlights === true }) }));
  /** Image occlusion cards: a picture and its boxes (design ImageOcclusion). */
  app.post<C & { Body: { image?: string; mime?: string; boxes?: unknown; lectureId?: string; title?: string } }>("/api/study/courses/:id/occlusion", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    return { cards: await st.addOcclusion(req.params.id, { image: String(b.image ?? ""), mime: String(b.mime ?? ""), boxes: b.boxes, ...(typeof b.lectureId === "string" ? { lectureId: b.lectureId } : {}), ...(typeof b.title === "string" ? { title: b.title } : {}) }) };
  });
  app.get<C & { Params: { name: string } }>("/api/study/courses/:id/images/:name", async (req, reply) => {
    const img = await st.image(req.params.id, req.params.name);
    return reply.type(img.mime).header("cache-control", "private, max-age=86400").send(img.data);
  });
  /** A question during a recording, from the transcript so far (design LiveAsk). */
  app.post<C & { Body: { question?: string; transcript?: string } }>("/api/study/courses/:id/ask-live", { bodyLimit: 1024 * 1024 }, async (req) => ({ answer: await st.askLive(req.params.id, String(req.body?.question ?? ""), String(req.body?.transcript ?? "")) }));
  /** The lecture's slides (a .pptx or .pdf, base64), lined up with the recording (design SlidesSync). */
  app.post<L & { Body: { name?: string; data?: string } }>("/api/study/courses/:id/lectures/:lid/slides", { bodyLimit: 85 * 1024 * 1024 }, async (req) => ({ slides: await st.addSlides(req.params.id, req.params.lid, String(req.body?.name ?? ""), Buffer.from(String(req.body?.data ?? ""), "base64")) }));
  app.delete<L>("/api/study/courses/:id/lectures/:lid/slides", async (req) => {
    await st.removeSlides(req.params.id, req.params.lid);
    return { ok: true };
  });
  /** Where else a term appears in the course's lectures (design WhereTerm). */
  app.get<C & { Querystring: { term?: string; en?: string } }>("/api/study/courses/:id/where", async (req) => ({ places: whereTerm((await st.get(req.params.id)).lectures, String(req.query.term ?? "").slice(0, 100), typeof req.query.en === "string" ? req.query.en.slice(0, 100) : undefined).slice(0, 30) }));
  /** Her memory palace (design MemoryPalace): the kept one, and building a new one. */
  app.get<C>("/api/study/courses/:id/palace", async (req) => ({ palace: (await st.get(req.params.id)).palace ?? null }));
  app.post<C & { Body: { place?: string; spots?: unknown; terms?: unknown } }>("/api/study/courses/:id/palace", { bodyLimit: 64 * 1024 }, async (req) => ({ palace: await st.buildPalace(req.params.id, String(req.body?.place ?? ""), Array.isArray(req.body?.spots) ? req.body.spots.map(String) : [], Array.isArray(req.body?.terms) ? (req.body.terms as Array<{ term: string; explain: string }>) : []) }));
  /** Her sources library (design Papers): the list, find papers (OpenAlex), save, remove, "what the studies say". */
  app.get<C>("/api/study/courses/:id/sources", async (req) => ({ sources: await st.sources(req.params.id) }));
  app.get<C & { Querystring: { q?: string } }>("/api/study/courses/:id/papers", async (req) => ({ papers: await st.findPapers(String(req.query.q ?? "")) }));
  app.post<C & { Body: { source?: unknown } }>("/api/study/courses/:id/sources", { bodyLimit: 64 * 1024 }, async (req) => ({ sources: await st.addSource(req.params.id, req.body?.source) }));
  app.delete<C & { Params: { sid: string } }>("/api/study/courses/:id/sources/:sid", async (req) => ({ sources: await st.removeSource(req.params.id, req.params.sid) }));
  app.post<C & { Body: { question?: string; papers?: unknown } }>("/api/study/courses/:id/papers/say", { bodyLimit: 256 * 1024 }, async (req) => ({ text: await st.papersSay(req.params.id, String(req.body?.question ?? ""), Array.isArray(req.body?.papers) ? (req.body.papers as never) : []) }));
  /** Her notes across the course (design TimeNotes): time notes on recordings and videos, and noted highlights. */
  app.get<C>("/api/study/courses/:id/notes", async (req) => st.notes(req.params.id));
  /** Her highlights in a lecture (design ReadHighlights): the whole list. */
  app.put<L & { Body: { highlights?: unknown } }>("/api/study/courses/:id/lectures/:lid/highlights", { bodyLimit: 2 * 1024 * 1024 }, async (req) => ({ highlights: await st.setHighlights(req.params.id, req.params.lid, req.body?.highlights) }));

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
  /** A 5-minute lesson (RESEARCH_LOG students part 25 #4): up to 5 cards (due first, else any) and 2 questions from her past quizzes. */
  app.get<C>("/api/study/courses/:id/quick", async (req) => {
    const d = await st.get(req.params.id);
    const due = await st.due(req.params.id, 5);
    const shuffle = <T,>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((x, y) => x[0] - y[0]).map(([, x]) => x);
    const cards = due.length >= 3 ? due : [...due, ...shuffle(d.cards.filter((c) => !due.some((x) => x.id === c.id))).slice(0, 5 - due.length)];
    const pool = d.quizzes.filter((z) => !z.kind).flatMap((z) => z.questions.filter((q) => q.answer >= 0 && q.options.length > 1).map((q) => ({ ...q, t: z.t })));
    return { cards, questions: shuffle(pool).slice(0, 2) };
  });
  /** The writing coach (design WritingCoach). */
  app.post<C & { Body: { stage?: string; text?: string; assignment?: string } }>("/api/study/courses/:id/writing", { bodyLimit: 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    const stage = b.stage === "assignment" || b.stage === "outline" || b.stage === "revision" ? b.stage : "draft";
    return st.writingFeedback(req.params.id, { stage, text: String(b.text ?? "").slice(0, 60_000), assignment: String(b.assignment ?? "").slice(0, 8000) });
  });
  /** "My mistakes" (design MyMistakes): cards she forgot and quiz questions she got wrong lately. */
  app.get<C>("/api/study/courses/:id/mistakes", async (req) => recentMistakes(await st.get(req.params.id)));
  app.post<{ Params: { id: string; cid: string }; Body: { rating?: number; sure?: unknown } }>("/api/study/courses/:id/cards/:cid/review", async (req) => st.review(req.params.id, req.params.cid, Number(req.body?.rating), typeof req.body?.sure === "boolean" ? req.body.sure : undefined));

  app.post<C & { Body: { lectureIds?: string[]; count?: number; weak?: boolean; style?: "licensing" | "past"; kind?: string; level?: string; mock?: { group?: unknown; minutes?: unknown; extra?: unknown } } }>("/api/study/courses/:id/quiz", async (req) => {
    const b = req.body ?? {};
    // A part of a mock exam (students part 27 #1): its group id and time, checked.
    const m = b.mock;
    const mock = m && typeof m.group === "string" && /^[\w-]{4,40}$/.test(m.group) ? { group: m.group, minutes: Math.max(5, Math.min(300, Math.round(Number(m.minutes) || 30))), ...(m.extra === true ? { extra: true } : {}) } : undefined;
    return st.makeQuiz(req.params.id, {
      ...(Array.isArray(b.lectureIds) ? { lectureIds: b.lectureIds.map(String).slice(0, 200) } : {}),
      ...(b.count ? { count: Number(b.count) } : {}),
      ...(b.weak ? { weak: true } : {}),
      ...(b.style === "licensing" || b.style === "past" ? { style: b.style } : {}),
      ...(b.kind === "open" || b.kind === "case" ? { kind: b.kind } : {}),
      ...(mock ? { mock } : {}),
      ...(b.level === "easy" || b.level === "normal" || b.level === "hard" ? { level: b.level } : b.level === "auto" ? { level: await autoLevel(req.params.id, Array.isArray(b.lectureIds) ? b.lectureIds.map(String) : []) } : {}),
    });
  });
  /**
   * "Adapted to me" (students part 25 #7, like Quizlet Learn): the level from her mastery of those lectures (or the
   * course): 85+ hard, under 55 easy, else medium; medium without enough answers.
   */
  async function autoLevel(id: string, lectureIds: string[]): Promise<"easy" | "normal" | "hard"> {
    const d = await st.get(id);
    const m = topicMastery(d.cards, d.reviews, d.quizzes).filter((x) => !lectureIds.length || lectureIds.includes(x.lectureId));
    if (!m.length) return "normal";
    const avg = m.reduce((a, x) => a + x.mastery, 0) / m.length;
    return avg >= 85 ? "hard" : avg < 55 ? "easy" : "normal";
  }
  /** Her written answers to an open or case quiz, graded one by one. */
  app.post<{ Params: { id: string; qid: string }; Body: { texts?: string[] } }>("/api/study/courses/:id/quiz/:qid/open-answers", { bodyLimit: 1024 * 1024 }, async (req) => st.answerOpenQuiz(req.params.id, req.params.qid, Array.isArray(req.body?.texts) ? req.body.texts.map((t) => String(t ?? "")).slice(0, 30) : []));
  app.post<{ Params: { id: string; qid: string } }>("/api/study/courses/:id/quiz/:qid/advice", async (req) => ({ text: await st.quizAdvice(req.params.id, req.params.qid) }));
  app.post<{ Params: { id: string; qid: string }; Body: { answers?: number[] } }>("/api/study/courses/:id/quiz/:qid/answers", async (req) => st.answerQuiz(req.params.id, req.params.qid, Array.isArray(req.body?.answers) ? req.body.answers : []));

  app.get<C>("/api/study/courses/:id/progress", async (req) => {
    const d = await st.get(req.params.id);
    const kinds = [...new Set(d.reviews.map((r) => r.kind).filter((k): k is string => !!k))];
    return {
      formats: formatStats(d.reviews),
      byKind: kinds.map((kind) => ({ kind, formats: formatStats(d.reviews.filter((r) => r.kind === kind)) })),
      weak: weakLectures(d.quizzes).map((w) => ({ ...w, title: d.lectures.find((l) => l.id === w.lectureId)?.title ?? "" })),
      mastery: topicMastery(d.cards, d.reviews, d.quizzes)
        .map((m) => ({ ...m, title: d.lectures.find((l) => l.id === m.lectureId)?.title ?? "" }))
        .filter((m) => m.title),
      reviews: d.reviews.length,
      // Lectures with an answered quiz question (the path's ❓ step, design CoursePath).
      quizzed: [...new Set(d.quizzes.filter((z) => z.answers || z.marks).flatMap((z) => z.questions.map((q) => q.lectureId).filter((x): x is string => !!x)))],
    };
  });
}
