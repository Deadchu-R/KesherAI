/**
 * Study (students): courses, lectures, summaries, flashcards with spaced repetition, quizzes graded by code, and
 * recall per study format. The phone reaches it through remote like every other page.
 */
import type { FastifyInstance } from "fastify";
import { formatStats, weakLectures, type StudyFormat } from "@kesher/shared";
import type { KesherServices } from "../services.js";

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
      quizzes: d.quizzes.filter((z) => z.answers).map((z) => ({ id: z.id, t: z.t, score: z.score, of: z.questions.length })).slice(-20),
    };
  });
  app.patch<C & { Body: { name?: string } }>("/api/study/courses/:id", async (req) => st.renameCourse(req.params.id, String(req.body?.name ?? "")));
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

  app.get<C & { Querystring: { lecture?: string } }>("/api/study/courses/:id/cards", async (req) => ({ cards: (await st.get(req.params.id)).cards.filter((c) => !req.query.lecture || c.lectureId === req.query.lecture) }));
  app.post<C & { Body: { front: string; back: string; format?: StudyFormat; kind?: string; lectureId?: string } }>("/api/study/courses/:id/cards", async (req) => st.addCard(req.params.id, req.body));
  app.delete<{ Params: { id: string; cid: string } }>("/api/study/courses/:id/cards/:cid", async (req) => {
    await st.removeCard(req.params.id, req.params.cid);
    return { ok: true };
  });
  app.get<C>("/api/study/courses/:id/review", async (req) => ({ cards: await st.due(req.params.id) }));
  app.post<{ Params: { id: string; cid: string }; Body: { rating?: number } }>("/api/study/courses/:id/cards/:cid/review", async (req) => st.review(req.params.id, req.params.cid, Number(req.body?.rating)));

  app.post<C & { Body: { lectureIds?: string[]; count?: number; weak?: boolean } }>("/api/study/courses/:id/quiz", async (req) => st.makeQuiz(req.params.id, req.body ?? {}));
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
