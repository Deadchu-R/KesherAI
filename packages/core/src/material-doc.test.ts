import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain browser module (no types), shared by the 3D editor's page and this test
import { MATERIAL_NODES, applyMaterialOps, compileMaterialGlsl, exportShaderGraph, parseMaterialToolCall, patchShaders, starterDoc, unrealMaterialCommand, unsupportedNodes, validateMaterialDoc } from "../../../plugins/model-editor/ui/material-doc.js";

type Doc = { version: number; name: string; nodes: Array<{ id: string; cls: string; x: number; y: number; values?: object; props?: object }>; links: Array<{ from: string; out: string; to: string; in: string }> };
const empty = (): Doc => ({ version: 1, name: "Rock", nodes: [], links: [] });
/** A small PBR graph: a texture times a colour into the base colour, a number into roughness, a fresnel rim into emissive. */
function pbr(): Doc {
  return applyMaterialOps(empty(), [
    { op: "add", cls: "Output", id: "out", x: 600, y: 0 },
    { op: "add", cls: "Color", id: "c", x: 0, y: 0, props: { value: "#ff8000" } },
    { op: "add", cls: "TextureAsset", id: "t", x: 0, y: 120, props: { source: "map" } },
    { op: "add", cls: "TextureSample", id: "s", x: 200, y: 120 },
    { op: "add", cls: "Multiply", id: "m", x: 400, y: 0 },
    { op: "add", cls: "Float", id: "r", x: 200, y: 300, props: { value: 0.7 } },
    { op: "add", cls: "Fresnel", id: "f", x: 200, y: 400 },
    { op: "connect", from: "t", to: "s", in: "Texture" },
    { op: "connect", from: "c", to: "m", in: "A" },
    { op: "connect", from: "s", out: "RGBA", to: "m", in: "B" },
    { op: "connect", from: "m", to: "out", in: "BaseColor" },
    { op: "connect", from: "r", to: "out", in: "Roughness" },
    { op: "connect", from: "f", to: "out", in: "Emissive" },
  ]).doc;
}

test("the starter set has about thirty nodes, each with a Unity or a reason", () => {
  assert.ok(MATERIAL_NODES.length >= 30);
  for (const d of MATERIAL_NODES) assert.ok(d.u || d.why || d.cls === "Output", d.cls);
});

test("validation: a good graph passes; loops, bad types, a missing output and unknown pins do not", () => {
  assert.equal(validateMaterialDoc(pbr()).ok, true);
  const loop = pbr();
  loop.links.push({ from: "m", out: "Out", to: "m", in: "A" });
  assert.ok(validateMaterialDoc(loop).issues.some((i: { code: string }) => i.code === "cycle"));
  const bad = pbr();
  bad.links.push({ from: "t", out: "Tex", to: "out", in: "Metallic" });
  assert.ok(validateMaterialDoc(bad).issues.some((i: { code: string }) => i.code === "type"));
  const noOut = { ...pbr(), nodes: pbr().nodes.filter((n) => n.cls !== "Output"), links: [] };
  assert.ok(validateMaterialDoc(noOut).issues.some((i: { code: string }) => i.code === "output"));
  const ghost = pbr();
  ghost.links.push({ from: "c", out: "Nope", to: "out", in: "AO" });
  const issues = validateMaterialDoc(ghost).issues;
  assert.ok(issues.some((i: { code: string }) => i.code === "link"));
  assert.ok(issues.every((i: { he: string }) => i.he));
});

