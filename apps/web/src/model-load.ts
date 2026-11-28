/**
 * Loads a 3D file for the viewer and the poster (three.js, so this module is imported only when a model is shown).
 * glb/gltf, fbx and obj; nothing from the file can reach another server (security scan 143): only this app's own
 * addresses and embedded data are fetched.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { LIGHT_PRESETS, type LightId } from "./model-surface";

/**
 * Loads a model by its file type.
 *
 * @param src - The file's address (a download link of the chat's folder).
 * @param name - Its file name (the extension picks the loader).
 * @param onProgress - Called with the share loaded, 0-100.
 * @returns The model's root object.
 */
export function loadModel(src: string, name: string, onProgress?: (pct: number) => void): Promise<THREE.Object3D> {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => (u.startsWith(`${location.origin}/`) || /^(data|blob):/.test(u) ? u : "data:,"));
  manager.onProgress = (_i, loaded, total) => onProgress?.(total > 0 ? Math.round((loaded / total) * 100) : 0);
  const ext = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase();
  return new Promise((resolve, reject) => {
    if (ext === "fbx") new FBXLoader(manager).load(src, resolve, undefined, reject);
    else if (ext === "obj") new OBJLoader(manager).load(src, (o) => {
      // An .obj has no materials of its own that survive without its .mtl: a plain grey one, so it is not black.
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && !m.material) m.material = new THREE.MeshStandardMaterial({ color: 0xb8bcc8 }); });
      resolve(o);
    }, undefined, reject);
    else new GLTFLoader(manager).load(src, (g) => resolve(g.scene), undefined, reject);
  });
}

/**
 * Puts the lights of a preset in a scene (replaces the ones it put before).
 *
 * @param scene - The scene.
 * @param id - The preset.
 */
export function applyLight(scene: THREE.Scene, id: LightId): void {
  const p = LIGHT_PRESETS[id];
  for (const o of scene.children.filter((c) => c.userData.kesherLight)) scene.remove(o);
  const hemi = new THREE.HemisphereLight(p.sky, p.ground, p.hemi);
  const sun = new THREE.DirectionalLight(0xffffff, p.sun);
  sun.position.set(...(p.at as unknown as [number, number, number]));
  hemi.userData.kesherLight = sun.userData.kesherLight = true;
  scene.add(hemi, sun);
}

/**
 * Frames a model: the camera looks at its middle from a distance that fits its size.
 *
 * @returns The model's radius.
 */
export function frame(model: THREE.Object3D, camera: THREE.PerspectiveCamera, target: THREE.Vector3): number {
  const b = new THREE.Box3().setFromObject(model);
  const mid = b.getCenter(new THREE.Vector3());
  const r = b.getSize(new THREE.Vector3()).length() / 2 || 1;
  target.copy(mid);
  camera.position.copy(mid).add(new THREE.Vector3(r * 1.6, r * 1.0, r * 2.2));
  camera.near = r / 100;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  return r;
}

/** Posters already drawn, by file (a card shown again does not load the model again). */
const posters = new Map<string, Promise<string>>();

/**
 * One still picture of a model (the card's poster, and the static view): drawn once with a small renderer that is
 * released at once, kept as a PNG address.
 *
 * @param key - The cache key (the file's path).
 * @param src - The file's address.
 * @param name - Its file name.
 * @param size - The picture's width and height in pixels.
 */
export function renderPoster(key: string, src: string, name: string, size = 480): Promise<string> {
  let p = posters.get(key);
  if (!p) {
    p = (async () => {
      const model = await loadModel(src, name);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      try {
        renderer.setSize(size, size);
        const scene = new THREE.Scene();
        applyLight(scene, "studio");
        scene.add(model);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
        frame(model, camera, new THREE.Vector3());
        camera.lookAt(new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()));
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      } finally {
        renderer.dispose();
        renderer.forceContextLoss();
      }
    })();
    p.catch(() => posters.delete(key));
    posters.set(key, p);
  }
  return p;
}
