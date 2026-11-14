/**
 * Runs one plugin in its own process (board t39; docs/DESIGN_RESEARCH.md §7: "isolation first", as VS Code runs
 * extensions). Started by plugin-process.ts with the plugin's folder, data folder and permissions; talks to KesherAI
 * only through the IPC channel: what the plugin registers (tools, categories, model providers) goes up, and each call
 * comes down and is answered.
 *
 * What the plugin did not declare is blocked here before its code loads: without "network" the network modules and
 * fetch, without "shell" child processes and workers. When Node's permission model is on (plugin-process.ts tests
 * that it works), files outside the plugin's folders cannot be read or written either, and native code is refused.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

type Msg = Record<string, unknown> & { t: string };

const send = (m: Msg): void => {
  process.send?.(m);
};

const env = JSON.parse(process.env.KESHER_PLUGIN ?? "{}") as { id: string; main: string; dataDir: string; settings: Record<string, unknown>; permissions: string[] };
const allowed = new Set(env.permissions ?? []);

/**
 * Replaces what a permission covers with a function that refuses, in the built-in modules themselves (one shared
 * copy for require and import; syncBuiltinESMExports updates the import side), so no way of loading gets around it.
 */
function refuse(modules: Record<string, string[]>, permission: string): void {
  const req = createRequire(import.meta.url);
  for (const [name, names] of Object.entries(modules)) {
    let mod: Record<string, unknown>;
    try {
      mod = req(name) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const n of names) {
      if (!(n in mod)) continue;
      const no = function () {
        throw new Error(`The plugin ${env.id} did not ask for the "${permission}" permission (it tried ${name}.${n}).`);
      };
      try {
        Object.defineProperty(mod, n, { value: no, writable: false, configurable: false });
      } catch {
        /* already fixed by Node */
      }
    }
  }
}
if (!allowed.has("network")) {
  refuse(
    {
      net: ["connect", "createConnection", "createServer", "Socket", "Server"],
      http: ["request", "get", "createServer", "Agent"],
      https: ["request", "get", "createServer", "Agent"],
      http2: ["connect", "createServer", "createSecureServer"],
      tls: ["connect", "createServer", "TLSSocket"],
      dgram: ["createSocket", "Socket"],
      dns: ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "Resolver"],
    },
    "network",
  );
  for (const k of ["fetch", "WebSocket", "EventSource"]) {
    Object.defineProperty(globalThis, k, {
      value: () => {
        throw new Error(`The plugin ${env.id} did not ask for the "network" permission (it tried ${k}).`);
      },
      writable: false,
      configurable: false,
    });
  }
}
if (!allowed.has("shell")) {
  refuse({ child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], worker_threads: ["Worker"], cluster: ["fork"] }, "shell");
}
// Node's raw bindings (tcp_wrap, spawn_sync, ...) reach the network and child processes without the modules above.
if (!allowed.has("network") || !allowed.has("shell")) {
  for (const k of ["binding", "_linkedBinding"]) {
    Object.defineProperty(process, k, {
      value: () => {
        throw new Error(`The plugin ${env.id} cannot use Node's internal bindings.`);
      },
      writable: false,
      configurable: false,
    });
  }
}
syncBuiltinESMExports();

// Calls from KesherAI: each has an id; a cancel aborts it.
const tools = new Map<string, { run(input: unknown, signal: AbortSignal): Promise<unknown> }>();
const factories = new Map<string, { create(config: unknown): Record<string, unknown> }>();
const providers = new Map<string, Record<string, unknown>>();
const running = new Map<number, AbortController>();
const PROVIDER_METHODS = ["checkHealth", "listModels", "chat", "chatWithTools", "generateImage", "generateVideo", "embed"];

/** What a provider offers: its optional methods, where it runs and its capabilities. */
function shape(p: Record<string, unknown>) {
  return { methods: PROVIDER_METHODS.filter((m) => typeof p[m] === "function"), location: p.location, capabilities: p.capabilities };
}

const log = (level: string) => (message: string, data?: unknown) => send({ t: "log", level, message: String(message), ...(data === undefined ? {} : { data: String(data) }) });
const context = {
  pluginId: env.id,
  dataDir: env.dataDir,
  settings: env.settings ?? {},
  log: { info: log("info"), warn: log("warn"), error: log("error") },
  registerTool(tool: { name: string; description: string; inputSchema: unknown; run(input: unknown, signal: AbortSignal): Promise<unknown> }) {
    tools.set(tool.name, tool);
    send({ t: "tool", name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  },
  registerCategory(category: unknown) {
    send({ t: "category", category });
  },
  registerProviderFactory(factory: { type: string; displayName: string; categories: unknown; create(config: unknown): Record<string, unknown> }) {
    factories.set(factory.type, factory);
    // A provider made with a sample setting shows what this factory's providers offer (create does no network I/O).
    let probe: ReturnType<typeof shape> = { methods: PROVIDER_METHODS, location: "cloud", capabilities: {} };
    try {
      probe = shape(factory.create({ id: "probe", type: factory.type, name: "probe", baseUrl: "http://127.0.0.1:9" }));
    } catch {
      /* the real one tells */
    }
    send({ t: "factory", type: factory.type, displayName: factory.displayName, categories: factory.categories, ...probe });
  },
};

async function answer(m: Msg): Promise<unknown> {
  const id = m.id as number;
  const ac = new AbortController();
  running.set(id, ac);
  try {
    if (m.t === "tool") {
      const tool = tools.get(String(m.name));
      if (!tool) throw new Error(`No tool ${String(m.name)}`);
      return await tool.run(m.input, ac.signal);
    }
    if (m.t === "create") {
      const f = factories.get(String(m.type));
      if (!f) throw new Error(`No provider type ${String(m.type)}`);
      const p = f.create(m.config);
      providers.set(String(m.handle), p);
      return shape(p);
    }
    if (m.t === "method") {
      const p = providers.get(String(m.handle));
      const fn = p?.[String(m.method)];
      if (typeof fn !== "function") throw new Error(`The provider has no ${String(m.method)}`);
      const args = [...(m.args as unknown[])];
      if (m.method === "chat") {
        // A stream: each piece goes up as an event.
        for await (const piece of fn.call(p, args[0], ac.signal) as AsyncIterable<unknown>) send({ t: "event", id, data: piece });
        return undefined;
      }
      if (m.method === "chatWithTools") return await fn.call(p, args[0], ac.signal, (delta: string) => send({ t: "event", id, data: delta }));
      return await fn.call(p, ...args, ac.signal);
    }
    throw new Error(`Unknown call ${m.t}`);
  } finally {
    running.delete(id);
  }
}

let plugin: { deactivate?(): unknown } | undefined;

process.on("message", (raw) => {
  const m = raw as Msg;
  if (m.t === "cancel") return void running.get(m.id as number)?.abort();
  if (m.t === "deactivate") {
    void Promise.resolve(plugin?.deactivate?.())
      .catch(() => undefined)
      .finally(() => process.exit(0));
    return;
  }
  void answer(m).then(
    (value) => send({ t: "result", id: m.id, ok: true, value }),
    (err: unknown) => send({ t: "result", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});

try {
  const mod = (await import(pathToFileURL(env.main).href)) as { default?: { activate?(ctx: unknown): unknown; deactivate?(): unknown } };
  if (!mod.default?.activate) throw new Error("The main file must default-export definePlugin({...})");
  await mod.default.activate(context);
  plugin = mod.default as { deactivate?(): unknown };
  send({ t: "ready" });
} catch (err) {
  send({ t: "failed", error: err instanceof Error ? err.message : String(err) });
}
