import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { isLocalRequest } from "../auth.js";
import { ocrWhyLast, windowsOcr } from "../ocr.js";

export { parseOcr, type OcrLine } from "../ocr.js";

/** What the lens can do with a part of the screen. */
export type LensAction = "ask" | "search" | "translate" | "summarize" | "text";
const ACTIONS: LensAction[] = ["ask", "search", "translate", "summarize", "text"];

/** What each action asks the vision model (the picture is the part of the screen she marked). */
export function lensPrompt(action: LensAction, question: string, he: boolean): string {
  const lang = he ? "Answer in Hebrew." : "Answer in the language of the question, else English.";
  switch (action) {
    case "text":
      return "Write out every word in this picture exactly, in its own language and order, keeping line breaks. Nothing else: no comments, no translation.";
    case "translate":
      return `Translate all the text in this picture: Hebrew into English, anything else into Hebrew. Keep the order and line breaks. Only the translation.`;
    case "summarize":
      return `Summarize what this picture shows in 3–5 short bullet points. ${lang}`;
    case "search":
      return `Say in one line what this picture shows (what to search for), then give 3 short web search queries that would find it, one per line, starting with "- ". ${lang}`;
    default:
      return `${question.trim() || "What is this? Explain briefly."} ${lang} Be short and clear.`;
  }
}

const shots = new Map<string, { png: Buffer; t: number }>();
const keep = (png: Buffer) => {
  const now = Date.now();
  for (const [k, v] of shots) if (now - v.t > 10 * 60_000) shots.delete(k);
  // Full-screen PNGs are large (a 4K one is 10–20 MB): three at most.
  while (shots.size >= 3) shots.delete(shots.keys().next().value!);
  const id = randomUUID();
  shots.set(id, { png, t: now });
  return id;
};
const pngOf = (b64: unknown) => {
  const buf = Buffer.from(String(b64 ?? "").replace(/^data:image\/png;base64,/, ""), "base64");
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw Object.assign(new Error("Send a PNG picture."), { statusCode: 400 });
  if (buf.length > 20 * 1024 * 1024) throw Object.assign(new Error("The picture is too big."), { statusCode: 413 });
  return buf;
};

/**
 * The screen lens (design ScreenLens, RESEARCH_LOG "Screen lens, part 1"): the key freezes the screen (a picture kept
 * in memory for ten minutes at most), she marks a part, and the vision model asks / searches / translates / summarizes
 * it, or its text is read (Windows' own OCR first). "Continue in chat" makes a chat with the part attached.
 *
 * @param app - Fastify instance.
 * @param s - The services.
 */
export async function lensRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** The key was pressed (from this computer only): the screen now, kept for the lens window. */
  app.post("/api/lens/capture", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only from this computer." });
    const shot = await s.screen?.shot().catch(() => undefined);
    if (!shot) return reply.code(503).send({ error: "The screen could not be captured here." });
    return { id: keep(Buffer.from(shot.png)) };
  });
  /** A picture she chose (a screenshot on the phone): kept like a capture. */
  app.post<{ Body: { data?: string } }>("/api/lens/shot", { bodyLimit: 28 * 1024 * 1024 }, async (req) => ({ id: keep(pngOf(req.body?.data)) }));
  app.get<{ Params: { id: string } }>("/api/lens/shot/:id", async (req, reply) => {
    const v = shots.get(req.params.id);
    if (!v) return reply.code(404).send({ error: "This picture is gone (kept ten minutes)." });
    return reply.type("image/png").header("cache-control", "no-store").send(v.png);
  });
  /** An action on the marked part (a PNG): `{ image, action, question? }` → `{ text }`. */
  app.post<{ Body: { image?: string; action?: string; question?: string; he?: boolean } }>("/api/lens/act", { bodyLimit: 28 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    const action = ACTIONS.includes(b.action as LensAction) ? (b.action as LensAction) : "ask";
    const png = pngOf(b.image);
    const he = b.he !== false;
    const ocr = action === "text" || action === "translate" ? await windowsOcr(png, he) : undefined;
    if (action === "text" && ocr) return { text: ocr.map((l) => l.t).join("\n"), by: "ocr" };
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first (one that sees pictures)." });
    const ac = new AbortController();
    reply.raw.on("close", () => !reply.raw.writableFinished && ac.abort());
    if (action === "translate" && ocr) {
      // Translation in place (like Google Lens): each line the OCR found is translated as text, and drawn over itself.
      const r = await modelTurnFor(s.registry, chat)(
        { messages: [{ role: "system", content: "Translate each numbered line: Hebrew into English, anything else into Hebrew. Answer with JSON only: an array of strings, one per line, in the same order and count." }, { role: "user", content: ocr.map((l, i) => `${i + 1}. ${l.t}`).join("\n") }], tools: [] },
        AbortSignal.any([ac.signal, AbortSignal.timeout(180_000)]),
        () => undefined,
      );
      const raw = r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
      const arr = (() => { try { return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)) as unknown; } catch { return undefined; } })();
      if (Array.isArray(arr) && arr.length === ocr.length) {
        const lines = ocr.map((l, i) => ({ ...l, t: String(arr[i] ?? "").slice(0, 500) }));
        return { text: lines.map((l) => l.t).join("\n"), lines, by: "ocr" };
      }
    }
    // A model that runs on (seen on the PC: 1,900 tokens and still going) is stopped at 6,000 characters.
    let so = "";
    const r = await modelTurnFor(s.registry, chat)(
      { messages: [{ role: "user", content: lensPrompt(action, String(b.question ?? "").slice(0, 1000), he), images: [{ mimeType: "image/png", data: png.toString("base64") }] }], tools: [] },
      AbortSignal.any([ac.signal, AbortSignal.timeout(180_000)]),
      (d) => {
        so += d;
        if (so.length > 6000) ac.abort();
      },
    ).catch((e: unknown) => {
      if (so.length > 6000) return { text: so };
      throw e;
    });
    const text = r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    if (!text) return reply.code(502).send({ error: "The chat model did not answer. Choose a model that sees pictures (for example Gemma 4 or Qwen-VL)." });
    return { text, by: "model", ...(ocrWhyLast() && (action === "text" || action === "translate") ? { ocr: ocrWhyLast() } : {}) };
  });
  /** "Continue in chat": a new chat with the marked part attached and her question (or the action) sent. */
  app.post<{ Body: { image?: string; action?: string; question?: string; he?: boolean } }>("/api/lens/chat", { bodyLimit: 28 * 1024 * 1024 }, async (req) => {
    const b = req.body ?? {};
    const png = pngOf(b.image);
    const action = ACTIONS.includes(b.action as LensAction) ? (b.action as LensAction) : "ask";
    const he = b.he !== false;
    const chat = await s.conversations.create({ kind: "chat", title: he ? "🔍 עדשה" : "🔍 Lens" });
    const dir = s.conversations.workspaceOf(chat);
    if (!dir) throw Object.assign(new Error("This chat has no folder for the picture."), { statusCode: 500 });
    await mkdir(dir, { recursive: true });
    const file = `lens-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    await writeFile(join(dir, file), png);
    const ask = action === "search" ? `${he ? "חפש ברשת מה מופיע בתמונה, ותן קישורים." : "Search the web for what this picture shows, with links."}` : lensPrompt(action, String(b.question ?? "").slice(0, 1000), he);
    await s.conversations.send(chat.id, `[Attached: ${file}]\n${ask}`, { web: action === "search" });
    return { id: chat.id };
  });
}
