/**
 * The code editors on this computer (asked for: "connect to the IDEs I have and see code their way in a small
 * panel"). Like Cursor's "Import from VS Code" (researched: it imports extensions, themes, settings, keybindings):
 * KesherAI finds VS Code, Cursor, Antigravity, Rider and Visual Studio, reads the look of the one the person
 * picks (its color theme and font) for KesherAI's code panels, and opens a file at a line in it.
 *
 * Only reads the editors' own settings and theme files; never changes them.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** One editor found here. */
export interface Ide {
  id: "vscode" | "cursor" | "antigravity" | "rider" | "visualstudio";
  name: string;
  /** Its program. */
  exe: string;
  /** VS Code-like: its user settings folder; Rider: its config folder. */
  config?: string;
}

/** An editor's look, for KesherAI's code panels (Monaco). */
export interface IdeStyle {
  ide: Ide["id"];
  /** The theme's name as the editor calls it. */
  themeName?: string;
  /** A Monaco theme: base, token rules, editor colors. */
  theme?: { base: "vs" | "vs-dark" | "hc-black" | "hc-light"; inherit: boolean; rules: Array<{ token: string; foreground?: string; fontStyle?: string }>; colors: Record<string, string> };
  fontFamily?: string;
  fontSize?: number;
  ligatures?: boolean;
  lineHeight?: number;
  tabSize?: number;
  minimap?: boolean;
}

const env = (k: string) => process.env[k] ?? "";
const win = () => platform() === "win32";

/** The VS Code family: where each keeps its program, settings and extensions. */
function vscodeLike(): Array<{ id: "vscode" | "cursor" | "antigravity"; name: string; exes: string[]; user: string; extensions: string }> {
  const home = homedir();
  const appdata = win() ? env("APPDATA") : platform() === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  const local = env("LOCALAPPDATA");
  return [
    { id: "vscode", name: "VS Code", exes: win() ? [join(local, "Programs", "Microsoft VS Code", "Code.exe"), "C:\\Program Files\\Microsoft VS Code\\Code.exe"] : ["/usr/bin/code", "/usr/share/code/code", "/snap/bin/code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"], user: join(appdata, "Code", "User"), extensions: join(home, ".vscode", "extensions") },
    { id: "cursor", name: "Cursor", exes: win() ? [join(local, "Programs", "cursor", "Cursor.exe")] : ["/usr/bin/cursor", "/opt/Cursor/cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"], user: join(appdata, "Cursor", "User"), extensions: join(home, ".cursor", "extensions") },
    { id: "antigravity", name: "Antigravity", exes: win() ? [join(local, "Programs", "antigravity", "Antigravity.exe")] : ["/usr/bin/antigravity", "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity"], user: join(appdata, "Antigravity", "User"), extensions: join(home, ".antigravity", "extensions") },
  ];
}

async function riderInstalls(): Promise<Array<{ exe: string; config?: string }>> {
  const out: Array<{ exe: string; config?: string }> = [];
  const home = homedir();
  const roots = win() ? [join(env("LOCALAPPDATA"), "Programs"), "C:\\Program Files\\JetBrains"] : [join(home, ".local", "share", "JetBrains", "Toolbox", "apps"), "/opt"];
  for (const root of roots) {
    for (const d of await readdir(root).catch(() => [] as string[])) {
      if (!/rider/i.test(d)) continue;
      const exe = win() ? join(root, d, "bin", "rider64.exe") : join(root, d, "bin", "rider.sh");
      if (existsSync(exe)) out.push({ exe });
    }
  }
  // Its settings: the newest RiderYYYY.N folder.
  const cfgRoot = win() ? join(env("APPDATA"), "JetBrains") : join(home, ".config", "JetBrains");
  const cfg = (await readdir(cfgRoot).catch(() => [] as string[])).filter((d) => /^Rider\d{4}\.\d/.test(d)).sort().pop();
  return out.map((o) => ({ ...o, ...(cfg ? { config: join(cfgRoot, cfg) } : {}) }));
}

function visualStudio(): Promise<string | undefined> {
  if (!win()) return Promise.resolve(undefined);
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (!existsSync(vswhere)) return Promise.resolve(undefined);
  return new Promise((done) => {
    execFile(vswhere, ["-latest", "-property", "productPath"], { windowsHide: true, timeout: 10_000 }, (err, out) => done(!err && String(out).trim() && existsSync(String(out).trim()) ? String(out).trim() : undefined));
  });
}

