import type { FastifyInstance } from "fastify";
import { parseVoiceReply, shortSpoken, voiceSummaryPrompt, voiceTurnPrompt } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";

/**
 * Voice mode's small local model (shared/voice-handoff.ts): it answers quick turns in one or two spoken sentences and
 * says when the chat's main model should do the work (the page then sends that as a normal message, so it shows in
 * the chat with its tool steps and approvals). The phone in remote uses the same routes: its audio is turned into
 * text on the PC (/api/speech/transcribe) and the voice model runs on the PC.
 *
 * Nothing here runs a tool or answers an approval. Without a small local model the routes answer 409 `{ fallback }`,
 * and the page sends every turn to the main model and reads its answer shortened.
 */
export function voiceRoutes(app: FastifyInstance, s: KesherServices): void {
  /** The voice model for a chat, or undefined for the fallback. */
  const modelOf = async (id: string) => {
    try {
      return await s.conversations.helpers.voiceModel(id);
    } catch {
      return undefined;
    }
  };

  // Which voice model this chat uses (asked when voice mode opens, so a model beside the chat's is loaded then).
  app.get<{ Params: { id: string } }>("/api/voice/:id/status", async (req) => {
    const m = await modelOf(req.params.id);
    return m ? { model: m.label, fallback: false } : { fallback: true };
  });

  // One quick turn: what to say, and the task for the main model when it hands off.
  app.post<{ Params: { id: string }; Body: { text?: string; working?: boolean; he?: boolean } }>("/api/voice/:id/turn", { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 2000);
    if (!text) return reply.code(400).send({ error: "Say something first." });
    const c = await s.library.getConversation(req.params.id);
    if (!c) return reply.code(404).send({ error: "Conversation not found" });
    const m = await modelOf(c.id);
    if (!m) return reply.code(409).send({ fallback: true, error: "No small voice model on this computer." });
    const he = req.body?.he === true;
    const recent = c.events
      .filter((e): e is typeof e & { type: "user" | "assistant"; text: string } => (e.type === "user" || e.type === "assistant") && typeof (e as { text?: unknown }).text === "string")
      .slice(-6)
      .map((e) => ({ role: e.type, text: e.text }));
    try {
      const r = await modelTurnFor(s.registry, m.modelId)({ messages: [{ role: "user", content: voiceTurnPrompt({ text, recent, working: req.body?.working === true, he }) }], tools: [] }, AbortSignal.timeout(20_000), () => undefined);
      return { ...parseVoiceReply(r.text, he), model: m.label };
    } catch (err) {
      return reply.code(409).send({ fallback: true, error: (err as Error).message });
    }
  });

  // A finished main answer said in one or two sentences (the full answer stays on screen).
  app.post<{ Params: { id: string }; Body: { text?: string; he?: boolean } }>("/api/voice/:id/summary", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const text = String(req.body?.text ?? "").slice(0, 20_000);
    const he = req.body?.he === true;
    if (!text.trim()) return { say: "" };
    const m = await modelOf(req.params.id);
    if (!m) return reply.code(409).send({ fallback: true, say: shortSpoken(text, he) });
    try {
      const r = await modelTurnFor(s.registry, m.modelId)({ messages: [{ role: "user", content: voiceSummaryPrompt(text, he) }], tools: [] }, AbortSignal.timeout(20_000), () => undefined);
      return { say: shortSpoken(r.text, he) || shortSpoken(text, he) };
    } catch {
      return { say: shortSpoken(text, he) };
    }
  });
}
