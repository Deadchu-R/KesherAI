import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { Study } from "../study.js";
import { closeFocusRoom, createFocusRoom, focusPage, focusView, getFocusRoom, joinFocus, setTimer } from "../focus-room.js";
import { advance, answer, closeRoom, createRoom, getRoom, hostView, join, livePage, playerView } from "../live-quiz.js";

/** A friends' page's headers: its own script only, never framed, not indexed, not kept. */
const headers = (nonce: string) => ({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

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

/**
 * The shared focus room (design StudyTogether): her controls under /api (her app key), and the friends' page and its
 * calls at /f/<token> (the token is the key).
 *
 * @param app - Fastify instance.
 */
export async function focusRoomRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { title?: string; focus?: number; rest?: number } }>("/api/study/focus-room", async (req) => {
    const r = createFocusRoom(String(req.body?.title ?? ""), Number(req.body?.focus) || 25, Number(req.body?.rest) || 5);
    return { token: r.token, path: `/f/${r.token}` };
  });
  app.get<{ Params: { token: string } }>("/api/focus/:token", async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? focusView(r) : reply.code(404).send({ error: "This room is closed." });
  });
  app.post<{ Params: { token: string }; Body: { run?: boolean; reset?: boolean } }>("/api/focus/:token/timer", async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? focusView(setTimer(r, req.body?.run === true, req.body?.reset === true)) : reply.code(404).send({ error: "This room is closed." });
  });
  app.delete<{ Params: { token: string } }>("/api/focus/:token", async (req) => {
    closeFocusRoom(req.params.token);
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>("/f/:token", async (req, reply) => {
    if (!getFocusRoom(req.params.token)) return reply.code(404).type("text/plain; charset=utf-8").send("This room is closed.");
    const nonce = randomBytes(12).toString("base64");
    return reply.headers(headers(nonce)).send(focusPage(req.params.token, nonce));
  });
  app.get<{ Params: { token: string }; Querystring: { mid?: string } }>("/f/:token/state", async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? reply.header("cache-control", "no-store").send(focusView(r, typeof req.query.mid === "string" ? req.query.mid : undefined)) : reply.code(404).send({ error: "closed" });
  });
  app.post<{ Params: { token: string }; Body: { name?: string; task?: string } }>("/f/:token/join", { bodyLimit: 2048 }, async (req, reply) => {
    const r = getFocusRoom(req.params.token);
    return r ? { id: joinFocus(r, String(req.body?.name ?? ""), String(req.body?.task ?? "")) } : reply.code(404).send({ error: "closed" });
  });
}
