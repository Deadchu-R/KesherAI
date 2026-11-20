import { lstat, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { runShell, type AgentTool } from "@kesher/agent";

/**
 * A build sub-agent runs the project's own checks in its copy of the project (docs/RESEARCH_LOG.md, "Gap list: agents
 * and chat-first", A13 first slice), so its report says whether its change passes. Like Claude Code's subagents and
 * Codex's cloud tasks, which run the repo's tests before they hand back a diff.
 *
 * Only the project's own scripts run (package.json `test` / `typecheck` / `lint`, or `cargo test`, `go test`,
 * `pytest`): the model never writes the command line. It is still a command, so it waits for the user's approval on
 * the chat's card (which names the sub-agent), like any other command.
 */

/** The checks a build sub-agent may run. */
export type CheckName = "test" | "typecheck" | "lint";

/** The command for one check, as found in the project. */
export interface CheckCommand {
  /** The whole command line, shown on the approval card. */
  command: string;
}

/** The longest output handed back to the sub-agent (its tail: the summary is at the end). */
const OUTPUT_CHARS = 4000;
/** A check's time cap. */
const CHECK_MS = 10 * 60_000;

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Finds the command that runs a check in a project folder.
 *
 * @param dir - The project folder (the sub-agent's copy).
 * @param check - Which check (default `test`).
 * @returns The command, or undefined when the project has none for it.
 */
export async function checkCommand(dir: string, check: CheckName = "test"): Promise<CheckCommand | undefined> {
  const pkg = await readFile(join(dir, "package.json"), "utf8").then(
    (t) => JSON.parse(t) as { scripts?: Record<string, unknown> },
    () => undefined,
  );
  if (pkg) {
    if (typeof pkg.scripts?.[check] !== "string") return undefined;
    const pm = (await exists(join(dir, "pnpm-lock.yaml"))) ? "pnpm -s" : (await exists(join(dir, "yarn.lock"))) ? "yarn -s" : "npm run -s";
    return { command: check === "test" && pm === "npm run -s" ? "npm test -s" : `${pm} ${check}` };
  }
  if (check !== "test") return undefined;
  if (await exists(join(dir, "Cargo.toml"))) return { command: "cargo test" };
  if (await exists(join(dir, "go.mod"))) return { command: "go test ./..." };
  for (const f of ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]) if (await exists(join(dir, f))) return { command: "python -m pytest -q" };
  return undefined;
}

/**
 * Links the project's installed packages (`node_modules`, which git does not copy) into the sub-agent's copy, at the
 * top and one or two folders down (a monorepo's packages), so its checks can run without a new install.
 *
 * @param copy - The sub-agent's copy.
 * @param source - The user's project folder.
 * @returns Takes the links away again (they must not end up in the copy's diff).
 */
export async function linkDependencies(copy: string, source: string): Promise<() => Promise<void>> {
  const made: string[] = [];
  const visit = async (rel: string, depth: number) => {
    const from = join(source, rel, "node_modules");
    const to = join(copy, rel, "node_modules");
    if ((await exists(from)) && (await exists(join(copy, rel))) && !(await exists(to))) {
      // A junction on Windows needs no special rights; elsewhere a plain folder link.
      await symlink(from, to, process.platform === "win32" ? "junction" : "dir").then(
        () => made.push(to),
        () => undefined,
      );
    }
    if (depth >= 2) return;
    const entries = await readdir(join(source, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") await visit(join(rel, e.name), depth + 1);
  };
  await visit("", 0);
  return async () => {
    // Only the link goes, never what it points to (rm on a link removes the link itself).
    for (const p of made) await rm(p, { force: true }).catch(() => undefined);
  };
}

/**
 * The `run_tests` tool of a build sub-agent: runs one of the project's checks in its copy and returns the result.
 *
 * @param copy - The sub-agent's copy of the project.
 * @param source - The user's project folder (for its installed packages), when known.
 * @param onResult - Each run's result, for the line under its report.
 */
export function runTestsTool(copy: string, source: string | undefined, onResult?: (r: { ok: boolean; command: string }) => void): AgentTool {
  const checkOf = (input: Record<string, unknown>): CheckName => (input.check === "typecheck" || input.check === "lint" ? input.check : "test");
  return {
    risk: "exec",
    spec: {
      name: "run_tests",
      description:
        "Run the project's own tests (or its typecheck or lint script) in your copy of the project, and get the result. Run it after your change and say in your report whether it passed. You cannot choose the command: it is the project's script.",
      inputSchema: {
        type: "object",
        properties: {
          check: { type: "string", enum: ["test", "typecheck", "lint"], description: "Which check (default test)." },
          purpose: { type: "string", description: "One short sentence for the user: why you run it now." },
        },
      },
    },
    commandOf: () => undefined,
    preview: async (input) => {
      const c = await checkCommand(copy, checkOf(input));
      if (!c) throw new Error(`This project has no ${checkOf(input)} script.`);
      return c.command;
    },
    async run(input, ctx) {
      const check = checkOf(input);
      const c = await checkCommand(copy, check);
      if (!c) throw new Error(`This project has no ${check} script (package.json scripts, Cargo.toml, go.mod or pytest).`);
      const unlink = source ? await linkDependencies(copy, source) : async () => undefined;
      try {
        const r = await runShell(c.command, copy, CHECK_MS, ctx.signal, ctx.progress, ctx.env);
        const ok = r.code === 0;
        onResult?.({ ok, command: c.command });
        const out = r.output.trim();
        return { output: `${ok ? "PASSED" : "FAILED"}: ${c.command}\n${out.length > OUTPUT_CHARS ? `…${out.slice(-OUTPUT_CHARS)}` : out || "(no output)"}\n\n${r.status}` };
      } finally {
        await unlink();
      }
    },
  };
}
