import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentTool, ToolContext } from "./tools.js";
import { MAX_OUTPUT, runShell } from "./shell.js";
import { resolveForTool } from "./workspace.js";

/**
 * Tools that reach beyond the project folder: what is installed on this
 * computer, installing developer tools, and the web.
 */

/** Developer tools the agent can check and install, with each platform's package id. */
export const INSTALLABLE: Record<string, { label: string; check: string; winget?: string; brew?: string; apt?: string }> = {
  python: { label: "Python 3", check: process.platform === "win32" ? "py -3 --version" : "python3 --version", winget: "Python.Python.3.12", brew: "python@3.12", apt: "python3 python3-pip python3-venv" },
  java: { label: "Java (OpenJDK 21)", check: "java -version", winget: "Microsoft.OpenJDK.21", brew: "openjdk@21", apt: "openjdk-21-jdk" },
  node: { label: "Node.js LTS", check: "node --version", winget: "OpenJS.NodeJS.LTS", brew: "node", apt: "nodejs npm" },
  git: { label: "Git", check: "git --version", winget: "Git.Git", brew: "git", apt: "git" },
  dotnet: { label: ".NET SDK 8", check: "dotnet --version", winget: "Microsoft.DotNet.SDK.8", brew: "dotnet", apt: "dotnet-sdk-8.0" },
  cmake: { label: "CMake", check: "cmake --version", winget: "Kitware.CMake", brew: "cmake", apt: "cmake" },
  go: { label: "Go", check: "go version", winget: "GoLang.Go", brew: "go", apt: "golang" },
  rust: { label: "Rust (rustup)", check: "rustc --version", winget: "Rustlang.Rustup", brew: "rustup", apt: "rustup" },
  github: { label: "GitHub CLI", check: "gh --version", winget: "GitHub.cli", brew: "gh", apt: "gh" },
  ffmpeg: { label: "FFmpeg", check: "ffmpeg -version", winget: "Gyan.FFmpeg", brew: "ffmpeg", apt: "ffmpeg" },
  vscode: { label: "Visual Studio Code", check: "code --version", winget: "Microsoft.VisualStudioCode", brew: "--cask visual-studio-code" },
};

/**
 * The command that installs a tool on this platform.
 *
 * @param name - Key of {@link INSTALLABLE}.
 * @param platform - `process.platform`.
 * @returns The command line, or `undefined` if there is no package for this platform.
 */
export function installCommand(name: string, platform = process.platform): string | undefined {
  const t = INSTALLABLE[name];
  if (!t) return undefined;
  if (platform === "win32" && t.winget) return `winget install --id ${t.winget} -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity`;
  if (platform === "darwin" && t.brew) return `brew install ${t.brew}`;
  if (platform === "linux" && t.apt) return `sudo apt-get install -y ${t.apt}`;
  return undefined;
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";

export const checkToolsTool: AgentTool = {
  risk: "read",
  spec: {
    name: "check_tools",
    description:
      "Check which developer tools are installed on this computer and their versions: python, java, node, git, dotnet, cmake, go, rust, github (gh), ffmpeg, vscode. Use it before building or running code that needs one.",
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Which to check. Default: all." } } },
  },
  async run(input, ctx) {
    const names = Array.isArray(input.names) && input.names.length ? input.names.map(String) : Object.keys(INSTALLABLE);
    const cwd = ctx.workspace ?? process.cwd();
    const lines = await Promise.all(
      names.map(async (n) => {
        const t = INSTALLABLE[n];
        if (!t) return `${n}: unknown (known: ${Object.keys(INSTALLABLE).join(", ")})`;
        const r = await runShell(t.check, cwd, 15_000, ctx.signal);
        return r.code === 0 && !/is not recognized|not found|Microsoft Store/i.test(r.output) ? `${n}: ${firstLine(r.output)}` : `${n}: not installed`;
      }),
    );
    return { output: `${lines.join("\n")}\n\nTo install one, call install_tool.` };
  },
};

export const installToolTool: AgentTool = {
  risk: "exec",
  spec: {
    name: "install_tool",
    description:
      "Install a developer tool on this computer with the system's package manager (winget on Windows, Homebrew on macOS, apt on Linux): python, java, node, git, dotnet, cmake, go, rust, github, ffmpeg, vscode. The user approves first. After installing, a new terminal may be needed before the command is found; check with check_tools.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: Object.keys(INSTALLABLE), description: "Which tool." } },
      required: ["name"],
    },
  },
  commandOf: (input) => installCommand(String(input.name ?? "")),
  async preview(input) {
    const name = String(input.name ?? "");
    const cmd = installCommand(name);
    if (!cmd) throw new Error(`There is no ${name} package for this system. Known: ${Object.keys(INSTALLABLE).join(", ")}.`);
    return `Install ${INSTALLABLE[name]!.label}:\n${cmd}`;
  },
  async run(input, ctx) {
    const name = String(input.name ?? "");
    const cmd = installCommand(name);
    if (!cmd) throw new Error(`There is no ${name} package for this system.`);
    const r = await runShell(cmd, ctx.workspace ?? process.cwd(), 1_200_000, ctx.signal);
    const tail = r.output.trim().split(/\r?\n/).slice(-15).join("\n");
    // winget answers "already installed" with a non-zero code.
    if (r.code !== 0 && !/already installed|No newer package/i.test(r.output)) throw new Error(`Installing ${name} failed:\n${tail}\n${r.status}`);
    const check = await runShell(INSTALLABLE[name]!.check, ctx.workspace ?? process.cwd(), 15_000, ctx.signal);
    return {
      output: `${tail}\n\n${check.code === 0 ? `Installed: ${firstLine(check.output)}` : "Installed, but this session cannot find it yet. Tell the user to restart KesherAI so the new PATH applies, or use the tool's full path."}`,
    };
  },
};

