import type { FastifyInstance } from "fastify";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Whether an address is on this computer or the home/office network (never fetched for a page). */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) return /^(::1?$|fc|fd|fe80|::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip);
  return /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}

/**
 * A picture from the web shown in an answer, on her tap (RichText AnswerImage): the app loads pictures only from
 * itself, so KesherAI fetches it. https only, never an address on this computer or the local network, pictures only,
 * at most 10 MB, no cookies or referrer.
 */
export async function webImageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { url?: string } }>("/api/web/image", async (req, reply) => {
    let url: URL;
    try {
      url = new URL(String(req.query.url ?? ""));
    } catch {
      return reply.code(400).send({ error: "Not an address." });
    }
    if (url.protocol !== "https:" || url.username || url.password) return reply.code(400).send({ error: "Only https pictures." });
    const ips = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!ips.length || ips.some((a) => privateAddress(a.address))) return reply.code(400).send({ error: "That address is not on the web." });
    const res = await fetch(url, { redirect: "error", headers: { "user-agent": "KesherAI" }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    const type = (res?.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!res?.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return reply.code(502).send({ error: "The picture did not load." });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > 10 * 1024 * 1024) return reply.code(502).send({ error: "The picture is too big." });
    return reply.type(type).header("cache-control", "max-age=3600").send(body);
  });
}
