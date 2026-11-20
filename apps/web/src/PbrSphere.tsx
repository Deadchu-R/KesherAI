import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { withToken } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * A lit sphere wearing a PBR map set, to turn with a finger or the mouse (the side canvas's PBR view, design
 * ChatCanvas). Loaded only when a set is opened (three.js is big). Maps load from this app's own asset links only.
 *
 * @param props.maps - Map name (albedo, normal, roughness, metallic, ao, height) → asset id.
 */
export default function PbrSphere({ maps }: { maps: Record<string, string> }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError(L("אין כאן תמיכה בתלת ממד (WebGL).", "3D (WebGL) is not available here."));
      return;
    }
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(0, 0.4, 3.2);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(3, 4, 5);
    scene.add(sun);
    const loader = new THREE.TextureLoader();
    const tex = (key: string, color = false) => {
      const id = maps[key];
      if (!id) return null;
      const t = loader.load(withToken(`/api/assets/${id}`), undefined, undefined, () => setError(L("מפה לא נטענה.", "A map did not load.")));
      if (color) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const material = new THREE.MeshStandardMaterial({
      map: tex("albedo", true),
      normalMap: tex("normal"),
      roughnessMap: tex("roughness"),
      metalnessMap: tex("metallic"),
      aoMap: tex("ao"),
      displacementMap: tex("height"),
      displacementScale: maps.height ? 0.04 : 0,
      roughness: maps.roughness ? 1 : 0.6,
      metalness: maps.metallic ? 1 : 0,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), material);
    scene.add(sphere);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 1.6;
    controls.maxDistance = 6;
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
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      sphere.rotation.y += 0.003;
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      material.dispose();
      for (const t of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap, material.displacementMap]) t?.dispose();
      sphere.geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [maps]);
  return (
    <div className="pbr-sphere">
      <div ref={box} className="pbr-sphere-canvas" role="img" aria-label={L("כדור עם החומר, לסיבוב בגרירה", "A sphere wearing the material; drag to turn")} />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