/** Turns an HTML page into readable text: no scripts, styles, menus or tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function checkUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links can be opened.");
  // Never reach this computer's own services or the home network from a web tool.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) {
    throw new Error("web_fetch only opens public web pages, not addresses on this computer or the home network.");
  }
  return url;
}

export const webFetchTool: AgentTool = {
  risk: "read",
  spec: {
    name: "web_fetch",
    description: "Open a public web page and read its text (documentation, articles, README files, API references). Returns plain text without menus and scripts.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The https:// address." } }, required: ["url"] },
  },
  async run(input, ctx) {
    const url = checkUrl(String(input.url ?? ""));
    const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]), headers: { "user-agent": "KesherAI (+https://github.com/Deadchu-R/KesherAI)" } });
    if (!res.ok) throw new Error(`The page answered ${res.status} ${res.statusText}.`);
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = /html/i.test(type) ? htmlToText(body) : body;
    return { output: `${res.url}\n\n${text.slice(0, MAX_OUTPUT)}` };
  },
};

/**
 * Reads DuckDuckGo's plain HTML results page (no API key needed).
 *
 * @param html - The results page.
 * @returns Title, link and snippet of each result.
 */
export function parseSearchResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  links.slice(0, 10).forEach((m, i) => {
    let href = m[1]!.replace(/&amp;/g, "&");
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    // The snippet sits between this result's link and the next one.
    const rest = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(rest)?.[1] ?? "";
    out.push({ title: htmlToText(m[2] ?? ""), url: href, snippet: htmlToText(snippet) });
  });
  return out;
}

export const webSearchTool: AgentTool = {
  risk: "read",
  spec: {
    name: "web_search",
    description: "Search the web (DuckDuckGo) for documentation, error messages, libraries or current information. Returns titles, links and snippets; open a result with web_fetch.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  async run(input, ctx) {
    const q = String(input.query ?? "").trim();
    if (!q) throw new Error("Give a search query.");
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
      headers: { "user-agent": "Mozilla/5.0 (KesherAI)" },
    });
    if (!res.ok) throw new Error(`Search answered ${res.status}.`);
    const results = parseSearchResults(await res.text());
    if (!results.length) return { output: "No results." };
    return { output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n") };
  },
};

export const downloadFileTool: AgentTool = {
  risk: "write",
  spec: {
    name: "download_file",
    description: "Download a file from the web into the project folder (an image, a dataset, a library file, an installer the user asked for). Do not run what you download without asking.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, path: { type: "string", description: "Where to save it, relative to the project folder." } },
      required: ["url", "path"],
    },
  },
  async preview(input) {
    return `Download ${String(input.url ?? "")}\n→ ${String(input.path ?? "")}`;
  },
  async run(input, ctx: ToolContext) {
    const url = checkUrl(String(input.url ?? ""));
    const dest = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], String(input.path ?? ""));
    const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(600_000)]) });
    if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} ${res.statusText}.`);
    await mkdir(dirname(dest), { recursive: true });
    ctx.recordChange(dest, null);
    let bytes = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (c: Buffer) => {
      bytes += c.length;
    });
    await pipeline(body, createWriteStream(dest));
    return { output: `Saved ${(bytes / 1024 ** 2).toFixed(2)} MB to ${String(input.path ?? "")}.` };
  },
};

/** Tools for the computer and the web, added to every conversation. */
export const SYSTEM_TOOLS: readonly AgentTool[] = [checkToolsTool, installToolTool, webSearchTool, webFetchTool, downloadFileTool];