/** The editors on this computer. */
export async function findIdes(): Promise<Ide[]> {
  const out: Ide[] = [];
  for (const v of vscodeLike()) {
    const exe = v.exes.find((e) => existsSync(e));
    if (exe) out.push({ id: v.id, name: v.name, exe, config: v.user });
  }
  const rider = (await riderInstalls())[0];
  if (rider) out.push({ id: "rider", name: "Rider", exe: rider.exe, ...(rider.config ? { config: rider.config } : {}) });
  const vs = await visualStudio();
  if (vs) out.push({ id: "visualstudio", name: "Visual Studio", exe: vs });
  return out;
}

/** JSON with comments and trailing commas (VS Code's settings and themes). */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const hex = (c: unknown): string | undefined => (typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c.replace(/^#/, "") : undefined);

/** A TextMate scope (VS Code themes) as the token Monaco's C#/JS/TS grammars use. */
function monacoToken(scope: string): string | undefined {
  const s = scope.trim();
  if (/^comment/.test(s)) return "comment";
  if (/^string/.test(s)) return "string";
  if (/^constant\.numeric/.test(s)) return "number";
  if (/^(keyword|storage\.modifier|storage\.type(?!\.(class|struct|interface|enum))|keyword\.control)/.test(s)) return "keyword";
  if (/^(entity\.name\.(type|class)|support\.(type|class)|storage\.type\.(class|struct))/.test(s)) return "type";
  if (/^entity\.name\.function|^support\.function/.test(s)) return "identifier.function";
  if (/^(variable|support\.variable)/.test(s)) return "identifier";
  if (/^constant\.(language|character)/.test(s)) return "keyword";
  if (/^(keyword\.operator|punctuation)/.test(s)) return "delimiter";
  if (/^(entity\.name\.tag|meta\.attribute)/.test(s)) return "annotation";
  return undefined;
}

/**
 * A VS Code theme file as a Monaco theme (follows "include" to its parent theme).
 *
 * @param file - The theme's JSON.
 */
export async function vscodeThemeToMonaco(file: string, depth = 0, root = dirname(dirname(file))): Promise<NonNullable<IdeStyle["theme"]>> {
  const j = parseJsonc(await readFile(file, "utf8")) as { type?: string; include?: string; colors?: Record<string, string>; tokenColors?: Array<{ scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string } }> | string };
  // The parent theme: only inside the theme's own extension (an "include" never reads elsewhere on the computer).
  const inc = j.include ? resolve(dirname(file), j.include) : "";
  const inside = inc && !relative(root, inc).startsWith("..") && !isAbsolute(relative(root, inc));
  const parent = inside && depth < 4 ? await vscodeThemeToMonaco(inc, depth + 1, root).catch(() => undefined) : undefined;
  const rules = [...(parent?.rules ?? [])];
  const tokenColors = Array.isArray(j.tokenColors) ? j.tokenColors : [];
  for (const t of tokenColors) {
    const scopes = Array.isArray(t.scope) ? t.scope : String(t.scope ?? "").split(",");
    for (const sc of scopes) {
      const token = monacoToken(sc);
      const fg = hex(t.settings?.foreground);
      const style = typeof t.settings?.fontStyle === "string" && /^[a-z ]{1,40}$/.test(t.settings.fontStyle) ? t.settings.fontStyle : undefined;
      if (token && (fg || style)) rules.push({ token, ...(fg ? { foreground: fg } : {}), ...(style ? { fontStyle: style } : {}) });
    }
  }
  const colors: Record<string, string> = { ...(parent?.colors ?? {}) };
  for (const k of ["editor.background", "editor.foreground", "editorLineNumber.foreground", "editorLineNumber.activeForeground", "editor.selectionBackground", "editor.lineHighlightBackground", "editorCursor.foreground", "editorIndentGuide.background", "editorWhitespace.foreground"]) {
    const v = j.colors?.[k];
    if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) colors[k] = v;
  }
  const kind = j.type ?? (parent?.base === "vs" ? "light" : parent?.base === "hc-black" ? "hc" : parent?.base === "hc-light" ? "hcLight" : "dark");
  const base = kind === "light" ? "vs" : kind === "hc" ? "hc-black" : kind === "hcLight" ? "hc-light" : "vs-dark";
  return { base, inherit: true, rules, colors };
}

