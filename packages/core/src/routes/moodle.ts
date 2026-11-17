import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { moodleBase, parseCourseFiles, parseCourses, parseDue, type MoodleFile } from "../moodle.js";
import type { KesherServices } from "../services.js";

/**
 * The student's Moodle in Study (moodle.ts, design MoodleStudy): its courses, what is due, and lecture files brought
 * in as lectures. Everything goes through KesherAI's browser pane with her own sign-in; read only.
 */
export async function moodleRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const m = () => s.config.moodle;
  const pane = () => {
    if (!s.browser.status().pane) throw Object.assign(new Error("Moodle comes in through KesherAI's own browser, in the desktop app on the computer."), { statusCode: 409 });
  };
  const call = <T>(op: string, args: Record<string, unknown>) => s.browser.call<T>("moodle", { base: m().base, op, ...args });
  let cache: { at: number; courses: ReturnType<typeof parseCourses>; due: ReturnType<typeof parseDue> } | undefined;

  app.get("/api/moodle", async () => ({ base: m().base ?? null, map: m().map, cached: cache ?? null, pane: s.browser.status().pane === true }));
  app.post<{ Body: { base?: string | null } }>("/api/moodle/site", async (req, reply) => {
    if (req.body?.base === null) {
      s.config.moodle = { map: {}, seen: [] };
      cache = undefined;
      await s.saveConfig();
      return { base: null };
    }
    const base = moodleBase(String(req.body?.base ?? ""));
    if (!base) return reply.code(400).send({ error: "A Moodle address like moodle.university.ac.il (https)." });
    s.config.moodle = { ...m(), base };
    cache = undefined;
    await s.saveConfig();
    return { base };
  });
  /** Opens her Moodle in KesherAI's browser so she signs in there (once, as on any site). */
  app.post("/api/moodle/signin", async () => {
    pane();
    await call("signin", {});
    return { ok: true };
  });
  /** Her courses and what is due, fresh from Moodle. */
  app.post("/api/moodle/refresh", async (req, reply) => {
    pane();
    if (!m().base) return reply.code(400).send({ error: "Add your Moodle's address first." });
    const r = await call<{ signedIn: boolean; answers?: Array<{ error?: boolean; data?: unknown; exception?: { message?: string } }> }>("call", {
      calls: [
        { methodname: "core_course_get_enrolled_courses_by_timeline_classification", args: { offset: 0, limit: 0, classification: "inprogress", sort: "fullname" } },
        { methodname: "core_calendar_get_action_events_by_timesort", args: { timesortfrom: Math.floor(Date.now() / 1000) - 86_400, limittonumber: 30 } },
      ],
    });
    if (!r.signedIn) return reply.code(401).send({ error: "Sign in to Moodle in KesherAI's browser first.", code: "moodle-signin" });
    const [a, b] = r.answers ?? [];
    if (a?.error) return reply.code(502).send({ error: a.exception?.message ?? "Moodle did not answer." });
    cache = { at: Date.now(), courses: parseCourses(a), due: b && !b.error ? parseDue(b) : [] };
    return cache;
  });
  /** Which Study course a Moodle course goes to ("new" makes one with its name; null stops it). */
  app.post<{ Body: { course?: string; to?: string | null } }>("/api/moodle/map", async (req, reply) => {
    const course = String(req.body?.course ?? "");
    if (!/^\d+$/.test(course)) return reply.code(400).send({ error: "Which course?" });
    const map = { ...m().map };
    if (req.body?.to === null) delete map[course];
    else {
      let to = String(req.body?.to ?? "");
      if (to === "new") to = (await s.study.addCourse(cache?.courses.find((c) => c.id === course)?.name ?? "Moodle")).id;
      if (!/^[\w-]{4,64}$/.test(to)) return reply.code(400).send({ error: "Which Study course?" });
      map[course] = to;
    }
    s.config.moodle = { ...m(), map };
    await s.saveConfig();
    return { map };
  });
  /** A course's files not brought in yet (its page read now). */
  const newFiles = async (course: string): Promise<MoodleFile[]> => {
    const page = await call<{ status: number; html?: string }>("page", { path: `/course/view.php?id=${course}` });
    if (page.status !== 200 || !page.html) throw Object.assign(new Error("The course page did not open (signed in?)."), { statusCode: 502 });
    return parseCourseFiles(page.html, m().base!).filter((f) => !m().seen.includes(`${course}:${f.id}`));
  };
  app.get<{ Params: { course: string } }>("/api/moodle/courses/:course/new", async (req, reply) => {
    pane();
    if (!/^\d+$/.test(req.params.course) || !m().base) return reply.code(400).send({ error: "Which course?" });
    return { files: await newFiles(req.params.course) };
  });
  /** Brings a course's new files in as lectures of its Study course (PDF, slides, Word; others are skipped). */
  app.post<{ Params: { course: string } }>("/api/moodle/courses/:course/import", async (req, reply) => {
    pane();
    const course = req.params.course;
    const to = m().map[course];
    if (!/^\d+$/.test(course) || !to) return reply.code(400).send({ error: "Choose the Study course for it first." });
    const files = (await newFiles(course)).slice(0, 25);
    const added: string[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const got = await call<{ status: number; name?: string; data?: string; html?: boolean }>("file", { url: f.url }).catch(() => ({ status: 0 }) as { status: number; name?: string; data?: string });
      const name = got.name ?? f.name;
      const ok = got.status === 200 && got.data && /^\.(pdf|pptx?|docx?|txt|md)$/i.test(extname(name));
      if (ok) {
        try {
          const doc = await s.study.extract(name, Buffer.from(got.data!, "base64"));
          if (doc.text.trim()) {
            await s.study.addLecture(to, { title: f.name || doc.title, text: doc.text });
            added.push(f.name);
          } else skipped.push(f.name);
        } catch {
          skipped.push(f.name);
        }
      } else skipped.push(f.name);
      // Seen either way, so a file that is not a lecture (a link, a video) is not asked about again.
      s.config.moodle = { ...m(), seen: [...m().seen, `${course}:${f.id}`].slice(-5000) };
    }
    await s.saveConfig();
    return { added, skipped };
  });
}
