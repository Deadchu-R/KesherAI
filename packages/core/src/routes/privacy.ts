import type { FastifyInstance } from "fastify";
import { homedir, userInfo } from "node:os";
import { privacyModeOf } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { checkText, setPrivacyGuard } from "../privacy-guard.js";

/** This computer's user name (empty when the system cannot say). */
function osUser(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cleans the "never send" list from a request: trimmed lines of 2–200 characters, no duplicates, at most 200.
 *
 * @param v - The list as sent (an array of strings).
 */
export function cleanNeverSend(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = typeof x === "string" ? x.trim() : "";
    if (t.length >= 2 && t.length <= 200 && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 200) break;
  }
  return out;
}

/**
 * Settings › Privacy and the chat's check before sending (privacy-guard.ts). Both work from the phone too: no mode
 * turns the guard off, so changing it from a paired phone cannot open a leak. This computer's user name and home
 * folder stay on the server (never in an answer).
 *
 * @param app - The server.
 * @param s - The services.
 */
export function privacyRoutes(app: FastifyInstance, s: KesherServices): void {
  const user = osUser();
  const home = homedir();
  setPrivacyGuard(() => ({ mode: privacyModeOf(s.config.privacy?.mode), neverSend: s.config.privacy?.neverSend ?? [], ...(user ? { username: user } : {}), home }));

  app.get("/api/privacy", async () => ({ mode: privacyModeOf(s.config.privacy?.mode), neverSend: s.config.privacy?.neverSend ?? [] }));
  app.put<{ Body: { mode?: unknown; neverSend?: unknown } }>("/api/privacy", async (req) => {
    const b = req.body ?? {};
    const was = s.config.privacy ?? { mode: "ask", neverSend: [] };
    s.config.privacy = { mode: b.mode === undefined ? privacyModeOf(was.mode) : privacyModeOf(b.mode), neverSend: b.neverSend === undefined ? was.neverSend : cleanNeverSend(b.neverSend) };
    await s.saveConfig();
    return s.config.privacy;
  });

  // The chat asks before sending to a model that may train: what the message holds, and its hidden form.
  app.post<{ Body: { modelId?: unknown; text?: unknown } }>("/api/privacy/check", async (req, reply) => {
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.slice(0, 300) : "";
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!modelId || text.length > 400_000) return reply.code(400).send({ error: "A model id and a text of at most 400,000 characters are needed." });
    return checkText(modelId, text);
  });
}
