import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getLocale, he$ } from "./i18n";
import { applyLight, frame, loadModel } from "./model-load";
import type { LightId, ModelParts } from "./model-surface";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * A 3D model (GLB or GLTF) to turn and zoom: drag to turn, wheel or two fingers to zoom, and a wireframe switch. The
 * first step of the 3D editor (RESEARCH_LOG "Editors, part 4"); loaded only when a model is opened (three.js is big).
 *
 * Also the 3D surface's viewer (ModelPanel.tsx): glb, gltf, fbx and obj; the optional props below turn it by itself,
 * change its light, report its parts and materials, and tell which part was tapped.
 *
 * @param props.src - The model's address (a download link of the chat's folder).
 * @param props.name - Its file name, for the label (and its type).
 * @param props.autoRotate - A turntable: the model turns by itself until the user touches it.
 * @param props.light - A light preset (LIGHT_PRESETS); the studio light when not given.
 * @param props.wire - Wireframe on or off from outside; when not given the viewer's own switch is shown.
 * @param props.picked - The mesh name to outline (the part the user tapped).
 * @param props.onLoaded - Called once with the model's meshes, materials and triangle count.
 * @param props.onPick - Called when a part is tapped (not dragged): its mesh name and material name.
 */
export default function ModelViewer({ src, name, autoRotate = false, light = "studio", wire: wireProp, picked, onLoaded, onPick }: { src: string; name: string; autoRotate?: boolean; light?: LightId; wire?: boolean; picked?: string; onLoaded?: (i: { parts: ModelParts; tris: number }) => void; onPick?: (p: { part: string; material?: string }) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [wireOwn, setWireOwn] = useState(false);
  const wire = wireProp ?? wireOwn;
  const [progress, setProgress] = useState(0);
  const scene = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const outline = useRef<THREE.BoxHelper | null>(null);
  // The latest callbacks, so a new function each render does not reload the model.
  const cb = useRef({ onLoaded, onPick });
  cb.current = { onLoaded, onPick };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.append(renderer.domElement);
    const s = new THREE.Scene();
    scene.current = s;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    applyLight(s, "studio");
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;
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
    // How much of a big model has come, while it loads (self-work t-run 202611181155).
    void loadModel(src, name, (pct) => { if (alive) setProgress(pct); }).then(
      (model) => {
        if (!alive) return;
        s.add(model);
        frame(model, camera, controls.target);
        let tris = 0;
        const meshes: string[] = [];
        const mats = new Map<string, string | undefined>();
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const g = m.geometry;
          tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
          if (o.name && !meshes.includes(o.name) && meshes.length < 500) meshes.push(o.name);
          for (const x of Array.isArray(m.material) ? m.material : [m.material]) {
            const c = (x as THREE.MeshStandardMaterial).color;
            if (x?.name && !mats.has(x.name) && mats.size < 200) mats.set(x.name, c ? `#${c.getHexString()}` : undefined);
          }
        });
        setInfo(L(`${Math.round(tris).toLocaleString()} משולשים`, `${Math.round(tris).toLocaleString()} triangles`));
        setProgress(100);
        cb.current.onLoaded?.({ parts: { meshes, materials: [...mats].map(([n, color]) => ({ name: n, ...(color ? { color } : {}) })) }, tris: Math.round(tris) });
      },
      (e) => { if (alive) setError(String((e as Error)?.message ?? e)); },
    );
    // A tap (a press and release that did not move) picks the part under the finger; a drag only turns the model.
    const ray = new THREE.Raycaster();
    let down: [number, number] | null = null;
    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || !cb.current.onPick) return;
      down = null;
      const r = dom.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(s.children, true).find((h) => (h.object as THREE.Mesh).isMesh && !h.object.userData.kesherLight);
      if (!hit) return;
      const mat = Array.isArray((hit.object as THREE.Mesh).material) ? ((hit.object as THREE.Mesh).material as THREE.Material[])[0] : ((hit.object as THREE.Mesh).material as THREE.Material);
      cb.current.onPick({ part: hit.object.name || L("חלק ללא שם", "Unnamed part"), ...(mat?.name ? { material: mat.name } : {}) });
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(s, camera);
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      controlsRef.current = null;
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src, name]);

  // Turntable, light and the outlined part follow the props without reloading the model.
  useEffect(() => { if (controlsRef.current) { controlsRef.current.autoRotate = autoRotate; controlsRef.current.autoRotateSpeed = 2; } }, [autoRotate]);
  useEffect(() => { if (scene.current) applyLight(scene.current, light); }, [light]);
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    if (outline.current) { s.remove(outline.current); outline.current.dispose(); outline.current = null; }
    const o = picked ? s.getObjectByName(picked) : undefined;
    if (o) { outline.current = new THREE.BoxHelper(o, 0x6aa9ff); s.add(outline.current); }
  }, [picked]);

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
        {wireProp === undefined && <label className="row"><input type="checkbox" checked={wire} onChange={(e) => setWireOwn(e.target.checked)} /> {L("רשת", "Wireframe")}</label>}
        <span className="muted">{L("גרירה מסובבת, גלגלת מקרבת", "Drag to turn, wheel to zoom")}</span>
      </div>
    </div>
  );
}
