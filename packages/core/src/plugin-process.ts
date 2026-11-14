/**
 * A plugin's own process, seen from KesherAI (board t39): starts plugin-runner with the plugin's folder and the
 * permissions its manifest declares, and turns what the plugin registers into ordinary tools, categories and model
 * provider factories whose every call crosses to that process. A plugin that crashes or hangs takes only itself down.
 *
 * Node's permission model (--experimental-permission) is used when this Node supports it: then the process can read
 * only its own folder and data folder (all files with "filesystem"), write only its data folder, start programs only
 * with "shell", and load no native code. The runner itself refuses the network without "network".
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategoryDefinition } from "@kesher/shared";
import type { ProviderFactory, Provider, ProviderConfig } from "@kesher/providers";
import type { KesherTool } from "@kesher/plugin-sdk";

type Msg = Record<string, unknown> & { t: string };

/** What the plugin registered. */
export interface PluginParts {
  tools: KesherTool[];
  categories: CategoryDefinition[];
  factories: ProviderFactory[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** The runner: the built file next to this one, or (tests, development) the TypeScript source run through tsx. */
function runner(): { file: string; ts: boolean } {
  const js = join(here, "plugin-runner.js");
  if (existsSync(js)) return { file: js, ts: false };
  return { file: join(here, "plugin-runner.ts"), ts: true };
}

/** Node (or Electron as Node) with the flags the runner needs. */
function nodeCommand(extra: string[], ts: boolean): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  // Run through tsx only for the source (tests); the installed app runs the built file.
  // A bare loader name ("--import tsx") is found from the working folder, which is the plugin's: made absolute here.
  const abs = (v: string) => (/^[\w@][\w@/.-]*$/.test(v) && !v.includes(":") ? import.meta.resolve(v) : v);
  const loader = ts
    ? process.execArgv.flatMap((a, i, all) => (a === "--import" ? [] : all[i - 1] === "--import" ? ["--import", abs(a)] : a.startsWith("--import=") ? [`--import=${abs(a.slice(9))}`] : a.startsWith("--conditions") ? [a] : []))
    : [];
  return { cmd: process.execPath, args: [...loader, ...extra], env };
}

let permissionModel: Promise<boolean> | undefined;

/** Whether this Node accepts --experimental-permission (asked once, by starting a tiny process). */
export function permissionModelWorks(): Promise<boolean> {
  return (permissionModel ??= new Promise((done) => {
    const { cmd, args, env } = nodeCommand(["--experimental-permission", "--allow-fs-read=*", "-e", "process.exit(process.permission && process.permission.has('fs.read') ? 0 : 3)"], false);
    const p = spawn(cmd, args, { env, stdio: "ignore", windowsHide: true });
    const t = setTimeout(() => p.kill(), 10_000);
    p.on("error", () => done(false));
    p.on("exit", (code) => {
      clearTimeout(t);
      done(code === 0);
    });
  }));
}

/** One plugin's process: started with {@link PluginProcess.start}, ended with {@link PluginProcess.stop}. */
export class PluginProcess {
  private proc?: ChildProcess;
  private nextId = 1;
  private readonly calls = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void; event?: (d: unknown) => void }>();
  private handles = 0;
  /** Whether files outside its folders are closed to it (Node's permission model was on). */
  sandboxedFiles = false;
  /** What the process wrote to its error output while starting (the end of it). */
  private errText = "";

  /** @param o - The plugin: its folders, main file, settings, declared permissions, and where its output goes. */
  constructor(
    private readonly o: { id: string; dir: string; main: string; dataDir: string; settings: Record<string, unknown>; permissions: string[]; log: (level: string, message: string) => void },
  ) {}

