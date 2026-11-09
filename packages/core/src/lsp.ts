import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A real C# language server for the code editor (Rider-like help): csharp-ls,
 * Microsoft's Roslyn behind the Language Server Protocol. It reads the Unity
 * project's .sln/.csproj (which Unity writes for the external editor), so it
 * knows every class of the project and its libraries: suggestions, errors as
 * you type, quick fixes, go to definition, rename.
 *
 * One server per project, started on first use and stopped when no editor is
 * connected for a while. The page talks JSON-RPC over a WebSocket; here each
 * message is framed the LSP way (Content-Length) to the server's stdin/stdout.
 */

/** Where `dotnet tool install --global csharp-ls` puts the server. */
export function csharpLsPath(home = homedir()): string | undefined {
  const exe = join(home, ".dotnet", "tools", process.platform === "win32" ? "csharp-ls.exe" : "csharp-ls");
  return existsSync(exe) ? exe : undefined;
}

/** The solution of a Unity project (Unity writes `<Project>.sln` next to Assets/). */
export async function solutionOf(project: string): Promise<string | undefined> {
  const sln = (await readdir(project).catch(() => [] as string[])).filter((f) => f.toLowerCase().endsWith(".sln"));
  return sln.length ? join(project, sln[0]!) : undefined;
}

/** Splits LSP's framed stream (Content-Length headers) into JSON messages. */
export class LspFramer {
  private buf = Buffer.alloc(0);
  /** @param onMessage - Gets each whole message. */
  constructor(private readonly onMessage: (json: string) => void) {}
  /** Takes more of the stream. */
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString("ascii"))?.[1] ?? NaN);
      if (!Number.isFinite(len)) {
        this.buf = this.buf.subarray(end + 4);
        continue;
      }
      if (this.buf.length < end + 4 + len) return;
      this.onMessage(this.buf.subarray(end + 4, end + 4 + len).toString("utf8"));
      this.buf = this.buf.subarray(end + 4 + len);
    }
  }
}

/** One message framed for the server. */
export const frame = (json: string) => `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;

interface Running { proc: ChildProcessWithoutNullStreams; clients: Set<(json: string) => void>; idle?: NodeJS.Timeout; initialized?: string }

/** The language servers that are running, by project (one per project, shared by its editors). */
export class LanguageServers {
  private running = new Map<string, Running>();

  /** @param find - Where the server is (tests pass their own). */
  constructor(private readonly find = csharpLsPath) {}

  /** Whether csharp-ls is installed here. */
  get installed(): boolean {
    return !!this.find();
  }

  /**
   * Connects an editor to the project's server (started if needed).
   *
   * @returns Sends a message to the server, and closes this editor's link.
   */
  async connect(project: string, onMessage: (json: string) => void): Promise<{ send: (json: string) => void; close: () => void; initialized?: string }> {
    let r = this.running.get(project);
    if (!r) {
      const exe = this.find();
      if (!exe) throw new Error("csharp-ls is not installed.");
      const sln = await solutionOf(project);
      const proc = spawn(exe, sln ? ["--solution", sln] : [], { cwd: project, windowsHide: true, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
      const run: Running = { proc, clients: new Set() };
      r = run;
      const framer = new LspFramer((json) => {
        // A second editor gets the first one's initialize answer from here; everything else goes to every editor.
        for (const c of run.clients) c(json);
      });
      proc.stdout.on("data", (d: Buffer) => framer.push(d));
      proc.stderr.on("data", () => undefined);
      proc.on("exit", () => {
        if (this.running.get(project) === run) this.running.delete(project);
        for (const c of run.clients) c(JSON.stringify({ jsonrpc: "2.0", method: "kesher/exit" }));
      });
      this.running.set(project, run);
    }
    const run = r;
    clearTimeout(run.idle);
    run.clients.add(onMessage);
    return {
      ...(run.initialized ? { initialized: run.initialized } : {}),
      send: (json: string) => {
        try {
          const msg = JSON.parse(json) as { method?: string; id?: unknown };
          // The server is set up once; a second editor's initialize is answered from the first one.
          if (msg.method === "initialize" && run.initialized) {
            onMessage(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: JSON.parse(run.initialized) }));
            return;
          }
          if ((msg.method === "initialized" || msg.method === "shutdown" || msg.method === "exit") && run.initialized && run.clients.size > 1) return;
        } catch {
          return;
        }
        run.proc.stdin.write(frame(json));
      },
      close: () => {
        run.clients.delete(onMessage);
        if (!run.clients.size) run.idle = setTimeout(() => this.stop(project), 10 * 60_000);
      },
    };
  }

  /** Remembers the server's answer to initialize (its capabilities), for the next editors. */
  remember(project: string, result: string): void {
    const r = this.running.get(project);
    if (r && !r.initialized) r.initialized = result;
  }

  /** Stops one project's server. */
  stop(project: string): void {
    const r = this.running.get(project);
    if (!r) return;
    this.running.delete(project);
    r.proc.kill();
  }

  /** Stops every server (KesherAI closing). */
  stopAll(): void {
    for (const p of [...this.running.keys()]) this.stop(p);
  }
}
