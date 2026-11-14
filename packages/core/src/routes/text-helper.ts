/**
 * The Text Helper (as AnythingLLM's Magic Beacon and PopClip, but on the user's own models): text selected in any
 * app on the computer (Ctrl+Alt+K) or on the phone (the "KesherAI" item in Android's selection menu) opens a small
 * window with quick actions. The questions go to one "Text helper" chat, so earlier ones stay findable.
 *
 * The selected text is kept here only until its window reads it (a few minutes at most), never on disk.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KesherServices } from "../services.js";

/** Longest selection taken (a long article still fits; a whole book does not). */
export const TEXT_HELPER_MAX = 20_000;

const TTL_MS = 10 * 60_000;
const waiting = new Map<string, { text: string; at: number }>();

/**
 * Keeps a selection for its window, and forgets old ones.
 *
 * @param text - The selected text (cut to TEXT_HELPER_MAX).
 * @param now - The time (for tests).
 * @returns Its id.
 */
export function keepSelection(text: string, now = Date.now()): string {
  for (const [k, v] of waiting) if (now - v.at > TTL_MS) waiting.delete(k);
  while (waiting.size >= 30) waiting.delete(waiting.keys().next().value!);
  const id = randomUUID();
  waiting.set(id, { text: text.slice(0, TEXT_HELPER_MAX), at: now });
  return id;
}

/**
 * A kept selection.
 *
 * @param id - From keepSelection.
 * @param now - The time (for tests).
 * @returns The text, or undefined when unknown or too old.
 */
export function selectionOf(id: string, now = Date.now()): string | undefined {
  const v = waiting.get(id);
  if (!v || now - v.at > TTL_MS) return undefined;
  return v.text;
}

/**
 * Routes for the Text Helper.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function textHelperRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const mapFile = join(s.paths.root, "text-helper.json");

  /** The key was pressed (or text was chosen on the phone): keep the text, and the helper's chat (made the first time). */
  app.post<{ Body: { text?: unknown } }>("/api/text-helper/open", async (req, reply) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (req.body?.text !== undefined && typeof req.body.text !== "string") return reply.code(400).send({ error: "text is text." });
    const saved = JSON.parse(await readFile(mapFile, "utf8").catch(() => "{}")) as { chatId?: string };
    let chat = saved.chatId ? await s.library.getConversation(saved.chatId) : undefined;
    if (!chat) {
      // Selected text can come from any web page or email, so it may carry instructions for the model: this chat
      // asks before any tool that writes or runs (scan 64), whatever the default mode is.
      chat = await s.conversations.create({ kind: "chat", title: "✍ Text helper", mode: "ask" });
      await writeFile(mapFile, JSON.stringify({ chatId: chat.id }));
    }
    return { chatId: chat.id, id: keepSelection(text), chars: Math.min(text.length, TEXT_HELPER_MAX), cut: text.length > TEXT_HELPER_MAX };
  });

  /** The selection, for the helper's window. */
  app.get<{ Params: { id: string } }>("/api/text-helper/:id", async (req, reply) => {
    const text = selectionOf(req.params.id);
    if (text === undefined) return reply.code(404).send({ error: "This selection is no longer here. Select the text again." });
    return { text };
  });
}
