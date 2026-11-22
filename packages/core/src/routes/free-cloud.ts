import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ProviderConfig } from "@kesher/providers";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { FREE_PROVIDERS, freeBaseUrl, freeProvider, paidModelReason, validAccountId } from "../free-cloud-catalog.js";
import { FreeOnlyProvider, redact, type FreeCloudStore } from "../free-cloud.js";

/** A key as providers write them: printable, no spaces, a sane length. Never repeated back in an error. */
const KEY = /^[\x21-\x7E]{8,400}$/;

/**
 * A small JSON file for the pool's day counters (written atomically, best effort).
 *
 * @param file - Where it lives.
 * @returns The store the pool takes.
 */
export function freeCloudFileStore(file: string): FreeCloudStore {
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        return raw && typeof raw === "object" ? (raw as ReturnType<FreeCloudStore["load"]>) : {};
      } catch {
        return {};
      }
    },
    save(state) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(state));
        renameSync(`${file}.tmp`, file);
      } catch {
        /* the counters are a convenience; a failed write loses nothing important */
      }
    },
  };
}

/**
 * (Re)builds a provider's connection from the config's settings and its key.
 *
 * @param s - The services.
 * @param id - The free provider id.
 * @param key - A new key, or undefined to keep the saved one.
 * @returns Whether a connection exists now (it needs a key and, for Cloudflare, an account id).
 */
async function applyConnection(s: KesherServices, id: string, key?: string | null): Promise<boolean> {
  const info = freeProvider(id)!;
  const old = s.config.providers.find((p) => p.id === id);
  const apiKey = key === null ? undefined : key ?? old?.apiKey;
  const baseUrl = freeBaseUrl(id, { ...(s.config.freeCloud.cloudflareAccountId ? { accountId: s.config.freeCloud.cloudflareAccountId } : {}), region: s.config.freeCloud.zhipuRegion });
  s.registry.remove(id);
  s.config.providers = s.config.providers.filter((p) => p.id !== id);
  if (!apiKey || !baseUrl) return false;
  const config: ProviderConfig = { id, type: "free-cloud", name: info.name, baseUrl, apiKey, location: "cloud" };
  s.registry.add(config);
  s.config.providers.push(config);
  return true;
}

/**
 * Settings › Accounts / Models › Free cloud helpers. Any device may read the state (the phone sees it); everything that
 * changes a key, a setting or spends a request is for the computer that runs KesherAI (like the other keys). A key is
 * kept sealed in the config as the connection's `apiKey`; it is never sent back, logged or put in an error message.
 *
 * @param app - Fastify instance.
 * @param s - The services (config, registry, pool).
 */
