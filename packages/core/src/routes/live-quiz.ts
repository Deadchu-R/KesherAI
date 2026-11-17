import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { Study } from "../study.js";
import { advance, answer, closeRoom, createRoom, getRoom, hostView, join, livePage, playerView } from "../live-quiz.js";

/**
 * The live quiz (design LiveQuiz): the host's routes under /api (her app key), and the friends' page and its calls at
 * /q/<token> (outside /api: the token is the key, as share links).
 *
 * @param app - Fastify instance.
 * @param st - Study (the course's questions).
 */
export async function liveQuizRoutes(app: FastifyInstance, st: Study): Promise<void> {
  app.post<{ Params: { id: string }; Body: { count?: number; seconds?: number; lectureIds?: string[] } }>("/api/study/courses/:id/live", async (req) => {
    const b = req.body ?? {};
    const course = (await st.get(req.params.id)).course;
    const quiz = await st.makeQuiz(req.params.id, { count: Math.max(3, Math.min(20, Number(b.count) || 10)), level: "normal", ...(Array.isArray(b.lectureIds) ? { lectureIds: b.lectureIds.map(String).slice(0, 50) } : {}) });
    const r = createRoom(course.name, quiz.questions, Number(b.seconds) || 20);
    return { token: r.token, path: `/q/${r.token}` };
  });
  app.get<{ Params: { token: string } }>("/api/live/:token", async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? hostView(r) : reply.code(404).send({ error: "This live quiz is over." });
  });
  app.post<{ Params: { token: string } }>("/api/live/:token/next", async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? hostView(advance(r)) : reply.code(404).send({ error: "This live quiz is over." });
  });
  app.delete<{ Params: { token: string } }>("/api/live/:token", async (req) => {
    closeRoom(req.params.token);
    return { ok: true };
  });

  // The friends' side.
  const headers = (nonce: string) => ({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  app.get<{ Params: { token: string } }>("/q/:token", async (req, reply) => {
    if (!getRoom(req.params.token)) return reply.code(404).type("text/plain; charset=utf-8").send("This live quiz is over.");
    const nonce = randomBytes(12).toString("base64");
    return reply.headers(headers(nonce)).send(livePage(req.params.token, nonce));
  });
  app.get<{ Params: { token: string }; Querystring: { pid?: string } }>("/q/:token/state", async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? reply.header("cache-control", "no-store").send(playerView(r, typeof req.query.pid === "string" ? req.query.pid : undefined)) : reply.code(404).send({ error: "over" });
  });
  app.post<{ Params: { token: string }; Body: { name?: string } }>("/q/:token/join", { bodyLimit: 2048 }, async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? { pid: join(r, String(req.body?.name ?? "")) } : reply.code(404).send({ error: "over" });
  });
  app.post<{ Params: { token: string }; Body: { pid?: string; qi?: number; choice?: number } }>("/q/:token/answer", { bodyLimit: 2048 }, async (req, reply) => {
    const r = getRoom(req.params.token);
    return r ? { ok: answer(r, String(req.body?.pid ?? ""), Number(req.body?.qi), Number(req.body?.choice)) } : reply.code(404).send({ error: "over" });
  });
}
