import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { AssetBank, type BankKind } from "../asset-bank.js";
import type { ConversationSummary } from "@kesher/shared";
import type { KesherServices } from "../services.js";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
};
const KINDS = new Set<BankKind>(["image", "video", "audio", "model"]);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : []);

/**
 * The bank of everything the AI made (asset-bank.ts): list, a file's bytes, copy into a chat, delete, and the
 * same-bytes duplicates. Guests cannot reach it (their key opens only /api/guest/).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function bankRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const bank = new AssetBank({
    assets: s.assets,
    chats: () => s.library.listConversations(),
    // chats() gives the library's summaries, which carry what workspaceOf reads.
    folderOf: (c) => s.conversations.workspaceOf(c as unknown as ConversationSummary),
  });

  app.get<{ Querystring: { kind?: string } }>("/api/bank", async (req) => {
    const kind = KINDS.has(req.query.kind as BankKind) ? (req.query.kind as BankKind) : undefined;
    return { items: await bank.list(kind) };
  });

  // One item's file (for the cards, the preview and an editor taking it). Served as a download for anything that is
  // not a picture, video or sound, so a page in it cannot run.
  app.get<{ Querystring: { id?: string } }>("/api/bank/file", async (req, reply) => {
    const found = await bank.pathOf(String(req.query.id ?? ""));
    if (!found) return reply.code(404).send({ error: "Not in the bank" });
    const st = await stat(found.path);
    const type = TYPES[extname(found.path).toLowerCase()] ?? "application/octet-stream";
    reply.header("content-length", st.size).header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=60");
    if (!/^(image|video|audio)\//.test(type) || type === "image/svg+xml") reply.header("content-disposition", `attachment; filename="${encodeURIComponent(found.name)}"`);
    return reply.type(type).send(createReadStream(found.path));
  });

  app.post<{ Body: { ids?: unknown; conversationId?: unknown } }>("/api/bank/copy", async (req, reply) => {
    const to = String(req.body?.conversationId ?? "");
    try {
      return { paths: await bank.copyTo(ids(req.body?.ids), to) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { ids?: unknown } }>("/api/bank/delete", async (req) => ({ deleted: await bank.delete(ids(req.body?.ids)) }));

  app.get("/api/bank/duplicates", async () => ({ groups: await bank.duplicates() }));
}