export async function freeCloudRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const localOnly = (req: Parameters<typeof isLocalRequest>[0]) => isLocalRequest(req);
  const view = () => {
    const pool = s.freeCloud;
    const status = pool?.status() ?? [];
    const c = s.config.freeCloud;
    return {
      settings: { order: status.map((x) => x.id), disabled: c.disabled, chatFallback: c.chatFallback, backgroundFallback: c.backgroundFallback, models: c.models, cloudflareAccountId: c.cloudflareAccountId ?? "", zhipuRegion: c.zhipuRegion },
      providers: FREE_PROVIDERS.map((p) => ({ ...p, status: status.find((x) => x.id === p.id) })),
    };
  };

  app.get("/api/free-cloud", async () => view());

  app.put<{ Body: { order?: string[]; disabled?: string[]; chatFallback?: boolean; backgroundFallback?: boolean; models?: Record<string, string>; cloudflareAccountId?: string; zhipuRegion?: string } }>("/api/free-cloud/settings", async (req, reply) => {
    if (!localOnly(req)) return reply.code(403).send({ error: "Free cloud settings are changed on the computer that runs KesherAI." });
    const b = req.body ?? {};
    const c = s.config.freeCloud;
    const known = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!freeProvider(x)) : undefined);
    const order = known(b.order);
    if (order) c.order = [...new Set(order)];
    const disabled = known(b.disabled);
    if (disabled) c.disabled = [...new Set(disabled)];
    if (typeof b.chatFallback === "boolean") c.chatFallback = b.chatFallback;
    if (typeof b.backgroundFallback === "boolean") c.backgroundFallback = b.backgroundFallback;
    if (b.models && typeof b.models === "object") {
      for (const [id, model] of Object.entries(b.models)) {
        if (!freeProvider(id) || typeof model !== "string") continue;
        const m = model.trim();
        // A model that costs money is refused, and the answer says so.
        const why = m ? paidModelReason(id, m) : undefined;
        if (why) return reply.code(400).send({ error: `Refused: ${why} KesherAI never uses a paid model.` });
        if (m) c.models[id] = m.slice(0, 120);
        else delete c.models[id];
      }
    }
    let rebuild = false;
    if (typeof b.cloudflareAccountId === "string") {
      const v = b.cloudflareAccountId.trim();
      if (v && !validAccountId(v)) return reply.code(400).send({ error: "That does not look like a Cloudflare account id (letters and digits)." });
      if (v) c.cloudflareAccountId = v;
      else delete c.cloudflareAccountId;
      rebuild = true;
    }
    if (b.zhipuRegion === "cn" || b.zhipuRegion === "global") {
      c.zhipuRegion = b.zhipuRegion;
      rebuild = true;
    }
    if (rebuild) {
      await applyConnection(s, "fc-cloudflare");
      await applyConnection(s, "fc-zhipu");
    }
    await s.saveConfig();
    return view();
  });

  app.put<{ Params: { id: string }; Body: { key?: string | null } }>("/api/free-cloud/:id/key", async (req, reply) => {
    if (!localOnly(req)) return reply.code(403).send({ error: "Keys are entered on the computer that runs KesherAI." });
    if (!freeProvider(req.params.id)) return reply.code(404).send({ error: "Unknown provider." });
    const v = req.body?.key;
    const key = typeof v === "string" ? v.trim() : "";
    if (key && !KEY.test(key)) return reply.code(400).send({ error: "That does not look like an API key (no spaces, 8 or more characters)." });
    if (key && !freeBaseUrl(req.params.id, { ...(s.config.freeCloud.cloudflareAccountId ? { accountId: s.config.freeCloud.cloudflareAccountId } : {}), region: s.config.freeCloud.zhipuRegion })) {
      return reply.code(400).send({ error: "Enter the Cloudflare account id first." });
    }
    await applyConnection(s, req.params.id, key || null);
    await s.saveConfig();
    return view();
  });

  app.post<{ Params: { id: string } }>("/api/free-cloud/:id/test", async (req, reply) => {
    if (!localOnly(req)) return reply.code(403).send({ error: "Testing sends a request with your key: do it on the computer that runs KesherAI." });
    if (!freeProvider(req.params.id) || !s.freeCloud) return reply.code(404).send({ error: "Unknown provider." });
    return { ...(await s.freeCloud.test(req.params.id)), ...view() };
  });

  app.get<{ Params: { id: string } }>("/api/free-cloud/:id/models", async (req, reply) => {
    if (!localOnly(req)) return reply.code(403).send({ error: "The model list uses your key: ask on the computer that runs KesherAI." });
    const provider = s.registry.get(req.params.id);
    if (!freeProvider(req.params.id) || !(provider instanceof FreeOnlyProvider)) return reply.code(404).send({ error: "Add a key first." });
    try {
      const models = await provider.listFree();
      // Free ones first; the paid ones are shown struck through with the reason, and cannot be chosen.
      return { models: [...models].sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id)).slice(0, 400) };
    } catch (e) {
      return reply.code(502).send({ error: redact((e as Error).message, s.config.providers.find((p) => p.id === req.params.id)?.apiKey).slice(0, 300) });
    }
  });
}