/**
 * The folders of an editor's own (built-in) extensions: next to the program, or, in newer VS Code builds, inside a
 * version folder next to it ("Microsoft VS Code\\<version>\\resources\\app\\extensions").
 */
async function builtInExtensions(exe: string): Promise<string[]> {
  const base = dirname(exe);
  const out = [join(base, "resources", "app", "extensions")];
  // On Linux and macOS the program is often a script in bin/: the app is one folder up.
  out.push(join(base, "..", "resources", "app", "extensions"), join(base, "..", "app", "extensions"));
  for (const d of await readdir(base).catch(() => [] as string[])) out.push(join(base, d, "resources", "app", "extensions"));
  return out.filter((d) => existsSync(d));
}

/** Finds a VS Code theme by its label among the extensions folder and the editor's built-in themes. */
async function findThemeFile(name: string, folders: string[]): Promise<{ file: string; ui?: string } | undefined> {
  for (const folder of folders) {
    for (const ext of await readdir(folder).catch(() => [] as string[])) {
      const pkg = await readFile(join(folder, ext, "package.json"), "utf8").catch(() => "");
      if (!pkg.includes('"themes"')) continue;
      try {
        const themes = (JSON.parse(pkg) as { contributes?: { themes?: Array<{ label?: string; id?: string; path?: string; uiTheme?: string }> } }).contributes?.themes ?? [];
        // Built-in theme labels are "%…%" placeholders: the id (or the file name) matches the setting's name then.
        const t = themes.find((x) => x.label === name || x.id === name || (x.path && x.path.toLowerCase().includes(name.toLowerCase().replace(/\s+/g, "_").replace(/[()]/g, ""))));
        if (t?.path) return { file: join(folder, ext, t.path), ...(t.uiTheme ? { ui: t.uiTheme } : {}) };
      } catch {
        /* a broken package.json */
      }
    }
  }
  return undefined;
}

/** Rider's look: its color scheme (.icls) and font. */
async function riderStyle(config: string): Promise<IdeStyle> {
  const style: IdeStyle = { ide: "rider" };
  const opts = join(config, "options");
  const schemeXml = await readFile(join(opts, "colors.scheme.xml"), "utf8").catch(() => "");
  const name = /global_color_scheme name="([^"]+)"/.exec(schemeXml)?.[1];
  // A name from the settings file goes into a path: its last part only.
  const scheme = name ? basename(name.replace(/^_@user_/, "")) : "";
  if (scheme) style.themeName = scheme;
  const fontXml = await readFile(join(opts, "editor-font.xml"), "utf8").catch(() => "");
  const family = /name="FONT_FAMILY" value="([^"]+)"/.exec(fontXml)?.[1];
  const size = /name="FONT_SIZE" value="(\d+)"/.exec(fontXml)?.[1];
  if (family) style.fontFamily = family;
  if (size) style.fontSize = Number(size);
  // A scheme of the person's own: its colors. Rider's built-in dark and light: their well-known colors.
  const file = scheme ? join(config, "colors", `${scheme}.icls`) : "";
  const icls = file ? await readFile(file, "utf8").catch(() => "") : "";
  const dark = !/light|intellij light/i.test(name ?? "") && !/parent_scheme="Default"/.test(icls);
  const attr = (key: string) => hex(`#${new RegExp(`<option name="${key}">[\\s\\S]*?FOREGROUND" value="([0-9a-fA-F]{6})"`).exec(icls)?.[1] ?? ""}`);
  const rules: NonNullable<IdeStyle["theme"]>["rules"] = dark
    ? [{ token: "keyword", foreground: "6C95EB" }, { token: "string", foreground: "C9A26D" }, { token: "number", foreground: "ED94C0" }, { token: "comment", foreground: "85C46C", fontStyle: "italic" }, { token: "type", foreground: "C191FF" }, { token: "identifier.function", foreground: "39CC9B" }]
    : [{ token: "keyword", foreground: "0000E6" }, { token: "string", foreground: "A55A00" }, { token: "number", foreground: "0000FF" }, { token: "comment", foreground: "008000", fontStyle: "italic" }, { token: "type", foreground: "6F3DBD" }];
  for (const [key, token] of [["DEFAULT_KEYWORD", "keyword"], ["DEFAULT_STRING", "string"], ["DEFAULT_NUMBER", "number"], ["DEFAULT_LINE_COMMENT", "comment"], ["DEFAULT_CLASS_NAME", "type"], ["DEFAULT_FUNCTION_DECLARATION", "identifier.function"]] as const) {
    const fg = attr(key);
    if (fg) rules.push({ token, foreground: fg });
  }
  const bg = /<option name="TEXT">[\s\S]*?BACKGROUND" value="([0-9a-fA-F]{6})"/.exec(icls)?.[1];
  style.theme = { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors: { "editor.background": `#${bg ?? (dark ? "262626" : "FFFFFF")}`, "editor.foreground": dark ? "#BDBDBD" : "#000000" } };
  return style;
}

