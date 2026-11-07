import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, normalize, relative, sep } from "node:path";

/**
 * Finds model files other apps already downloaded, so KesherAI can use them
 * in place instead of downloading them again.
 *
 * Nothing is copied or moved: KesherAI only reads these folders, and the
 * user decides which ones to add.
 */

/** A folder some app keeps models in. */
export interface ModelFolder {
  /** Absolute path. */
  folder: string;
  /** Which app it belongs to, e.g. `LM Studio`, or `Folder` for one the user added. */
  source: string;
}

/** A model file found on disk. */
export interface FoundModel {
  path: string;
  /** Display name, e.g. `Qwen3-8B-Q4_K_M.gguf` or `llama3.2:3b` for Ollama. */
  name: string;
  size: number;
  source: string;
  /** Folder it was found in. */
  folder: string;
  /** `gguf` files load in the built-in engine; others are for ComfyUI and similar. */
  format: "gguf" | "safetensors" | "other";
}

/** Model weights KesherAI recognises. Pickle formats are listed but marked `other`. */
const WEIGHTS = /\.(gguf|safetensors|ckpt|pt|pth|bin|onnx)$/i;
/** Smaller files are configs, tokenizers or vision projectors, not models. */
const MIN_SIZE = 50 * 1024 ** 2;
const SKIP = new Set(["node_modules", ".git", "__pycache__", "venv", ".venv", "site-packages"]);

/**
 * Folders where well-known apps keep their models on this computer.
 *
 * @param home - Home folder (tests pass a temp folder).
 * @param env - Environment (for `HF_HOME`, `APPDATA`, `LOCALAPPDATA`, `OLLAMA_MODELS`).
 * @returns Candidates; they may not exist.
 */
export function knownModelFolders(home = homedir(), env: NodeJS.ProcessEnv = process.env): ModelFolder[] {
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    { folder: join(home, ".lmstudio", "models"), source: "LM Studio" },
    { folder: join(home, ".cache", "lm-studio", "models"), source: "LM Studio" },
    { folder: env.OLLAMA_MODELS ?? join(home, ".ollama", "models"), source: "Ollama" },
    { folder: join(env.HF_HOME ?? join(home, ".cache", "huggingface"), "hub"), source: "Hugging Face" },
    { folder: join(home, "jan", "models"), source: "Jan" },
    { folder: join(appData, "Jan", "data", "models"), source: "Jan" },
    { folder: join(localAppData, "nomic.ai", "GPT4All"), source: "GPT4All" },
    { folder: join(home, "Library", "Application Support", "nomic.ai", "GPT4All"), source: "GPT4All" },
    { folder: join(home, "ComfyUI", "models"), source: "ComfyUI" },
    { folder: join(home, "Documents", "ComfyUI", "models"), source: "ComfyUI" },
  ];
}

async function isGguf(path: string): Promise<boolean> {
  const fh = await open(path, "r").catch(() => undefined);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.toString("latin1") === "GGUF";
  } finally {
    await fh.close();
  }
}

/**
 * Checks whether a file is a GGUF model by its first bytes, so files without
 * the extension (like Ollama's blobs) still load.
 *
 * @param path - File path.
 * @returns True for GGUF.
 */
export async function looksLikeGguf(path: string): Promise<boolean> {
  return path.toLowerCase().endsWith(".gguf") || isGguf(path);
}

/** Ollama keeps weights as `blobs/sha256-…` and names them in `manifests/…`. */
async function scanOllama(folder: string): Promise<FoundModel[]> {
  const found: FoundModel[] = [];
  const walk = async (dir: string, parts: string[]): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, [...parts, e.name]);
        continue;
      }
      try {
        const manifest = JSON.parse(await readFile(full, "utf8")) as { layers?: Array<{ mediaType?: string; digest?: string; size?: number }> };
        const layer = manifest.layers?.find((l) => l.mediaType === "application/vnd.ollama.image.model");
        if (!layer?.digest) continue;
        const blob = join(folder, "blobs", layer.digest.replace(":", "-"));
        const size = (await stat(blob).catch(() => undefined))?.size;
        if (!size) continue;
        // manifests/registry.ollama.ai/library/llama3.2/3b → llama3.2:3b; other namespaces keep their prefix.
        const [, ns, ...rest] = parts;
        const model = ns === "library" ? rest.join("/") : [ns, ...rest].join("/");
        found.push({ path: blob, name: `${model}:${e.name}`, size, source: "Ollama", folder, format: "gguf" });
      } catch {
        // not a manifest
      }
    }
  };
  await walk(join(folder, "manifests"), []);
  return found;
}

/**
 * Lists model files in one folder (and its sub-folders, up to a few levels).
 *
 * @param f - Folder and its source.
 * @param depth - How deep to look.
 * @returns Models found; an empty list if the folder does not exist.
 */
export async function scanFolder(f: ModelFolder, depth = 7): Promise<FoundModel[]> {
  if (f.source === "Ollama" || (await stat(join(f.folder, "manifests")).catch(() => undefined))?.isDirectory()) {
    const ollama = await scanOllama(f.folder);
    if (ollama.length) return ollama.map((m) => ({ ...m, source: f.source }));
  }
  const found: FoundModel[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, level + 1);
      else if ((e.isFile() || e.isSymbolicLink()) && WEIGHTS.test(e.name) && !e.name.endsWith(".part")) {
        const size = (await stat(full).catch(() => undefined))?.size ?? 0;
        // Vision projectors (mmproj) are needed beside a model but are not models themselves.
        if (size < MIN_SIZE || /mmproj/i.test(e.name)) continue;
        const ext = e.name.split(".").pop()!.toLowerCase();
        found.push({
          path: full,
          name: f.source === "Hugging Face" ? hfName(f.folder, full) : basename(full),
          size,
          source: f.source,
          folder: f.folder,
          format: ext === "gguf" ? "gguf" : ext === "safetensors" ? "safetensors" : "other",
        });
      }
    }
  };
  await walk(f.folder, 0);
  return found;
}

/** `hub/models--Qwen--Qwen3-8B-GGUF/snapshots/<sha>/x.gguf` → `Qwen/Qwen3-8B-GGUF · x.gguf`. */
function hfName(hub: string, path: string): string {
  const [repoDir, , , ...file] = relative(hub, path).split(sep);
  const repo = repoDir?.startsWith("models--") ? repoDir.slice(8).split("--").join("/") : repoDir;
  return `${repo} · ${file.join("/") || basename(path)}`;
}

/**
 * Scans every known app folder plus the given ones.
 *
 * @param extra - Folders the user added.
 * @param home - Home folder (for tests).
 * @param env - Environment (for tests).
 * @returns Folders that hold models, with what is in them.
 */
export async function scanComputer(
  extra: readonly ModelFolder[] = [],
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<ModelFolder & { models: FoundModel[] }>> {
  const seen = new Set<string>();
  const folders = [...knownModelFolders(home, env), ...extra].filter((f) => {
    const key = normalize(f.folder).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const results = await Promise.all(folders.map(async (f) => ({ ...f, models: await scanFolder(f) })));
  return results.filter((r) => r.models.length > 0);
}

/**
 * Whether a path is inside one of the folders.
 *
 * @param path - File path.
 * @param folders - Allowed folders.
 * @returns True if inside one.
 */
export function insideAny(path: string, folders: readonly string[]): boolean {
  const n = normalize(path);
  const cmp = process.platform === "win32" ? (x: string) => x.toLowerCase() : (x: string) => x;
  return folders.some((f) => cmp(n).startsWith(cmp(normalize(f).replace(/[\\/]+$/, "") + sep)));
}
