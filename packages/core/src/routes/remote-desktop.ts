import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { RemoteDesktop, hashPin, type RemoteInput } from "../remote-desktop.js";

/**
 * Controlling this computer from the phone: settings (only on the computer), a session with the PIN, pictures of
 * the screen and input. See remote-desktop.ts for the safety rules.
 */
export async function remoteDesktopRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const rd = new RemoteDesktop(() => s.config.remoteDesktop);
  // The waiting requests' codes and the trusted phones only on the computer itself (scan 55: a phone that could
  // read a waiting code could approve its own request).
  app.get("/api/remote-desktop", async (req) => ({ ...rd.status(), ...(isLocalRequest(req) ? { waiting: rd.waiting(), trusted: (s.config.remoteDesktop.trusted ?? []).map((t) => ({ name: t.name, at: t.at, id: t.id })) } : {}) }));
  // A phone asks for control without the PIN: the owner answers on the computer or with the buttons on their phone.
  app.post<{ Body: { device?: string; deviceId?: string } }>("/api/remote-desktop/request", async (req, reply) => {
    try {
      const r = rd.request(String(req.body?.device ?? ""), String(req.body?.deviceId ?? ""));
      if (r.code) {
        const base = `api/remote-desktop/decide/${r.code}`;
        void s.notifier.send({ title: "📱 A phone asks to control this computer", body: `${String(req.body?.device ?? "A phone").slice(0, 60)} wants to control the computer. Allow only if it is yours or someone you trust.`, path: "#/remote", priority: 4, actions: [{ label: "Allow once", path: `${base}?d=once` }, { label: "Always", path: `${base}?d=always` }, { label: "Deny", path: `${base}?d=deny` }] }).catch(() => undefined);
      }
      return { id: r.id, ...(r.token ? { token: r.token } : {}) };
    } catch (err) {
      return reply.code(403).send({ error: (err as Error).message });
    }
  });
  app.get<{ Params: { id: string }; Querystring: { deviceId?: string } }>("/api/remote-desktop/request/:id", async (req) => rd.poll(req.params.id, String(req.query.deviceId ?? "")));
  // The owner's answer (no token needed: the one-time code is the key, like the chat's Approve buttons).
  app.post<{ Params: { code: string }; Querystring: { d?: string } }>("/api/remote-desktop/decide/:code", async (req, reply) => {
    const d = req.query.d === "once" || req.query.d === "always" || req.query.d === "deny" ? req.query.d : undefined;
    if (!d) return reply.code(400).send({ error: "d must be once, always or deny" });
    const r = rd.decide(req.params.code, d);
    if (!r) return reply.code(410).send({ error: "This request was answered or is too old." });
    if (r.keep) {
      s.config.remoteDesktop = { ...s.config.remoteDesktop, trusted: [...(s.config.remoteDesktop.trusted ?? []).filter((t) => t.id !== r.keep!.id), r.keep].slice(-20) };
      await s.saveConfig();
    }
    return { ok: true };
  });
  // On the computer: stop trusting a phone.
  app.delete<{ Params: { id: string } }>("/api/remote-desktop/trusted/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Changed on the computer itself." });
    s.config.remoteDesktop = { ...s.config.remoteDesktop, trusted: (s.config.remoteDesktop.trusted ?? []).filter((t) => t.id !== req.params.id) };
    await s.saveConfig();
    return { ok: true };
  });
  // On the computer only: switch it on or off, set the PIN (6-12 digits).
  app.put<{ Body: { enabled?: boolean; pin?: string } }>("/api/remote-desktop/settings", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Remote control is set up on the computer itself." });
    const b = req.body ?? {};
    if (b.pin !== undefined && !/^\d{6,12}$/.test(String(b.pin))) return reply.code(400).send({ error: "The PIN is 6 to 12 digits." });
    const next = { ...s.config.remoteDesktop, ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}), ...(b.pin ? { pinHash: hashPin(String(b.pin)) } : {}) };
    s.config.remoteDesktop = next;
    if (!next.enabled) rd.end();
    await s.saveConfig();
    return rd.status();
  });
  // The computer's banner (or the phone) ends the session.
  app.post("/api/remote-desktop/end", async () => {
    rd.end();
    return rd.status();
  });
  app.post<{ Body: { pin?: string; device?: string } }>("/api/remote-desktop/session", async (req, reply) => {
    try {
      const token = rd.start(String(req.body?.pin ?? ""), String(req.body?.device ?? ""));
      void s.notifier.send({ title: "📱 Remote control started", body: "Your phone is controlling this computer. End it from the bar at the top of KesherAI.", path: "#/remote" }).catch(() => undefined);
      return { token };
    } catch (err) {
      return reply.code(403).send({ error: (err as Error).message });
    }
  });
  app.get<{ Querystring: { s?: string; w?: string } }>("/api/remote-desktop/frame", async (req, reply) => {
    try {
      const f = await rd.frame(String(req.query.s ?? ""), Number(req.query.w));
      return reply.type("image/png").header("cache-control", "no-store").header("x-width", String(f.width)).header("x-height", String(f.height)).send(f.png);
    } catch (err) {
      return reply.code(403).send({ error: (err as Error).message });
    }
  });
  app.post<{ Body: { s?: string; input?: RemoteInput } }>("/api/remote-desktop/input", async (req, reply) => {
    const i = req.body?.input;
    if (!i || typeof i !== "object" || !["click", "double", "right", "move", "scroll", "type", "key"].includes((i as { kind?: string }).kind ?? "")) return reply.code(400).send({ error: "Unknown input." });
    try {
      await rd.input(String(req.body?.s ?? ""), i);
      return { ok: true };
    } catch (err) {
      return reply.code(403).send({ error: (err as Error).message });
    }
  });
}
