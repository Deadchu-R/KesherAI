import type { FastifyInstance } from "fastify";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { KesherServices } from "../services.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/**
 * Plugins and mods: what they add to the interface, their files, installing
 * from Git, turning them on and off, a small storage for their pages, and a
 * catalog of public plugins (GitHub repositories tagged `kesherai-plugin`).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function pluginRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** Pages, panels, styles and composer buttons from active plugins. */
  app.get("/api/plugins/ui", async () => s.plugins.ui());

  /**
   * A plugin's own file (its pages, scripts, styles). The token is part of
   * the path so relative links inside a sandboxed page keep working; see auth.ts.
   */
  app.get<{ Params: { token: string; id: string; "*": string } }>("/api/plugin-files/:token/:id/*", async (req, reply) => {
    const file = s.plugins.fileOf(req.params.id, req.params["*"]);
    if (!file) return reply.code(404).send({ error: "Not found" });
    try {
      const data = await readFile(file);
      return reply
        .type(TYPES[extname(file).toLowerCase()] ?? "application/octet-stream")
        // The page may load only its own files and talk to the app through postMessage.
        .header("content-security-policy", "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'")
        .send(data);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  /** Installs a plugin from Git. Body: `{ source }` (`https://…` or `owner/repo`). */
  app.post<{ Body: { source?: string } }>("/api/plugins/install", async (req, reply) => {
    try {
      const id = await s.plugins.install(String(req.body?.source ?? "").trim(), s.paths.plugins);
      return { id };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Turns a plugin on or off. Body: `{ enabled }`. */
  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/plugins/:id", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "Send { enabled: true | false }" });
    const prev = s.config.plugins[req.params.id];
    s.config.plugins[req.params.id] = { enabled: req.body.enabled, settings: prev?.settings ?? {} };
    await s.saveConfig();
    await s.plugins.reload();
    return { ok: true };
  });

  /** Removes a plugin the user installed. */
  app.delete<{ Params: { id: string } }>("/api/plugins/:id", async (req, reply) => {
    try {
      await s.plugins.uninstall(req.params.id, s.paths.plugins);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** A plugin page's saved value (JSON), by key. */
  app.get<{ Params: { id: string; key: string } }>("/api/plugins/:id/storage/:key", async (req, reply) => {
    if (!/^[\w.-]{1,80}$/.test(req.params.key) || !/^[a-z0-9-]+$/.test(req.params.id)) return reply.code(400).send({ error: "Bad key" });
    const raw = await readFile(join(s.paths.root, "plugin-data", req.params.id, "storage", `${req.params.key}.json`), "utf8").catch(() => "null");
    return { value: JSON.parse(raw) as unknown };
  });

  /** Saves a value for a plugin page (up to 1 MB). */
  app.put<{ Params: { id: string; key: string }; Body: { value?: unknown } }>("/api/plugins/:id/storage/:key", async (req, reply) => {
    if (!/^[\w.-]{1,80}$/.test(req.params.key) || !/^[a-z0-9-]+$/.test(req.params.id)) return reply.code(400).send({ error: "Bad key" });
    const text = JSON.stringify(req.body?.value ?? null);
    if (text.length > 1_000_000) return reply.code(413).send({ error: "Too big (1 MB at most)" });
    const dir = join(s.paths.root, "plugin-data", req.params.id, "storage");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${req.params.key}.json`), text);
    return { ok: true };
  });

  /**
   * The community store. `official`: plugins the KesherAI project publishes
   * and checks (listed in community/official.json in the main repository);
   * `community`: public GitHub repositories with the topic `kesherai-plugin`,
   * made by anyone and not checked.
   */
  app.get("/api/plugins/catalog", async (_req, reply) => {
    const gh = { accept: "application/vnd.github+json", "user-agent": "KesherAI" };
    type Repo = { full_name: string; description: string | null; stargazers_count: number; html_url: string; updated_at: string; topics?: string[]; owner?: { login: string; avatar_url: string } };
    const shape = (r: Repo, official: boolean) => ({
      repo: r.full_name,
      description: r.description ?? "",
      stars: r.stargazers_count,
      url: r.html_url,
      updatedAt: r.updated_at,
      topics: (r.topics ?? []).filter((t) => t !== "kesherai-plugin"),
      author: r.owner?.login ?? r.full_name.split("/")[0],
      official,
    });
    const [officialList, search] = await Promise.all([
      fetch("https://raw.githubusercontent.com/Deadchu-R/KesherAI/main/community/official.json", { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? (r.json() as Promise<{ plugins?: string[] }>) : { plugins: [] }))
        .catch(() => ({ plugins: [] as string[] })),
      fetch("https://api.github.com/search/repositories?q=topic:kesherai-plugin&sort=stars&per_page=60", { headers: gh, signal: AbortSignal.timeout(10_000) })
        .then(async (r) => {
          if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
          return ((await r.json()) as { items?: Repo[] }).items ?? [];
        })
        .catch((err: Error) => err),
    ]);
    const officialRepos = new Set((officialList.plugins ?? []).map((x) => x.toLowerCase()));
    if (search instanceof Error && officialRepos.size === 0) return reply.code(502).send({ error: `Could not load the store: ${search.message}` });
    const items = search instanceof Error ? [] : search;
    const official = await Promise.all(
      [...officialRepos].map(async (full) => {
        const found = items.find((r) => r.full_name.toLowerCase() === full);
        if (found) return shape(found, true);
        const r = await fetch(`https://api.github.com/repos/${full}`, { headers: gh, signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? (x.json() as Promise<Repo>) : undefined)).catch(() => undefined);
        return r ? shape(r, true) : undefined;
      }),
    );
    return {
      official: official.filter((x) => !!x),
      community: items.filter((r) => !officialRepos.has(r.full_name.toLowerCase())).map((r) => shape(r, false)),
    };
  });
}
