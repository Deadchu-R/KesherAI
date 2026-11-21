import { isLocalRequest } from "../auth.js";
import { findAffinity, findBlender, openInAffinity, openInBlender } from "../open-in-app.js";
import type { FastifyInstance } from "fastify";
import { PLUGIN_FILES_KEY } from "../auth.js";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { KesherServices } from "../services.js";
import { PluginManifestSchema } from "@kesher/plugin-sdk";
import { acceptedAll, compareVersions, downloadRelease, loadStoreIndex, unpackVerified, type StoreEntry } from "../plugin-store.js";

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
  app.get("/api/plugins/ui", async () => ({ ...s.plugins.ui(), filesKey: PLUGIN_FILES_KEY }));

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
        // A sandboxed page has no origin ("null"), and the browser fetches its module scripts (the 3D editor's three.js)
        // with CORS: they load only when the answer allows that origin. The key in the path still guards the files.
        .header("access-control-allow-origin", req.headers.origin === "null" ? "null" : undefined)
        .send(data);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  /** Installs a plugin from Git. Body: `{ source }` (`https://…` or `owner/repo`). */
  app.post<{ Body: { source?: string } }>("/api/plugins/install", async (req, reply) => {
    // Installing code that runs on this computer: only from this computer.
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Plugins are installed on the computer that runs KesherAI." });
    try {
      const id = await s.plugins.install(String(req.body?.source ?? "").trim(), s.paths.plugins, async (newId) => {
        // A plugin from the internet starts off: the user turns it on after seeing what it may do.
        s.config.plugins[newId] = { enabled: false, settings: s.config.plugins[newId]?.settings ?? {} };
        await s.saveConfig();
      });
      return { id, off: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Plugin folders she is developing (RESEARCH_LOG "Open source"): loaded where they are, reloaded on every change. */
  app.get("/api/plugins/dev", async () => ({ folders: s.config.pluginDevFolders }));
  app.post<{ Body: { folder?: string; remove?: boolean } }>("/api/plugins/dev", async (req, reply) => {
    // Code that runs on this computer: only from this computer.
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Plugins are loaded on the computer that runs KesherAI." });
    const folder = resolve(String(req.body?.folder ?? "").trim());
    if (req.body?.remove) {
      s.config.pluginDevFolders = s.config.pluginDevFolders.filter((f) => resolve(f) !== folder);
    } else {
      if (!existsSync(join(folder, "kesher-plugin.json"))) return reply.code(400).send({ error: "That folder has no kesher-plugin.json (make one with: pnpm create-plugin <id> --dir <folder>)." });
      if (!s.config.pluginDevFolders.some((f) => resolve(f) === folder)) s.config.pluginDevFolders = [...s.config.pluginDevFolders, folder].slice(-10);
    }
    await s.saveConfig();
    s.plugins.setDevFolders(s.config.pluginDevFolders);
    await s.plugins.reload();
    return { folders: s.config.pluginDevFolders, plugins: s.plugins.list().filter((p) => p.dev).map((p) => ({ id: p.manifest.id, dir: p.dir, status: p.status, error: p.error })) };
  });

  // ---------- The plugin store (plugins/index.json): see plugin-store.ts for the rules ----------
  /** The index, with what is installed here and which installs are waiting for the computer's approval. */
  const storeIndex = () =>
    loadStoreIndex(s.pluginRoots, process.env.KESHER_STORE_INDEX_URL === "off" ? undefined : async () => {
      // KESHER_STORE_INDEX_URL=off keeps the copy shipped with the app (tests, offline use).
      const r = await fetch("https://raw.githubusercontent.com/Deadchu-R/KesherAI/main/plugins/index.json", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      return r.json();
    });
  const entryOf = async (id: unknown): Promise<StoreEntry | undefined> => (await storeIndex()).index.plugins.find((p) => p.id === id);
  const installedVersion = (id: string) => s.plugins.list().find((p) => p.manifest.id === id)?.manifest.version;

  /** Downloads, checks and installs an entry. Installs start turned off; an update keeps the old on/off choice. */
  const installEntry = async (entry: StoreEntry): Promise<{ id: string; version: string; updated: boolean }> => {
    const have = s.plugins.list().find((p) => p.manifest.id === entry.id);
    if (have && compareVersions(entry.version, have.manifest.version) <= 0) throw new Error("This version is already installed.");
    await mkdir(s.paths.plugins, { recursive: true });
    const { dir } = await unpackVerified(entry, await downloadRelease(entry), s.paths.plugins);
    try {
      const was = s.config.plugins[entry.id];
      await s.plugins.installStaged(dir, entry.id, s.paths.plugins, async (id) => {
        s.config.plugins[id] = { enabled: have ? was?.enabled ?? false : false, settings: was?.settings ?? {} };
        await s.saveConfig();
      }, !!have);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return { id: entry.id, version: entry.version, updated: !!have };
  };

  app.get("/api/plugins/store", async () => {
    const { index, source } = await storeIndex();
    return {
      source,
      plugins: index.plugins.map((p) => {
        const have = installedVersion(p.id);
        return { ...p, installedVersion: have ?? null, updateAvailable: !!have && compareVersions(p.version, have) > 0 };
      }),
      requests: s.pluginInstallRequests.list(),
    };
  });

  /** Installs on this computer. Body: `{ id, accept }`, where `accept` lists the permissions the user pressed install on. */
  app.post<{ Body: { id?: string; accept?: unknown } }>("/api/plugins/store/install", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Plugins are installed at the computer that runs KesherAI. Send a request instead.", request: true });
    const entry = await entryOf(req.body?.id);
    if (!entry) return reply.code(404).send({ error: "That plugin is not in the store." });
    if (!acceptedAll(entry, req.body?.accept)) return reply.code(400).send({ error: "Accept the permissions the plugin asks for first.", permissions: entry.permissions });
    try {
      return await installEntry(entry);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** A phone (or any paired device) asks for an install; the computer shows an approval card. Body: `{ id }`. */
  app.post<{ Body: { id?: string } }>("/api/plugins/store/requests", async (req, reply) => {
    const entry = await entryOf(req.body?.id);
    if (!entry) return reply.code(404).send({ error: "That plugin is not in the store." });
    try {
      const request = s.pluginInstallRequests.create(entry.id);
      void s.notifier.send({ title: "Plugin install request", body: `${entry.name.en}: approve at the computer`, path: "#/plugins", tags: ["package"] }).catch(() => undefined);
      return { request, waiting: true };
    } catch (err) {
      return reply.code(429).send({ error: (err as Error).message });
    }
  });

  /** The computer approves a request, with the permissions it was shown. Body: `{ accept }`. */
  app.post<{ Params: { rid: string }; Body: { accept?: unknown } }>("/api/plugins/store/requests/:rid/approve", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only the computer that runs KesherAI can approve an install." });
    const waiting = s.pluginInstallRequests.list().find((r) => r.id === req.params.rid);
    const entry = waiting && (await entryOf(waiting.pluginId));
    if (!waiting || !entry) return reply.code(404).send({ error: "That request is gone." });
    if (!acceptedAll(entry, req.body?.accept)) return reply.code(400).send({ error: "Accept the permissions the plugin asks for first.", permissions: entry.permissions });
    s.pluginInstallRequests.take(waiting.id);
    try {
      return await installEntry(entry);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Declines (or cancels) a request; allowed from anywhere, it only removes it. */
  app.delete<{ Params: { rid: string } }>("/api/plugins/store/requests/:rid", async (req) => ({ ok: !!s.pluginInstallRequests.take(req.params.rid) }));

  /** Turns a plugin on or off. Body: `{ enabled }`. */
  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/plugins/:id", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "Send { enabled: true | false }" });
    // Turning a plugin on lets its code run: only on this computer (turning one off works from anywhere).
    if (req.body.enabled && !isLocalRequest(req)) return reply.code(403).send({ error: "Plugins are turned on at the computer that runs KesherAI." });
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

  // ---------- Files a plugin page shares with other apps on this computer ----------
  // In <data>/plugin-data/<id>/files; the plugin needs the "filesystem" permission.
  const filesOf = (id: string) => {
    const p = s.plugins.list().find((x) => x.manifest.id === id && x.status === "active");
    return p?.manifest.permissions.includes("filesystem") ? join(s.paths.root, "plugin-data", id, "files") : undefined;
  };
  const okName = (n: string) => /^[\w][\w .()-]{0,100}\.(png|jpe?g|webp|psd|afphoto|txt|json|wav|glb)$/i.test(n);

  /** Writes a file: body `{ data }` as a data: URL. Returns its full path. */
  app.put<{ Params: { id: string; name: string }; Body: { data?: string } }>("/api/plugins/:id/files/:name", { bodyLimit: 200 * 1024 * 1024 }, async (req, reply) => {
    const dir = filesOf(req.params.id);
    if (!dir) return reply.code(403).send({ error: "This plugin did not ask for the \"filesystem\" permission." });
    if (!okName(req.params.name)) return reply.code(400).send({ error: "Bad file name" });
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(String(req.body?.data ?? ""));
    if (!m) return reply.code(400).send({ error: "Send the file as a base64 data: URL." });
    await mkdir(dir, { recursive: true });
    const path = join(dir, req.params.name);
    await writeFile(path, Buffer.from(m[1]!, "base64"));
    return { path, mtime: (await stat(path)).mtimeMs };
  });

  /** A file's time (`?stat=1`) or its contents as a data: URL. */
  app.get<{ Params: { id: string; name: string }; Querystring: { stat?: string } }>("/api/plugins/:id/files/:name", async (req, reply) => {
    const dir = filesOf(req.params.id);
    if (!dir) return reply.code(403).send({ error: "This plugin did not ask for the \"filesystem\" permission." });
    if (!okName(req.params.name)) return reply.code(400).send({ error: "Bad file name" });
    const path = join(dir, req.params.name);
    const st = await stat(path).catch(() => undefined);
    if (!st) return reply.code(404).send({ error: "No such file" });
    if (req.query.stat) return { mtime: st.mtimeMs, size: st.size };
    const ext = req.params.name.split(".").pop()!.toLowerCase();
    const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", wav: "audio/wav", json: "application/json", txt: "text/plain", glb: "model/gltf-binary" }[ext] ?? "application/octet-stream";
    return { mtime: st.mtimeMs, data: `data:${type};base64,${(await readFile(path)).toString("base64")}` };
  });

  /** Opens one of the plugin's files in Affinity (or the system's app for it), on the computer. */
  app.post<{ Params: { id: string; name: string }; Querystring: { app?: string } }>("/api/plugins/:id/files/:name/open", async (req, reply) => {
    const dir = filesOf(req.params.id);
    if (!dir) return reply.code(403).send({ error: "This plugin did not ask for the \"filesystem\" permission." });
    if (!okName(req.params.name) || !existsSync(join(dir, req.params.name))) return reply.code(404).send({ error: "No such file" });
    // A 3D model in Blender, for a round trip (each save in Blender comes back to the same file).
    if (req.query.app === "blender") {
      if (!/\.glb$/i.test(req.params.name)) return reply.code(400).send({ error: "Blender opens a .glb here." });
      return openInBlender(join(dir, req.params.name));
    }
    const own = s.config.plugins[req.params.id]?.settings?.affinityPath;
    return openInAffinity(join(dir, req.params.name), typeof own === "string" ? own : undefined);
  });

  /** Whether Affinity is installed. */
  app.get("/api/apps/affinity", async () => ({ installed: !!(await findAffinity()), platform: process.platform }));
  /** Whether Blender is installed. */
  app.get("/api/apps/blender", async () => ({ installed: !!(await findBlender()), platform: process.platform }));

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

  /**
   * What a plugin from GitHub would do, before it is installed: its
   * permissions, whether it runs code, its licence and age, and whether
   * the KesherAI project checked it. Only on this computer (it installs there).
   */
  app.get<{ Querystring: { source?: string } }>("/api/plugins/preview", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Plugins are installed on the computer that runs KesherAI." });
    const src = String(req.query.source ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    const m = /^([\w.-]+)\/([\w.-]+)$/.exec(src);
    if (!m) return { repo: src, known: false, warnings: ["Not on GitHub: KesherAI cannot show what it does before installing. Install only if you trust where it comes from."] };
    const [, owner, name] = m;
    const gh = { accept: "application/vnd.github+json", "user-agent": "KesherAI" };
    type Repo = { full_name: string; html_url: string; stargazers_count: number; pushed_at: string; created_at: string; license?: { spdx_id?: string } | null; archived?: boolean };
    const [repo, raw, officialList] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${name}`, { headers: gh, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? (r.json() as Promise<Repo>) : undefined)).catch(() => undefined),
      fetch(`https://raw.githubusercontent.com/${owner}/${name}/HEAD/kesher-plugin.json`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.text() : undefined)).catch(() => undefined),
      fetch("https://raw.githubusercontent.com/Deadchu-R/KesherAI/main/community/official.json", { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? (r.json() as Promise<{ plugins?: string[] }>) : { plugins: [] })).catch(() => ({ plugins: [] as string[] })),
    ]);
    if (!repo) return reply.code(404).send({ error: "That GitHub repository was not found (or GitHub did not answer)." });
    const parsed = raw ? PluginManifestSchema.safeParse((() => { try { return JSON.parse(raw) as unknown; } catch { return undefined; } })()) : undefined;
    if (!parsed?.success) return reply.code(400).send({ error: "That repository is not a KesherAI plugin (kesher-plugin.json is missing or invalid)." });
    const man = parsed.data;
    const official = (officialList.plugins ?? []).some((x) => x.toLowerCase() === repo.full_name.toLowerCase());
    const days = (Date.now() - Date.parse(repo.created_at)) / 86_400_000;
    const warnings = [
      ...(official ? [] : ["Not checked by the KesherAI project: anyone can publish a plugin."]),
      ...(man.main ? ["Runs its own code on this computer, with the same access as KesherAI."] : []),
      ...(man.permissions.includes("shell") ? ["Asks to run programs and commands."] : []),
      ...(man.permissions.includes("network") ? ["Asks to reach the internet."] : []),
      ...(man.permissions.includes("filesystem") ? ["Asks to read and write files."] : []),
      ...(days < 30 ? [`The repository is new (${Math.max(1, Math.round(days))} days old).`] : []),
      ...(!repo.license?.spdx_id || repo.license.spdx_id === "NOASSERTION" ? ["It has no licence."] : []),
      ...(repo.archived ? ["The repository is archived (no longer kept up)."] : []),
    ];
    return {
      repo: repo.full_name,
      url: repo.html_url,
      known: true,
      official,
      stars: repo.stargazers_count,
      updatedAt: repo.pushed_at,
      createdAt: repo.created_at,
      license: repo.license?.spdx_id ?? null,
      manifest: { id: man.id, name: man.name, version: man.version, author: man.author ?? null, description: man.description ?? "", permissions: man.permissions, runsCode: !!man.main, programs: man.programs.map((p) => p.name) },
      warnings,
    };
  });
}
