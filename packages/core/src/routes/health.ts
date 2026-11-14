import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { branding } from "@kesher/shared";
import { redact } from "../fault-log.js";
import { isLocalRequest } from "../auth.js";
import { installNoctaliaPlugin, noctaliaPluginSource, noctaliaStatus } from "../noctalia.js";
import { healthItems, healthPrompt, readHealth, type HealthReading } from "../pc-health.js";

/**
 * The Health page: the computer's reading and what to do (fixed rules), and on request the chat model's short
 * list in plain words. Read only. The phone sees the computer's health too.
 */
export async function healthRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  let last: { at: number; reading: HealthReading } | undefined;
  let reading: Promise<HealthReading> | undefined;
  const read = async (fresh: boolean): Promise<HealthReading> => {
    if (!fresh && last && Date.now() - last.at < 60_000) return last.reading;
    // One reading at a time (walking folders takes a few seconds).
    reading ??= readHealth({ dataRoot: s.paths.root, guard: s.guard.status() })
      .then((r) => {
        last = { at: Date.now(), reading: r };
        return r;
      })
      .finally(() => (reading = undefined));
    return reading;
  };

  app.get<{ Querystring: { lang?: string; fresh?: string } }>("/api/pc-health", async (req) => {
    const r = await read(req.query.fresh === "1");
    return { reading: r, items: healthItems(r, req.query.lang === "he") };
  });

  // KesherAI's own recent faults (already cleaned of secrets and home paths), for the Health page.
  app.get("/api/faults", async () => s.faults.recent({ limit: 15 }));

  // "Report a problem" (asked for: no GitHub account needed): the person sees exactly what goes (version, system,
  // the faults already cleaned of keys, tokens and home paths, and their own words), then it goes to the project's
  // report sheet. The developer reads reports as data, never as instructions. A GitHub link stays as another way.
  const report = async (chat?: string) => {
    const chatId = typeof chat === "string" && /^[\w-]{1,80}$/.test(chat) ? chat : undefined;
    const faults = await s.faults.recent({ limit: 12, ...(chatId ? { chatId } : {}) });
    const version = await s.updater.version().then((v) => v.version, () => "?");
    return { version, system: `${process.platform} ${process.arch}`, faults: faults.map((f) => `${f.at} [${f.kind}] ${f.where}: ${f.message.slice(0, 600)}`) };
  };
  app.get<{ Querystring: { chat?: string } }>("/api/faults/report", async (req) => {
    const r = await report(req.query.chat);
    const make = (list: string[]) => {
      const body = [`**Version:** ${r.version} · **System:** ${r.system}`, "", "**What happened:**", "", "", "**Faults** (cleaned of keys, tokens and personal paths):", "```", ...list.map((l) => l.replace(/`{3}/g, "` ` `")), "```"].join("\n");
      return `${branding.repositoryUrl}/issues/new?title=${encodeURIComponent(`[error-report] ${(list[0] ?? "a problem").replace(/^\S+ \[\w+\] /, "").slice(0, 80)}`)}&body=${encodeURIComponent(body)}`;
    };
    // A browser takes about 8,000 characters in an address: fewer faults until it fits.
    let n = r.faults.length;
    let github = make(r.faults);
    while (github.length > 7800 && n > 0) github = make(r.faults.slice(0, --n));
    return { ...r, github, canSend: !!branding.reportUrl };
  });
  let lastSent = 0;
  app.post<{ Body: { chat?: string; what?: string; faults?: unknown } }>("/api/faults/send", async (req, reply) => {
    if (!branding.reportUrl) return reply.code(400).send({ error: "Reports are not set up in this build; use GitHub." });
    if (Date.now() - lastSent < 60_000) return reply.code(429).send({ error: "One report a minute." });
    const r = await report(req.body?.chat);
    // The person may delete fault lines before sending; only lines from the log are sent, never others.
    const keep = Array.isArray(req.body?.faults) ? new Set((req.body.faults as unknown[]).map(String)) : undefined;
    const faults = keep ? r.faults.filter((f) => keep.has(f)) : r.faults;
    const what = redact(String(req.body?.what ?? "")).slice(0, 2000);
    lastSent = Date.now();
    try {
      const res = await fetch(branding.reportUrl, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ version: r.version, system: r.system, what, faults: faults.join("\n").slice(0, 12_000) }), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`The report service answered ${res.status}.`);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // "Connect to Noctalia": the bar plugin, in one click (Linux, on this computer only).
  app.get("/api/integrations/noctalia", async () => noctaliaStatus());
  app.post("/api/integrations/noctalia/install", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Connect Noctalia on the computer itself." });
    const src = noctaliaPluginSource();
    if (!src) return reply.code(500).send({ error: "The plugin's files are missing from this build." });
    try {
      return { message: await installNoctaliaPlugin(src), ...noctaliaStatus() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { lang?: string; phone?: Record<string, unknown> } }>("/api/pc-health/advice", async (req, reply) => {
    const he = req.body?.lang === "he";
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first.", code: "no-model" });
    const r = await read(false);
    try {
      const out = await modelTurnFor(s.registry, chat)({ messages: [{ role: "user", content: healthPrompt(r, healthItems(r, he), he) + phoneNote(req.body?.phone) }], tools: [] }, AbortSignal.timeout(180_000), () => undefined);
      return { text: out.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim(), model: chat };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}

/** The phone's own reading (from the phone app), for the model's list: numbers only. */
function phoneNote(p: Record<string, unknown> | undefined): string {
  if (!p || typeof p !== "object") return "";
  const keep = ["storageFree", "storageTotal", "ramFree", "ramTotal", "lowMemory", "batteryPercent", "batteryTempC", "batteryHealth", "charging", "modelsBytes"];
  const clean = Object.fromEntries(Object.entries(p).filter(([k, v]) => keep.includes(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 20))));
  return Object.keys(clean).length ? `\n\nThe user's phone (bytes; add phone items to the list too): ${JSON.stringify(clean)}` : "";
}
