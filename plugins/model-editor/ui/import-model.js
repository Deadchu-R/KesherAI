/* global URL, TextDecoder */
// Reading model files of every format the 3D editor opens, with the companion files that came with them (a glTF's
// buffers and pictures, an OBJ's .mtl, an FBX's pictures). Nothing is executed or fetched: the loaders read the bytes
// they are given, and the companion files are served from memory (blob URLs) to the loaders' own texture requests.
// USDZ is not offered: the bundled three.js reads only the text form of USD, and most USDZ files are the binary form.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { findSibling, resolveGltf, resolveMtl, resolveObj, splitModel } from "./model-resolve.js";

/** The formats whose files do not say their unit or up axis (so the editor offers the two switches). */
export const NEEDS_OPTIONS = ["fbx", "obj", "stl", "ply"];

/**
 * Applies the import switches to a loaded model: Z up turned to Y up, centimetres to metres.
 *
 * @param root - The loaded object.
 * @param o - `{ zUp, cm }`.
 */
export function applyImportOptions(root, o) {
  root.rotation.x = o.zUp ? -Math.PI / 2 : 0;
  root.scale.setScalar(o.cm ? 0.01 : 1);
  root.updateMatrixWorld(true);
}

/** A grey mesh for a bare geometry (STL, PLY; a PLY with no faces is a cloud of points): smooth normals when the file has none, its vertex colours when it has them. */
function meshOf(geometry, points = false) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const colours = !!geometry.attributes.color;
  if (points) return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.01, vertexColors: colours }));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colours ? 0xffffff : 0xcccccc, vertexColors: colours, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide }));
}

/**
 * Reads the model among the opened files.
 *
 * @param files - The Files opened together (a model and, perhaps, its companions).
 * @param read - Reads a File's bytes (with progress).
 * @returns `{ root, name, format, missing }`: the object, the model file's name, its extension, and the companion files it
 *   needs that were not among the files (plain names); null when there is no model among them.
 * @throws Error in plain words when the file cannot be read.
 */
export async function importModel(files, read) {
  const { main, rest } = splitModel(files);
  if (!main) return null;
  const format = main.name.split(".").pop().toLowerCase();
  const urls = new Map();
  const missing = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const f = findSibling(url, rest);
    if (!f) return url;
    if (!urls.has(f)) urls.set(f, URL.createObjectURL(f));
    return urls.get(f);
  });
  // A file that stays unfound (an FBX's picture) is told after the loading, in plain words.
  manager.onError = (url) => { if (!/^(blob:|data:)/.test(url)) missing.push(decodeURIComponent(url.split("/").pop() ?? url)); };
  const fail = (e) => { throw new Error(`${main.name}: ${e?.message || e}`); };
  try {
    const bytes = await read(main);
    let root;
    if (format === "glb") root = (await new Promise((res, rej) => new GLTFLoader(manager).parse(bytes, "", res, rej))).scene;
    else if (format === "gltf") {
      const text = new TextDecoder().decode(bytes);
      missing.push(...resolveGltf(JSON.parse(text), rest).missing);
      root = (await new Promise((res, rej) => new GLTFLoader(manager).parse(text, "", res, rej))).scene;
    } else if (format === "fbx") root = new FBXLoader(manager).parse(bytes, "");
    else if (format === "obj") {
      const loader = new OBJLoader(manager);
      const found = resolveObj(new TextDecoder().decode(bytes), rest);
      missing.push(...found.missing);
      if (found.mtl) {
        const mtlText = await found.mtl.text();
        missing.push(...resolveMtl(mtlText, rest).missing);
        const mats = new MTLLoader(manager).parse(mtlText, "");
        mats.preload();
        loader.setMaterials(mats);
      }
      root = loader.parse(new TextDecoder().decode(bytes));
    } else if (format === "stl") root = meshOf(new STLLoader().parse(bytes));
    else if (format === "ply") root = meshOf(new PLYLoader().parse(bytes), !/element\s+face/i.test(new TextDecoder().decode(bytes.slice(0, 4096))));
    else throw new Error("This model format is not supported.");
    return { root, name: main.name, format, missing, urls };
  } catch (e) { return fail(e); }
}
