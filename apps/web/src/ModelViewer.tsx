import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * A 3D model (GLB or GLTF) to turn and zoom: drag to turn, wheel or two fingers to zoom, and a wireframe switch. The
 * first step of the 3D editor (RESEARCH_LOG "Editors, part 4"); loaded only when a model is opened (three.js is big).
 *
 * @param props.src - The model's address (a download link of the chat's folder).
 * @param props.name - Its file name, for the label.
 */
export default function ModelViewer({ src, name }: { src: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [wire, setWire] = useState(false);
  const [progress, setProgress] = useState(0);
  const scene = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.append(renderer.domElement);
    const s = new THREE.Scene();
    scene.current = s;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    s.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 5, 4);
    s.add(sun);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const size = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);
    let alive = true;
    // A .gltf can name textures and data anywhere on the web: only this app's own addresses and embedded data load,
    // so opening a model never reaches someone else's server (security scan 143).
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => (u.startsWith(`${location.origin}/`) || /^(data|blob):/.test(u) ? u : "data:,"));
    // How much of a big model has come, while it loads (self-work t-run 202611181155).
    manager.onProgress = (_item, loaded, total) => { if (alive) setProgress(total > 0 ? Math.round((loaded / total) * 100) : 0); };
    new GLTFLoader(manager).load(
      src,
      (gltf) => {
        if (!alive) return;
        const model = gltf.scene;
        s.add(model);
        // Frame it: the camera looks at its middle from a distance that fits its size.
        const b = new THREE.Box3().setFromObject(model);
        const mid = b.getCenter(new THREE.Vector3());
        const r = b.getSize(new THREE.Vector3()).length() / 2 || 1;
        controls.target.copy(mid);
        camera.position.copy(mid).add(new THREE.Vector3(r * 1.6, r * 1.0, r * 2.2));
        camera.near = r / 100;
        camera.far = r * 100;
        camera.updateProjectionMatrix();
        let tris = 0;
        model.traverse((o) => {
          const g = (o as THREE.Mesh).geometry;
          if (g) tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
        });
        setInfo(L(`${Math.round(tris).toLocaleString()} משולשים`, `${Math.round(tris).toLocaleString()} triangles`));
        setProgress(100);
      },
      undefined,
      (e) => alive && setError(String((e as Error)?.message ?? e)),
    );
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(s, camera);
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src]);

  useEffect(() => {
    scene.current?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) if ("wireframe" in x) (x as THREE.MeshStandardMaterial).wireframe = wire;
    });
  }, [wire]);

  return (
    <div className="model-viewer">
      <div ref={box} className="model-viewer-canvas" role="img" aria-label={L(`מודל תלת ממד: ${name}`, `3D model: ${name}`)} />
      <div className="row wrap small">
        <span className="muted grow">{error ? <span className="error">{error}</span> : progress > 0 && progress < 100 ? `${progress}%` : info || L("טוען…", "Loading…")}</span>
        <label className="row"><input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} /> {L("רשת", "Wireframe")}</label>
        <span className="muted">{L("גרירה מסובבת, גלגלת מקרבת", "Drag to turn, wheel to zoom")}</span>
      </div>
    </div>
  );
}
