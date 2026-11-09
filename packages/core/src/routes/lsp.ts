import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { spawn } from "node:child_process";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { LanguageServers, solutionOf } from "../lsp.js";

/** Runs dotnet with arguments (no shell) and returns its exit code and output. */
function dotnet(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    let out = "";
    const p = spawn("dotnet", args, { windowsHide: true, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", (e) => {
      clearTimeout(t);
      res({ code: -1, out: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      res({ code: code ?? -1, out: out.slice(-4000) });
    });
  });
}

/**
 * The C# language server for the Unity script editor: whether it is ready,
 * installing it (on this computer, after the user said yes), and the
 * WebSocket the editor talks LSP over (for the active Unity project).
 */
export function lspRoutes(app: FastifyInstance, s: KesherServices): LanguageServers {
  const servers = new LanguageServers();
  app.addHook("onClose", async () => servers.stopAll());

  app.get("/api/lsp/csharp", async () => {
    const project = s.unity.activeProject;
    const sdk = await dotnet(["--list-sdks"], 20_000);
    return { installed: servers.installed, dotnet: sdk.code === 0 && /\d+\.\d+/.test(sdk.out), sdks: sdk.code === 0 ? sdk.out.trim().split(/\r?\n/).slice(0, 6) : [], solution: project ? !!(await solutionOf(project)) : false, project: project ?? null };
  });

  /** Installs csharp-ls for this user (`dotnet tool install --global csharp-ls`): no admin rights, only from this computer. */
  app.post("/api/lsp/csharp/install", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Install it on the computer that runs KesherAI." });
    const r = await dotnet(["tool", "install", "--global", "csharp-ls"], 600_000);
    const ok = r.code === 0 || /already installed/i.test(r.out);
    if (!ok && r.code === -1) return reply.code(400).send({ error: ".NET SDK was not found. Install the .NET SDK (8 or newer) from dot.net first.", out: r.out });
    return { ok, out: r.out };
  });

  app.get("/api/unity/lsp", { websocket: true }, async (socket) => {
    const project = s.unity.activeProject;
    if (!project) {
      socket.close(1008, "No Unity project");
      return;
    }
    let initId: unknown;
    let link: Awaited<ReturnType<LanguageServers["connect"]>>;
    try {
      link = await servers.connect(project, (json) => {
        if (initId !== undefined) {
          try {
            const m = JSON.parse(json) as { id?: unknown; result?: unknown };
            if (m.id === initId && m.result) servers.remember(project, JSON.stringify(m.result));
          } catch {
            // not JSON: dropped below by the browser
          }
        }
        if (socket.readyState === 1) socket.send(json);
      });
    } catch (err) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "kesher/error", params: { message: (err as Error).message } }));
      socket.close();
      return;
    }
    socket.on("message", (raw: Buffer) => {
      const text = raw.toString();
      if (text.length > 2_000_000) return;
      try {
        const m = JSON.parse(text) as { method?: string; id?: unknown };
        if (m.method === "initialize") initId = m.id;
      } catch {
        return;
      }
      link.send(text);
    });
    socket.on("close", () => link.close());
  });
  return servers;
}
