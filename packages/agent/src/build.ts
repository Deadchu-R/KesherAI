import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AgentTool, ToolContext } from "./tools.js";
import { refreshPath, runShell, type ShellResult } from "./shell.js";
import { installCommand } from "./system-tools.js";
import { readdir } from "node:fs/promises";
import { resolveInWorkspace } from "./workspace.js";

/**
 * `build_executable`: turns a Python program into one file the user can run
 * without Python: a `.exe` on Windows (a plain executable on macOS and Linux).
 * It uses PyInstaller, installing it for the user with pip the first time.
 * The result goes to `dist/` in the workspace, where the Files panel offers
 * it for download.
 */

const TEN_MINUTES = 600_000;

/** Finds a working Python 3. The Windows Store "python" stub fails `--version`, so it is skipped. */
async function findPython(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const candidates = process.platform === "win32" ? ["py -3", "python", "python3"] : ["python3", "python"];
  // Python installed by winget or python.org lives here even before PATH is updated.
  if (process.platform === "win32") {
    for (const base of [join(process.env.LOCALAPPDATA ?? "", "Programs", "Python"), process.env.ProgramFiles ?? "C:\\Program Files"]) {
      const dirs = await readdir(base).catch(() => [] as string[]);
      for (const d of dirs.filter((x) => /^Python3\d+/i.test(x)).sort().reverse()) candidates.push(`"${join(base, d, "python.exe")}"`);
    }
  }
  for (const c of candidates) {
    const r = await runShell(`${c} --version`, cwd, 15_000, signal);
    if (r.code === 0 && /Python 3\./.test(r.output)) return c;
  }
  return undefined;
}

/** Finds Python, installing it first (winget / Homebrew / apt) when it is missing. */
async function ensurePython(cwd: string, signal: AbortSignal): Promise<string> {
  let py = await findPython(cwd, signal);
  if (py) return py;
  await refreshPath();
  py = await findPython(cwd, signal);
  if (py) return py;
  const cmd = installCommand("python");
  if (cmd) {
    const r = await runShell(cmd, cwd, 1_200_000, signal);
    await refreshPath();
    py = await findPython(cwd, signal);
    if (py) return py;
    throw new Error(`Python could not be installed automatically:\n${tail(r)}`);
  }
  throw new Error("Python 3 is not installed and there is no package manager to install it. Install Python from https://www.python.org/downloads/ and try again.");
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** Keeps the last lines of a long build log, where the errors are. */
function tail(r: ShellResult, lines = 40): string {
  return `${r.output.trim().split(/\r?\n/).slice(-lines).join("\n")}\n${r.status}`;
}

export const buildExecutableTool: AgentTool = {
  risk: "exec",
  spec: {
    name: "build_executable",
    description:
      "Package a Python program in the project folder into a single file the user can run without installing Python (a .exe on Windows). Use it when the user asks for a program, app, tool or .exe they can run or install. Write and test the .py file first. The result is saved in dist/ and the user can download it from the Files panel.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "The main .py file, relative to the project folder, e.g. calculator.py." },
        name: { type: "string", description: "Name of the program, e.g. Calculator. Defaults to the file name." },
        windowed: { type: "boolean", description: "true for a program with a window (tkinter, PyQt): no black console window. false for a command-line program. Default true." },
      },
      required: ["entry"],
    },
  },
  commandOf: (input) => `pyinstaller --onefile ${String(input.entry ?? "")}`,
  async preview(input) {
    const name = safeName(String(input.name ?? basename(String(input.entry ?? "app"), extname(String(input.entry ?? "")))));
    return [
      `Build ${name}${process.platform === "win32" ? ".exe" : ""} from ${String(input.entry ?? "")} with PyInstaller.`,
      "If Python is missing, it is installed first (winget on Windows); if PyInstaller is missing, it is installed for your user only.",
      `The result goes to dist/ in the project folder.`,
    ].join("\n");
  },
  async run(input, ctx: ToolContext) {
    if (!ctx.workspace) throw new Error("This conversation has no folder to build in.");
    const cwd = ctx.workspace;
    const entry = String(input.entry ?? "");
    if (!entry.toLowerCase().endsWith(".py")) {
      throw new Error("build_executable packages Python programs (.py). For other languages, use run_command with that language's own build tool.");
    }
    const entryPath = await resolveInWorkspace(cwd, entry);
    if (!existsSync(entryPath)) throw new Error(`${entry} does not exist. Write it first with write_file.`);
    const name = safeName(String(input.name ?? basename(entry, ".py")));
    const windowed = input.windowed !== false;

    const py = await ensurePython(cwd, ctx.signal);
    const has = await runShell(`${py} -m PyInstaller --version`, cwd, 30_000, ctx.signal);
    if (has.code !== 0) {
      const install = await runShell(`${py} -m pip install --user --disable-pip-version-check pyinstaller`, cwd, TEN_MINUTES, ctx.signal);
      if (install.code !== 0) throw new Error(`Installing PyInstaller failed:\n${tail(install)}`);
    }
    const args = [
      "-m PyInstaller --noconfirm --clean --onefile",
      windowed ? "--windowed" : "",
      `--name "${name}"`,
      `--distpath "dist" --workpath "${join("build", "pyinstaller")}" --specpath "build"`,
      `"${entryPath}"`,
    ].filter(Boolean);
    const built = await runShell(`${py} ${args.join(" ")}`, cwd, TEN_MINUTES, ctx.signal);
    const file = join("dist", process.platform === "win32" ? `${name}.exe` : name);
    if (built.code !== 0 || !existsSync(join(cwd, file))) throw new Error(`The build failed:\n${tail(built)}`);
    return {
      output: `Built ${file.replace(/\\/g, "/")}. Tell the user it is ready to download from the Files panel of this conversation (or to run from the dist folder).`,
    };
  },
};
