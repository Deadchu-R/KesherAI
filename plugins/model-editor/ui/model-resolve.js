// Finding a model's companion files among the files that were opened together (picked together, or a dropped folder):
// a glTF's buffers and pictures, an OBJ's .mtl and the .mtl's pictures. Pure functions, no browser needs (tested in
// packages/core/src/model-resolve.test.ts).

/**
 * A path or URI made comparable: forward slashes, no `./`, percent-escapes decoded, lower case.
 *
 * @param p - A path, or a uri from inside a model file.
 * @returns The normalised path.
 */
export function normPath(p) {
  let s = String(p).trim();
  try { s = decodeURIComponent(s); } catch { /* keep it as it is */ }
  return s.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").toLowerCase();
}

/** The file's own path: inside a dropped folder, else its name. */
const pathOf = (f) => normPath(f.relPath ?? f.webkitRelativePath ?? f.name);

/**
 * The file a reference points to: the same path ending (`textures/a.png` matches `Model/textures/a.png`), else the same
 * file name (a model exported on another computer keeps its own folder layout in the uri).
 *
 * @param ref - The uri or path inside the model file.
 * @param files - The files opened together.
 * @returns The File, or undefined.
 */
export function findSibling(ref, files) {
  const r = normPath(ref);
  if (!r || /^(data:|https?:|blob:)/.test(r)) return undefined;
  const paths = files.map((f) => [pathOf(f), f]);
  const tail = r.split("/").pop();
  return (paths.find(([p]) => p === r || p.endsWith(`/${r}`) || r.endsWith(`/${p}`)) ?? paths.find(([p]) => p.split("/").pop() === tail))?.[1];
}

/**
 * What a glTF refers to outside itself, and which of those files are here.
 *
 * @param json - The parsed .gltf.
 * @param files - The files opened together.
 * @returns `{ found: Map<uri, File>, missing: string[] }`.
 */
export function resolveGltf(json, files) {
  const uris = [...(json?.buffers ?? []), ...(json?.images ?? [])].map((x) => x?.uri).filter((u) => typeof u === "string" && !/^(data:|https?:|blob:)/i.test(u));
  const found = new Map();
  const missing = [];
  for (const u of new Set(uris)) {
    const f = findSibling(u, files);
    if (f) found.set(u, f); else missing.push(u);
  }
  return { found, missing };
}

/**
 * The picture names an .mtl uses (`map_Kd`, `map_Bump`, `bump`, `map_Ks`, `map_d`… the last word of each line, options skipped).
 *
 * @param text - The .mtl's text.
 * @returns The names.
 */
export function mtlTextures(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:map_\w+|bump|disp|decal|refl)\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    // Options start with "-" and take numbers; the file name is what is left at the end (it may hold spaces).
    const rest = m[1].replace(/(?:^|\s)-\w+(?:\s+-?[\d.]+)+/g, " ").trim();
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * An OBJ's material file and the pictures that file uses.
 *
 * @param objText - The .obj's text.
 * @param files - The files opened together.
 * @returns `{ mtl: File | undefined, mtlName: string | undefined, textures: Map<name, File>, missing: string[] }`; `mtl` is
 *   found by the `mtllib` line, else the only .mtl among the files.
 */
export function resolveObj(objText, files) {
  const lib = /^\s*mtllib\s+(.+?)\s*$/im.exec(String(objText))?.[1];
  const mtls = files.filter((f) => /\.mtl$/i.test(f.name));
  const mtl = (lib && findSibling(lib, files)) || (mtls.length === 1 ? mtls[0] : undefined);
  return { mtl, mtlName: lib, textures: new Map(), missing: lib && !mtl ? [lib] : [] };
}

/**
 * The pictures of an already read .mtl, and which are here.
 *
 * @param mtlText - The .mtl's text.
 * @param files - The files opened together.
 * @returns `{ found: Map<name, File>, missing: string[] }`.
 */
export function resolveMtl(mtlText, files) {
  const found = new Map();
  const missing = [];
  for (const n of new Set(mtlTextures(mtlText))) {
    const f = findSibling(n, files);
    if (f) found.set(n, f); else missing.push(n);
  }
  return { found, missing };
}

/**
 * Which of the opened files is the model, and which ride along: the first model file in this order (glb, gltf, fbx, obj,
 * stl, ply); everything else is a companion.
 *
 * @param files - The files opened together.
 * @returns `{ main: File | undefined, rest: File[] }`.
 */
export function splitModel(files) {
  const order = ["glb", "gltf", "fbx", "obj", "stl", "ply"];
  const rank = (f) => order.indexOf((/\.([^.]+)$/.exec(f.name)?.[1] ?? "").toLowerCase());
  const main = files.filter((f) => rank(f) >= 0).sort((a, b) => rank(a) - rank(b))[0];
  return { main, rest: files.filter((f) => f !== main) };
}
