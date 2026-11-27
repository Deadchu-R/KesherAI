import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { AMADEUS_HOSTS } from "../travel/amadeus.js";
import type { IlsRates } from "../travel/ils.js";
import { MAX_POLLS_PER_DAY, MAX_WATCHES, watchLabel, type TravelWatches } from "../travel/watches.js";

/**
 * Settings › Travel (computer and phone): GET says which keys are set (never the keys), the defaults, the Bank of Israel
 * rate and the price watches with their history; PUT (this computer only) sets keys and defaults; watches can be paused,
 * resumed and deleted from the phone too.
 *
 * @param app - Fastify instance.
 * @param s - The services (the config).
 * @param watches - The price watches.
 * @param rates - The shekel rates.
 */
export async function travelRoutes(app: FastifyInstance, s: KesherServices, watches: TravelWatches, rates: IlsRates): Promise<void> {
  app.get("/api/travel", async () => {
    const t = s.config.travel;
    const cur = await rates.current();
    const all = await watches.all();
    return {
      keys: { amadeus: !!(t.amadeusKey && t.amadeusSecret), duffel: !!t.duffelToken },
      amadeusHost: t.amadeusHost,
      origin: t.origin,
      everyHours: t.everyHours,
      dropPercent: t.dropPercent,
      dropShekel: t.dropShekel,
      maxWatches: MAX_WATCHES,
      maxPollsPerDay: MAX_POLLS_PER_DAY,
      rate: cur ? { USD: cur.table.rates.USD, EUR: cur.table.rates.EUR, date: cur.table.date, source: "Bank of Israel", stale: cur.stale } : null,
      watches: all.map((w) => {
        const last = w.history[w.history.length - 1];
        const ils = w.history.map((p) => p.ils);
        return { id: w.id, kind: w.kind, label: watchLabel(w), maxIls: w.maxIls ?? null, paused: w.paused, expired: !!w.expired, lastIls: last?.ils ?? null, firstIls: ils[0] ?? null, lowestIls: ils.length ? Math.min(...ils) : null, carrier: last?.who ?? "", lastPollAt: w.lastPollAt ?? null, pollsToday: w.pollsToday, lastError: w.lastError ?? null, history: w.history };
      }),
    };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/travel", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Travel keys and defaults are changed on the computer that runs KesherAI." });
    const b = req.body ?? {};
    const next = { ...s.config.travel };
    // A key: a string sets it, null or "" clears it, absent leaves it.
    for (const k of ["amadeusKey", "amadeusSecret", "duffelToken"] as const) {
      const v = b[k];
      if (v === undefined) continue;
      const key = typeof v === "string" ? v.trim() : "";
      if (key && (key.length > 300 || /\s/.test(key))) return reply.code(400).send({ error: "That does not look like a key." });
      if (key) next[k] = key;
      else delete next[k];
    }
    if (b.amadeusHost !== undefined) {
      if (typeof b.amadeusHost !== "string" || !Object.hasOwn(AMADEUS_HOSTS, b.amadeusHost)) return reply.code(400).send({ error: "Host must be test or production." });
      next.amadeusHost = b.amadeusHost as "test" | "production";
    }
    if (b.origin !== undefined) {
      const o = String(b.origin).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(o)) return reply.code(400).send({ error: "The home airport is a 3-letter code (TLV)." });
      next.origin = o;
    }
    const range = (name: "everyHours" | "dropPercent" | "dropShekel", lo: number, hi: number) => {
      if (b[name] === undefined) return true;
      const n = Number(b[name]);
      if (!Number.isFinite(n) || n < lo || n > hi) return false;
      next[name] = name === "dropPercent" ? n : Math.round(n);
      return true;
    };
    if (!range("everyHours", 1, 24) || !range("dropPercent", 1, 90) || !range("dropShekel", 10, 5000)) return reply.code(400).send({ error: "A number is out of range." });
    s.config.travel = next;
    await s.saveConfig();
    return { ok: true };
  });

  app.post<{ Params: { id: string; action: string } }>("/api/travel/watches/:id/:action", async (req, reply) => {
    const { id, action } = req.params;
    if (action !== "pause" && action !== "resume") return reply.code(400).send({ error: "Unknown action." });
    return (await watches.setPaused(id, action === "pause")) ? { ok: true } : reply.code(404).send({ error: "This watch is gone." });
  });
  app.delete<{ Params: { id: string } }>("/api/travel/watches/:id", async (req, reply) => ((await watches.remove(req.params.id)) ? { ok: true } : reply.code(404).send({ error: "This watch is gone." })));
}
