import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";

/**
 * The Memory page: topics and their facts (general and per project), pause, filing by itself, a project's
 * isolation from the general memory, and reset. The phone can use it too.
 */
export async function memoryRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const view = async () => {
    const d = await s.memory.data();
    const projects = Object.fromEntries(s.library.listProjects().map((p) => [p.id, p.name]));
    return { ...d, projects };
  };
  app.get("/api/memory", view);

  app.put<{ Body: { paused?: boolean; auto?: boolean; isolate?: { project?: string; on?: boolean } } }>("/api/memory/settings", async (req) => {
    const b = req.body ?? {};
    await s.memory.settings({
      ...(typeof b.paused === "boolean" ? { paused: b.paused } : {}),
      ...(typeof b.auto === "boolean" ? { auto: b.auto } : {}),
      ...(b.isolate && typeof b.isolate.project === "string" ? { isolate: { project: b.isolate.project, on: b.isolate.on === true } } : {}),
    });
    return view();
  });

  /** A fact typed on the Memory page. */
  app.post<{ Body: { topic?: string; text?: string; project?: string | null } }>("/api/memory/facts", async (req, reply) => {
    try {
      const project = req.body?.project && s.library.getProject(req.body.project) ? req.body.project : undefined;
      await s.memory.add({ topic: String(req.body?.topic ?? "About you"), text: String(req.body?.text ?? ""), source: "you", ...(project ? { project } : {}) });
      return view();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Edit one fact; an empty text deletes it. */
  app.put<{ Params: { topic: string; index: string }; Body: { text?: string } }>("/api/memory/topics/:topic/facts/:index", async (req, reply) => {
    try {
      await s.memory.editFact(req.params.topic, Number(req.params.index), String(req.body?.text ?? ""));
      return view();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Rename a topic (`title`), or delete it (no title). */
  app.put<{ Params: { topic: string }; Body: { title?: string } }>("/api/memory/topics/:topic", async (req) => {
    await s.memory.editTopic(req.params.topic, typeof req.body?.title === "string" ? req.body.title : undefined);
    return view();
  });
  app.delete<{ Params: { topic: string } }>("/api/memory/topics/:topic", async (req) => {
    await s.memory.editTopic(req.params.topic);
    return view();
  });

  /**
   * Import from another assistant (Claude and ChatGPT can both list what they remember): pasted text, one fact per
   * line or bullet; "Topic: fact" lines keep their topic. Lines that look like secrets are skipped.
   */
  app.post<{ Body: { text?: string } }>("/api/memory/import", async (req) => {
    const lines = String(req.body?.text ?? "")
      .slice(0, 50_000)
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((l) => l.length >= 3 && !/^#/.test(l));
    let added = 0;
    let skipped = 0;
    for (const l of lines.slice(0, 300)) {
      const m = /^([^:]{2,40}):\s+(.{3,})$/.exec(l);
      try {
        await s.memory.add({ topic: m ? m[1]! : "Imported", text: m ? m[2]! : l, source: "you" });
        added++;
      } catch {
        skipped++;
      }
    }
    return { added, skipped, ...(await view()) };
  });

  /** Deletes all memory (general and every project's). */
  app.post("/api/memory/reset", async () => {
    await s.memory.reset();
    return view();
  });
}
