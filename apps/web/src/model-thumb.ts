import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * A still picture of a 3D model (GLB / GLTF) for a card (the bank's 3D items, Blender's asset previews): one hidden
 * WebGL renderer for all of them, one model at a time, from the front-right and a little above; kept per address.
 * Loaded only when a card with a model is shown (three.js is big).
 */
let renderer: THREE.WebGLRenderer | undefined;
const done = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * The model's picture as a data URL.
 *
 * @param url - The model's address (this app's own; other addresses inside a .gltf do not load).
 * @param size - The picture's side, in pixels.
 * @returns A PNG data URL.
 */
export function modelThumb(url: string, size = 256): Promise<string> {
  const known = done.get(url);
  if (known) return known;
  const job = queue.then(() => render(url, size));
  queue = job.catch(() => undefined);
  done.set(url, job);
  job.catch(() => done.delete(url));
  return job;
}

async function render(url: string, size: number): Promise<string> {
  renderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => (u.startsWith(`${location.origin}/`) || /^(data|blob):/.test(u) ? u : "data:,"));
  const gltf = await new GLTFLoader(manager).loadAsync(url);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun, gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const centre = box.getCenter(new THREE.Vector3());
  const r = Math.max(0.001, box.getSize(new THREE.Vector3()).length() / 2);
  const camera = new THREE.PerspectiveCamera(35, 1, r / 100, r * 100);
  camera.position.copy(centre).add(new THREE.Vector3(1, 0.7, 1.4).normalize().multiplyScalar(r * 2.6));
  camera.lookAt(centre);
  renderer.render(scene, camera);
  const png = renderer.domElement.toDataURL("image/png");
  // The model's memory goes at once: only the picture stays.
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
  return png;
}
