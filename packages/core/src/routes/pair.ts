import type { FastifyInstance } from "fastify";
import { randomInt, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { KesherServices } from "../services.js";
import { clientAddress, isLocalRequest } from "../auth.js";

interface PairRequest {
  id: string;
  code: string;
  device: string;
  from: string;
  at: number;
  state: "pending" | "allowed" | "denied";
  delivered?: boolean;
}

/** How long a request waits for the user. */
const TTL_MS = 3 * 60_000;

/**
 * Pairing a phone that found this computer on the network: the phone asks
 * (`POST /api/pair`, no token), this computer shows the request with a
 * four-digit code, and when the user allows it the phone gets the access
 * token once (`GET /api/pair/:id`). Nothing is shared unless the user allows
 * it here; a few requests at a time, each for three minutes.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function pairRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const requests = new Map<string, PairRequest>();
  const sweep = () => {
    for (const [id, r] of requests) if (Date.now() - r.at > TTL_MS || r.delivered) requests.delete(id);
  };

  /** For a phone scanning the network: that this is KesherAI, and the computer's name (no token needed). */
  app.get("/api/hello", async () => ({ product: "KesherAI", name: hostname(), pairing: s.config.remote.enabled }));

  app.post<{ Body: { device?: string }; Querystring: { device?: string } }>("/api/pair", async (req, reply) => {
    sweep();
    if (!s.config.remote.enabled) return reply.code(409).send({ error: "Remote access is off on this computer." });
    // Only from the home network or Tailscale, never through the public tunnel.
    if (req.headers["cf-connecting-ip"] !== undefined) return reply.code(403).send({ error: "Pair on the same network, or scan the QR code." });
    const from = clientAddress(req);
    if ([...requests.values()].filter((r) => r.state === "pending").length >= 3 || [...requests.values()].some((r) => r.from === from && r.state === "pending")) {
      return reply.code(429).send({ error: "A request is already waiting on the computer." });
    }
    const r: PairRequest = { id: randomUUID(), code: String(randomInt(1000, 10000)), device: String((req.body as { device?: string } | undefined)?.device ?? req.query.device ?? "Phone").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 40) || "Phone", from, at: Date.now(), state: "pending" };
    requests.set(r.id, r);
    return { id: r.id, code: r.code, computer: hostname() };
  });

  app.get<{ Params: { id: string } }>("/api/pair/:id", async (req, reply) => {
    sweep();
    const r = requests.get(req.params.id);
    if (!r || r.from !== clientAddress(req)) return reply.code(404).send({ error: "No such request (it may have expired)." });
    if (r.state === "allowed") {
      r.delivered = true;
      // A key of its own for this device (removable alone, and named in the request log).
      const token = s.deviceKeys ? await s.deviceKeys.issue(r.device) : s.config.remote.token;
      return { state: r.state, token, port: s.config.port, computer: hostname() };
    }
    return { state: r.state };
  });

  /** On this computer: the requests waiting for an answer, and the answer. */
  app.get("/api/pair", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
    sweep();
    return [...requests.values()].filter((r) => r.state === "pending").map(({ id, code, device, from, at }) => ({ id, code, device, from, at }));
  });
  app.post<{ Params: { id: string }; Body: { allow?: boolean } }>("/api/pair/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
    const r = requests.get(req.params.id);
    if (!r || r.state !== "pending") return reply.code(404).send({ error: "No such request" });
    r.state = req.body?.allow === true ? "allowed" : "denied";
    return { ok: true };
  });
}