test("ops: connect refuses loops and wrong types, replaces a wire, ids and values are clean", () => {
  const { doc, results } = applyMaterialOps(pbr(), [
    { op: "connect", from: "m", to: "m", in: "B" },
    { op: "connect", from: "t", to: "m", in: "A" },
    { op: "connect", from: "r", to: "m", in: "A" },
    { op: "set", node: "r", prop: "value", value: "0.25" },
    { op: "set", node: "c", prop: "value", value: "red" },
    { op: "add", cls: "Lerp" },
    { op: "delete", node: "out" },
    { op: "add", cls: "NoSuch" },
  ]);
  assert.deepEqual(results.map((r: { ok: boolean }) => r.ok), [false, false, true, true, false, true, false, false]);
  assert.equal(doc.links.filter((l: { to: string; in: string }) => l.to === "m" && l.in === "A").length, 1);
  assert.equal(doc.nodes.find((n: { id: string }) => n.id === "r").props.value, 0.25);
  assert.equal(results[5].node, "n1");
  assert.equal(pbr().nodes.find((n) => n.id === "r")?.props && (pbr().nodes.find((n) => n.id === "r")!.props as { value: number }).value, 0.7, "the input is not changed");
});

test("GLSL: a small graph compiles to uniforms and lines three.js's shader takes", () => {
  const c = compileMaterialGlsl(pbr());
  assert.equal(c.ok, true);
  assert.match(c.decl, /uniform vec4 kmC\[2\];/);
  assert.match(c.decl, /uniform sampler2D kmTex0;/);
  assert.match(c.main, /vec4 km_s_RGBA = texture2D\(kmTex0, kmUv\);/);
  // Dynamic Vector: the widest input (vec4) wins, as in Shader Graph; the output takes .xyz.
  assert.match(c.main, /vec4 km_m_Out = vec4\(km_c_Out, 0\.0\) \* km_s_RGBA;/);
  assert.match(c.main, /diffuseColor\.rgb = \(km_m_Out\)\.xyz;/);
  assert.match(c.main, /roughnessFactor = clamp\(km_r_Out, 0\.04, 1\.0\);/);
  assert.match(c.emissive, /totalEmissiveRadiance = vec3\(km_f_Out\);/);
  assert.deepEqual(c.textures, [{ node: "t", source: "map" }]);
  // The colour is linear in the shader (sRGB #ff8000 → 1, ~0.216, 0).
  const orange = c.consts.find((k: { node: string }) => k.node === "c").value;
  assert.ok(Math.abs(orange[1] - 0.2159) < 1e-3);
  const vtx = "#include <common>\nvoid main(){\n#include <uv_vertex>\n}";
  const frag = "#include <common>\nvoid main(){\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n#include <aomap_fragment>\n}";
  const p = patchShaders(vtx, frag, c);
  assert.match(p.vertex, /kmUv = uv;/);
  assert.match(p.fragment, /uniform sampler2D kmTex0;[\s\S]*normal_fragment_maps>\n {2}\/\/ KesherAI material graph[\s\S]*totalEmissiveRadiance/);
  // A constant change keeps the shader (the same key); a new wire does not.
  const k2 = compileMaterialGlsl(applyMaterialOps(pbr(), [{ op: "set", node: "r", prop: "value", value: 0.1 }]).doc).key;
  assert.equal(k2, c.key);
  assert.notEqual(compileMaterialGlsl(applyMaterialOps(pbr(), [{ op: "disconnect", to: "out", in: "Emissive" }]).doc).key, c.key);
  assert.equal(compileMaterialGlsl({ ...pbr(), links: [...pbr().links, { from: "m", out: "Out", to: "m", in: "A" }] }).ok, false);
});