/**
 * An editor's look for KesherAI's code panels.
 *
 * @param ide - One of findIdes().
 */
export async function ideStyle(ide: Ide): Promise<IdeStyle> {
  if (ide.id === "rider") return ide.config ? riderStyle(ide.config) : { ide: "rider" };
  if (ide.id === "visualstudio") return { ide: "visualstudio", themeName: "Visual Studio Dark", fontFamily: "Cascadia Mono, Consolas", fontSize: 13, theme: { base: "vs-dark", inherit: true, rules: [{ token: "keyword", foreground: "569CD6" }, { token: "string", foreground: "D69D85" }, { token: "comment", foreground: "57A64A" }, { token: "type", foreground: "4EC9B0" }, { token: "number", foreground: "B5CEA8" }], colors: { "editor.background": "#1E1E1E" } } };
  const style: IdeStyle = { ide: ide.id };
  const settings = (ide.config ? await readFile(join(ide.config, "settings.json"), "utf8").then(parseJsonc, () => ({})) : {}) as Record<string, unknown>;
  const theme = typeof settings["workbench.colorTheme"] === "string" ? (settings["workbench.colorTheme"] as string) : "Default Dark Modern";
  style.themeName = theme;
  if (typeof settings["editor.fontFamily"] === "string") style.fontFamily = settings["editor.fontFamily"] as string;
  if (typeof settings["editor.fontSize"] === "number") style.fontSize = settings["editor.fontSize"] as number;
  if (typeof settings["editor.fontLigatures"] === "boolean") style.ligatures = settings["editor.fontLigatures"] as boolean;
  if (typeof settings["editor.lineHeight"] === "number") style.lineHeight = settings["editor.lineHeight"] as number;
  if (typeof settings["editor.tabSize"] === "number") style.tabSize = settings["editor.tabSize"] as number;
  if (typeof settings["editor.minimap.enabled"] === "boolean") style.minimap = settings["editor.minimap.enabled"] as boolean;
  // The editor's defaults when the person set none (what they see in it).
  style.fontFamily ??= platform() === "win32" ? "Consolas, 'Courier New', monospace" : platform() === "darwin" ? "Menlo, Monaco, 'Courier New', monospace" : "'Droid Sans Mono', 'monospace', monospace";
  style.fontSize ??= platform() === "darwin" ? 12 : 14;
  const v = vscodeLike().find((x) => x.id === ide.id)!;
  const file = await findThemeFile(theme, [v.extensions, ...(await builtInExtensions(ide.exe))]);
  const read = file ? await vscodeThemeToMonaco(file.file).catch(() => undefined) : undefined;
  // The extension says dark, light or high contrast ("uiTheme"); the theme file often does not.
  if (read && file?.ui && ["vs", "vs-dark", "hc-black", "hc-light"].includes(file.ui)) read.base = file.ui as NonNullable<IdeStyle["theme"]>["base"];
  if (read) style.theme = read;
  else {
    // A built-in theme not found on disk: its base, so the panel is at least dark, light or high-contrast like the editor.
    const hc = /high contrast/i.test(theme);
    const light = /light/i.test(theme);
    style.theme = { base: hc ? (light ? "hc-light" : "hc-black") : light ? "vs" : "vs-dark", inherit: true, rules: [], colors: hc || light ? {} : { "editor.background": "#1F1F1F" } };
  }
  return style;
}

/**
 * Opens a file at a line in an editor (its own window; nothing is changed).
 *
 * @param file - An absolute path.
 */
export function openInIde(ide: Ide, file: string, line = 1): void {
  const l = Math.max(1, Math.floor(line));
  const args =
    ide.id === "rider" ? ["--line", String(l), file]
    : ide.id === "visualstudio" ? ["/Edit", file]
    : ["-g", `${file}:${l}`];
  const p = spawn(ide.exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  p.on("error", () => undefined);
  p.unref();
}
