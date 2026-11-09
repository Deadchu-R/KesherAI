import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PHONES, chosenPhones, phoneNote, summarize, type Phone } from "../phones.js";
import { readPluggedPhone } from "../android-phone.js";

/**
 * Target phones (Settings → For developers): the catalog, the chosen
 * phones, and reading the phone plugged in by USB.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function phoneRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const view = () => {
    const chosen = chosenPhones(s.config.phones.targets, s.config.phones.custom as Phone[]);
    return {
      catalog: PHONES,
      custom: s.config.phones.custom,
      targets: s.config.phones.targets,
      ...(chosen.length ? { summary: summarize(chosen), brief: phoneNote(chosen) } : {}),
    };
  };

  app.get("/api/phones", async () => view());

  /** The chosen phones (ids from the catalog or read over USB). */
  app.put<{ Body: { targets?: unknown } }>("/api/phones/targets", async (req, reply) => {
    const known = new Set([...PHONES, ...s.config.phones.custom].map((p) => p.id));
    if (!Array.isArray(req.body?.targets)) return reply.code(400).send({ error: "Send the list of phone ids." });
    s.config.phones.targets = [...new Set(req.body.targets.filter((t): t is string => typeof t === "string" && known.has(t)))].slice(0, 40);
    await s.saveConfig();
    return view();
  });

  /** Reads the phone plugged in now and adds it (chosen) to the list. */
  app.post("/api/phones/detect", async (_req, reply) => {
    const r = await readPluggedPhone();
    if (!r.phone) return reply.code(409).send({ error: r.problem ?? "No phone." });
    const p = r.phone;
    s.config.phones.custom = [p, ...s.config.phones.custom.filter((c) => c.id !== p.id)].slice(0, 20);
    if (!s.config.phones.targets.includes(p.id)) s.config.phones.targets = [...s.config.phones.targets, p.id].slice(0, 40);
    await s.saveConfig();
    return { ...view(), detected: p };
  });

  /** Removes a phone read over USB. */
  app.delete<{ Params: { id: string } }>("/api/phones/custom/:id", async (req) => {
    s.config.phones.custom = s.config.phones.custom.filter((c) => c.id !== req.params.id);
    s.config.phones.targets = s.config.phones.targets.filter((t) => t !== req.params.id);
    await s.saveConfig();
    return view();
  });
}