test("Unity export: a basic PBR graph becomes a URP Lit Shader Graph, the same every time", () => {
  const a = exportShaderGraph(pbr());
  assert.equal(a.ok, true);
  assert.equal(a.text, exportShaderGraph(pbr()).text);
  assert.match(a.text, /^\{\n {4}"m_SGVersion"/);
  const objs = a.text.trim().split(/\n\n(?=\{)/).map((s: string) => JSON.parse(s));
  const graph = objs[0];
  assert.equal(graph.m_Type, "UnityEditor.ShaderGraph.GraphData");
  for (const k of ["m_Properties", "m_Nodes", "m_Edges", "m_VertexContext", "m_FragmentContext", "m_ActiveTargets"]) assert.ok(k in graph, k);
  const ids = new Set(objs.map((o: { m_ObjectId: string }) => o.m_ObjectId));
  for (const r of graph.m_Nodes) assert.ok(ids.has(r.m_Id));
  for (const e of graph.m_Edges) assert.ok(ids.has(e.m_OutputSlot.m_Node.m_Id) && ids.has(e.m_InputSlot.m_Node.m_Id));
  const types = objs.map((o: { m_Type: string }) => o.m_Type);
  assert.ok(types.includes("UnityEditor.Rendering.Universal.ShaderGraph.UniversalTarget"));
  assert.ok(types.includes("UnityEditor.Rendering.Universal.ShaderGraph.UniversalLitSubTarget"));
  assert.ok(types.includes("UnityEditor.ShaderGraph.SampleTexture2DNode"));
  assert.ok(types.includes("UnityEditor.ShaderGraph.Internal.Texture2DShaderProperty"));
  const blocks = objs.filter((o: { m_SerializedDescriptor?: string }) => o.m_SerializedDescriptor).map((o: { m_SerializedDescriptor: string }) => o.m_SerializedDescriptor);
  assert.ok(blocks.includes("SurfaceDescription.Smoothness") && blocks.includes("SurfaceDescription.BaseColor") && blocks.includes("VertexDescription.Position"));
  // Roughness goes through a One Minus into Smoothness.
  assert.ok(objs.some((o: { m_Name: string }) => /roughness → smoothness/.test(o.m_Name ?? "")));
});

test("unsupported nodes block the export with a clear list", () => {
  const doc = applyMaterialOps(pbr(), [{ op: "add", cls: "Panner", id: "p" }, { op: "connect", from: "p", to: "s", in: "UV" }]).doc;
  const r = exportShaderGraph(doc);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsupported.map((u: { node: string }) => u.node), ["p"]);
  assert.match(r.unsupported[0].why.en, /Tiling And Offset/);
  assert.equal(unsupportedNodes(doc, "unreal").length, 0);
  assert.equal(unrealMaterialCommand(doc, "/Game/M_Rock").args.path, "/Game/M_Rock");
});

test("chat: a material_graph answer is read and its ops build the graph", () => {
  const answer = 'Here:\n```json\n{"tool":"material_graph","summary":"Blue glow rim","ops":[{"op":"add","cls":"Fresnel","id":"rim"},{"op":"add","cls":"Color","id":"blue","props":{"value":"#2060ff"}},{"op":"add","cls":"Multiply","id":"mul"},{"op":"connect","from":"rim","to":"mul","in":"A"},{"op":"connect","from":"blue","to":"mul","in":"B"},{"op":"connect","from":"mul","to":"out","in":"Emissive"}]}\n```';
  const call = parseMaterialToolCall(answer);
  assert.equal(call.summary, "Blue glow rim");
  const { doc, results } = applyMaterialOps(starterDoc({ color: "#808080" }), call.ops);
  assert.ok(results.every((r: { ok: boolean }) => r.ok));
  assert.ok(doc.links.some((l: { from: string; to: string; in: string }) => l.from === "mul" && l.to === "out" && l.in === "Emissive"));
  assert.equal(compileMaterialGlsl(doc).ok, true);
  assert.equal(parseMaterialToolCall("no json here"), undefined);
});

test("the starter graph reads the part's material (colour × texture, normal map)", () => {
  const d = starterDoc({ color: "#336699", roughness: 0.3, metalness: 1, maps: ["map", "normalMap"] });
  assert.equal(validateMaterialDoc(d).ok, true);
  assert.ok(d.links.some((l: { to: string; in: string }) => l.to === "out" && l.in === "Normal"));
  assert.equal(compileMaterialGlsl(d).textures.length, 2);
  assert.match(compileMaterialGlsl(d).main, /kmTangentFrame/);
});
