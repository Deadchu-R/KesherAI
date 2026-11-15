/**
 * Training models from KesherAI (moved out of server.ts, board t49): a picture LoRA through ComfyUI's training nodes
 * (training.ts), datasets from the user's chats and pages, and an experimental chat-model LoRA (chat-trainer.ts).
 */
import type { FastifyInstance } from "fastify";
import { slug, type Training } from "../training.js";
import { CHAT_BASES, type ChatTrainer } from "../chat-trainer.js";

/**
 * Routes for training.
 *
 * @param app - Fastify instance.
 * @param d - The trainers, and the graphics card's memory in GB.
 */
export async function trainingRoutes(app: FastifyInstance, d: { training: Training; chatTrainer: ChatTrainer; vramGb: () => Promise<number> }): Promise<void> {
  app.get("/api/training/chat", async () => ({ ...d.chatTrainer.status(), bases: CHAT_BASES, vramGb: await d.vramGb() }));
  app.post("/api/training/chat/install", async () => {
    void d.chatTrainer.install();
    return d.chatTrainer.status();
  });
  app.post<{ Body: { name?: string; dataset?: string; base?: string; steps?: number; rank?: number } }>("/api/training/chat", async (req, reply) => {
    const ds = (await d.training.datasets()).find((d) => d.name === req.body?.dataset);
    if (!ds) return reply.code(400).send({ error: "Choose a dataset." });
    try {
      await d.chatTrainer.train({ name: slug(String(req.body?.name ?? ds.name)), dataset: ds.file, base: String(req.body?.base ?? ""), ...(typeof req.body?.steps === "number" ? { steps: req.body.steps } : {}), ...(typeof req.body?.rank === "number" ? { rank: req.body.rank } : {}) });
      return d.chatTrainer.status();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get("/api/training/datasets", async () => d.training.datasets());
  app.post<{ Body: { name?: string; chats?: string[]; documents?: boolean } }>("/api/training/datasets", async (req, reply) => {
    try {
      return await d.training.buildChatDataset({ name: String(req.body?.name ?? "my-texts"), chats: Array.isArray(req.body?.chats) ? req.body.chats.filter((x) => typeof x === "string") : [], documents: req.body?.documents === true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get("/api/training", async () => ({ kinds: await d.training.kinds(), jobs: d.training.list() }));
  app.post<{ Body: { name?: string; trigger?: string; base?: string; steps?: number; rank?: number; images?: Array<{ data?: string; mimeType?: string }> } }>("/api/training/image-lora", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    const images = (b.images ?? []).filter((i) => typeof i.data === "string" && /^image\/(png|jpeg|webp)$/.test(i.mimeType ?? "")).map((i) => ({ data: Buffer.from(i.data!, "base64"), mimeType: i.mimeType! }));
    try {
      return await d.training.startImageLora({ name: String(b.name ?? ""), trigger: String(b.trigger ?? ""), base: String(b.base ?? ""), images, ...(typeof b.steps === "number" ? { steps: b.steps } : {}), ...(typeof b.rank === "number" ? { rank: b.rank } : {}) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post("/api/training/stop", async () => {
    d.training.stop();
    return { ok: true };
  });
}