  /**
   * Starts the process and waits for the plugin to activate.
   *
   * @returns What it registered.
   */
  async start(timeoutMs = 30_000): Promise<PluginParts> {
    try {
      return await this.startOnce(timeoutMs, true);
    } catch (err) {
      // The permission model refused something the runner itself needs (seen with files inside the app's archive):
      // start again in its own process, with the runner's own guards only, and say so.
      if (!this.sandboxedFiles || !/ERR_ACCESS_DENIED|Access to this API has been restricted|permission/i.test(`${(err as Error).message} ${this.errText}`)) throw err;
      this.o.log("warn", `Node's file sandbox could not start this plugin (${(err as Error).message.slice(0, 200)}); it runs in its own process without it.`);
      this.sandboxedFiles = false;
      return this.startOnce(timeoutMs, false);
    }
  }

  private async startOnce(timeoutMs: number, sandbox: boolean): Promise<PluginParts> {
    const r = runner();
    const flags: string[] = [];
    if (sandbox && !r.ts && (await permissionModelWorks())) {
      const all = this.o.permissions.includes("filesystem");
      // The runner's own folder (inside the app) must be readable to start; inside the installed app that folder is
      // in an archive (app.asar), which Node reads as one file (found on the PC: the plugin could not start).
      const own = resolve(here, "..", "..");
      const archive = /^(.*?\.asar)(?=[\\/]|$)/.exec(own)?.[1];
      flags.push("--experimental-permission", `--allow-fs-read=${all ? "*" : [resolve(this.o.dir), resolve(this.o.dataDir), own, ...(archive ? [archive] : [])].join(",")}`, `--allow-fs-write=${all ? "*" : resolve(this.o.dataDir)}`);
      if (this.o.permissions.includes("shell")) flags.push("--allow-child-process", "--allow-worker");
      this.sandboxedFiles = !all;
    }
    const { cmd, args, env } = nodeCommand([...flags, r.file], r.ts);
    env.KESHER_PLUGIN = JSON.stringify({ id: this.o.id, main: join(this.o.dir, this.o.main), dataDir: this.o.dataDir, settings: this.o.settings, permissions: this.o.permissions });
    const proc = spawn(cmd, args, { env, cwd: this.o.dir, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced", windowsHide: true });
    this.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => this.o.log("info", d.toString().trimEnd()));
    let errText = "";
    this.errText = "";
    proc.stderr?.on("data", (d: Buffer) => {
      errText = (errText + d.toString()).slice(-4000);
      this.errText = errText;
      this.o.log("warn", d.toString().trimEnd());
    });

    const parts: PluginParts = { tools: [], categories: [], factories: [] };
    return new Promise<PluginParts>((done, fail) => {
      const timer = setTimeout(() => {
        proc.kill();
        fail(new Error(`The plugin did not start within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        for (const c of this.calls.values()) c.fail(new Error(`The plugin's process ended (${code ?? "killed"}).`));
        this.calls.clear();
        // The lines that say what went wrong (Node ends with its stack and version, which say nothing).
        const lines = errText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const why = lines.filter((l) => /Error|code:|denied|resource:|Cannot/i.test(l) && !/^at /.test(l)).slice(0, 3);
        fail(new Error(`The plugin's process ended while starting (${code ?? "killed"}). ${(why.length ? why : lines.slice(-3)).join(" ")}`.trim()));
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        fail(e);
      });
      proc.on("message", (raw) => {
        const m = raw as Msg;
        if (m.t === "tool") parts.tools.push(this.tool(m));
        else if (m.t === "category") parts.categories.push(m.category as CategoryDefinition);
        else if (m.t === "factory") parts.factories.push(this.factory(m));
        else if (m.t === "log") this.o.log(String(m.level), String(m.message));
        else if (m.t === "ready") {
          clearTimeout(timer);
          done(parts);
        } else if (m.t === "failed") {
          clearTimeout(timer);
          fail(new Error(String(m.error)));
        } else if (m.t === "event") this.calls.get(m.id as number)?.event?.(m.data);
        else if (m.t === "result") {
          const c = this.calls.get(m.id as number);
          this.calls.delete(m.id as number);
          if (m.ok) c?.done(m.value);
          else c?.fail(new Error(String(m.error)));
        }
      });
    });
  }

  /** Asks the plugin to deactivate (2 s at most), then ends the process. */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    if (proc.connected) {
      await new Promise<void>((done) => {
        const t = setTimeout(done, 2000);
        proc.once("exit", () => {
          clearTimeout(t);
          done();
        });
        proc.send({ t: "deactivate", id: 0 });
      });
    }
    if (proc.exitCode === null) proc.kill();
  }

  /** One call to the plugin, with its events (streamed text), cancelled by the signal. */
  private call(m: Msg, signal?: AbortSignal, event?: (d: unknown) => void): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.connected) return Promise.reject(new Error(`The plugin ${this.o.id} is not running.`));
    const id = this.nextId++;
    return new Promise((done, fail) => {
      if (signal?.aborted) return fail(new Error("Cancelled"));
      const onAbort = () => proc.send({ t: "cancel", id });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.calls.set(id, {
        done: (v) => {
          signal?.removeEventListener("abort", onAbort);
          done(v);
        },
        fail: (e) => {
          signal?.removeEventListener("abort", onAbort);
          fail(e);
        },
        ...(event ? { event } : {}),
      });
      proc.send({ ...m, id });
    });
  }

  private tool(m: Msg): KesherTool {
    const name = String(m.name);
    return { name, description: String(m.description ?? ""), inputSchema: (m.inputSchema ?? { type: "object" }) as KesherTool["inputSchema"], run: (input, signal) => this.call({ t: "tool", name, input }, signal) };
  }

  /** A model provider factory whose providers live in the plugin's process. */
  private factory(m: Msg): ProviderFactory {
    const type = String(m.type);
    const methods = new Set((m.methods as string[] | undefined) ?? []);
    const call = (msg: Msg, signal?: AbortSignal, event?: (d: unknown) => void) => this.call(msg, signal, event);
    const nextHandle = () => `p${++this.handles}`;
    return {
      type,
      displayName: String(m.displayName ?? type),
      categories: (m.categories ?? []) as ProviderFactory["categories"],
      create(config: ProviderConfig): Provider {
        const handle = nextHandle();
        let made: Promise<unknown> | undefined;
        const ready = () => (made ??= call({ t: "create", type, config, handle }));
        const via = (method: string) => async (...args: unknown[]) => {
          await ready();
          const signal = args.find((a): a is AbortSignal => a instanceof AbortSignal);
          return call({ t: "method", handle, method, args: args.filter((a) => !(a instanceof AbortSignal) && typeof a !== "function") }, signal);
        };
        const p: Record<string, unknown> = {
          id: config.id,
          name: config.name,
          location: (m.location as Provider["location"]) ?? "cloud",
          capabilities: m.capabilities ?? {},
          checkHealth: async (signal?: AbortSignal) => {
            try {
              return (await via("checkHealth")(signal)) === true;
            } catch {
              return false;
            }
          },
          listModels: via("listModels"),
        };
        for (const k of ["generateImage", "generateVideo", "embed"]) if (methods.has(k)) p[k] = via(k);
        if (methods.has("chatWithTools")) {
          p.chatWithTools = async (request: unknown, signal?: AbortSignal, onText?: (delta: string) => void) => {
            await ready();
            return call({ t: "method", handle, method: "chatWithTools", args: [request] }, signal, (d) => onText?.(String(d)));
          };
        }
        if (methods.has("chat")) {
          p.chat = (request: unknown, signal?: AbortSignal): AsyncIterable<unknown> => ({
            async *[Symbol.asyncIterator]() {
              await ready();
              // The pieces arrive as events; the call's end closes the stream.
              const queue: unknown[] = [];
              let wake: (() => void) | undefined;
              let end = false;
              let error: Error | undefined;
              void call({ t: "method", handle, method: "chat", args: [request] }, signal, (d) => {
                  queue.push(d);
                  wake?.();
                })
                .then(
                  () => (end = true),
                  (e: Error) => ((error = e), (end = true)),
                )
                .finally(() => wake?.());
              for (;;) {
                if (queue.length) {
                  yield queue.shift();
                  continue;
                }
                if (end) {
                  if (error) throw error;
                  return;
                }
                await new Promise<void>((r) => (wake = r));
                wake = undefined;
              }
            },
          });
        }
        return p as unknown as Provider;
      },
    };
  }
}
