import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Specialist skills that ship with KesherAI (materials, VFX, level design),
 * for Unreal and Unity, written into the skills folder on start. A model loads
 * one with `use_skill` when the task fits. Modelled on what Ludus does
 * (materials from textures, instances, bulk changes; Niagara systems; PCG-like
 * scattering and blockouts), built on the tools KesherAI already has
 * (unreal_python, unity_script_eval). Each tells the model to look the API up
 * in the running engine (dir()) instead of guessing, and to check its result.
 *
 * A skill the user edited (the marker line removed) is never overwritten.
 */

/** Bumped when a built-in skill's text changes, so older copies are replaced. */
const VERSION = 1;
const MARK = (name: string) => `<!-- kesher-builtin: ${name} v${VERSION} (remove this line to keep your own edits) -->`;

interface BuiltIn { name: string; description: string; body: string }

const CHECK = "Before using an API you are not sure of, print what exists in the running engine (Unreal: `print([m for m in dir(unreal.X) if not m.startswith('_')])`; Unity: `return string.Join(\", \", typeof(X).GetMethods().Select(m => m.Name).Distinct());`) and use only names that are there. After a change, look: take a screenshot (Unity: unity_screenshot; Unreal: unreal_test_blueprint or a picture from the editor) and say what you see. Save what you made, and list every asset you created or changed at the end.";

export const BUILTIN_SKILLS: BuiltIn[] = [
  {
    name: "materials-specialist",
    description: "Make or change materials in Unreal or Unity: a material from textures (base color, normal, roughness/metallic/ORM), material instances with parameters, a variant across many materials (snow, wet, damaged), or fixing how a surface looks.",
    body: `# Materials specialist

## Plan first
1. Find what exists: find_assets with "material", "texture", "M_", "MI_", "T_" (Unity: "mat", "texture").
2. Prefer one master material with parameters + instances (cheap to change, few shaders) over many separate materials.
3. Name things the engine's way: Unreal M_Name (material), MI_Name (instance), T_Name_BC / _N / _ORM (textures); Unity Materials/Name.mat.

## Unreal (unreal_python, editor closed; or the editor's own MCP tools when connected)
- Import textures: \`unreal.AssetImportTask\` (filename, destination_path '/Game/Textures', automated=True, save=True) and \`unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])\`. Normal maps: set the texture's compression_settings to TC_NORMALMAP; ORM/masks: sRGB off.
- A master material: \`create_asset('M_Name', '/Game/Materials', unreal.Material, unreal.MaterialFactoryNew())\`, then \`unreal.MaterialEditingLibrary.create_material_expression(mat, unreal.MaterialExpressionTextureSampleParameter2D, x, y)\` per texture (set parameter_name and texture), \`connect_material_property(expr, 'RGB', unreal.MaterialProperty.MP_BASE_COLOR)\` (normal → MP_NORMAL; ORM: R→ambient occlusion, G→roughness, B→metallic), scalar/vector parameters for tint and roughness, then \`recompile_material(mat)\` and save.
- Instances: \`create_asset('MI_Name', '/Game/Materials', unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())\`, \`set_material_instance_parent\`, then \`set_material_instance_scalar_parameter_value\` / \`..._vector_...\` / \`..._texture_...\`, \`update_material_instance\`.
- A change across many: list with \`unreal.EditorAssetLibrary.list_assets('/Game', recursive=True)\`, load, filter by class and parent, change the instance parameters, save each; say how many changed.
- Phones (mobile): few texture samplers (≤ 4), no translucency where opaque works, fully rough instead of complex reflections.

## Unity (unity_script_eval / unity_write_script)
- The pipeline decides the shader: URP "Universal Render Pipeline/Lit" (_BaseMap, _BaseColor, _BumpMap with _NORMALMAP keyword, _MetallicGlossMap, _Smoothness, _OcclusionMap), Built-in "Standard" (_MainTex, _Color, _BumpMap, _MetallicGlossMap, _Glossiness). Check which one: \`UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline\`.
- Make: \`var m = new Material(Shader.Find("Universal Render Pipeline/Lit")); m.SetTexture("_BaseMap", AssetDatabase.LoadAssetAtPath<Texture2D>(path)); AssetDatabase.CreateAsset(m, "Assets/Materials/Name.mat");\` Normal maps: TextureImporter textureType = NormalMap, then reimport.
- Variants across many: AssetDatabase.FindAssets("t:Material"), change, EditorUtility.SetDirty, AssetDatabase.SaveAssets().

${CHECK}`,
  },
  {
    name: "vfx-specialist",
    description: "Make or change visual effects in Unreal (Niagara) or Unity (Particle System / VFX Graph): muzzle flashes, impacts, sparks, pickups glow, trails, explosions, ambient dust, post-process looks.",
    body: `# VFX specialist

## Plan first
1. What it is for, how long it lasts, how often it plays (a muzzle flash 100 times a minute must be very cheap).
2. Find what exists: find_assets "NS_", "FX_", "particle", "vfx".
3. Start from a template and change parameters; build from nothing only when no template fits.

## Unreal Niagara (unreal_python; or the editor's MCP tools when connected)
- Systems are best started from the engine's templates: duplicate one with \`unreal.EditorAssetLibrary.duplicate_asset(source, '/Game/FX/NS_Name')\` (look the templates up first: \`unreal.EditorAssetLibrary.list_assets('/Niagara/DefaultAssets', recursive=True)\`).
- Change what the effect exposes as User parameters (color, spawn rate, size, lifetime). Python access to Niagara modules is limited: check with dir(unreal.NiagaraSystem) / dir(unreal.NiagaraEmitter); when a module cannot be edited from Python, say so and give the user the exact module and value to set in the Niagara editor.
- Spawn it in gameplay code: \`UNiagaraFunctionLibrary::SpawnSystemAtLocation(GetWorld(), System, Location)\` (module "Niagara" in Build.cs), or a UNiagaraComponent on the actor; set user parameters with SetVariableFloat / SetVariableLinearColor.
- Phones: GPU sim off, few particles (tens, not thousands), short lifetimes, unlit additive sprites.
- A post-process look: an unreal.PostProcessVolume actor (infinite_extent_unbound = True) and its settings (bloom, color grading, vignette).

## Unity (unity_script_eval / unity_write_script)
- Particle System from code: add ParticleSystem to a new GameObject, then set modules: \`var main = ps.main; main.startLifetime = 0.3f; main.startSpeed = 6; main.startSize = 0.1f; main.startColor = color; var em = ps.emission; em.rateOverTime = 0; em.SetBursts(new[]{ new ParticleSystem.Burst(0f, 20) }); var sh = ps.shape; sh.shapeType = ParticleSystemShapeType.Cone;\` renderer material: a URP Particles/Unlit material. Save it as a prefab (PrefabUtility.SaveAsPrefabAsset) under Assets/FX.
- VFX Graph only when the package com.unity.visualeffectgraph is installed and the target is not low-end mobile.
- Play it from gameplay code: Instantiate the prefab, Destroy after main.duration.

${CHECK}`,
  },
  {
    name: "level-design-specialist",
    description: "Build or dress levels in Unreal or Unity: blockouts, scattering props/rocks/trees/enemies with rules (density, slope, spacing, keep paths clear), placing gameplay objects, lighting a scene, or explaining an existing PCG graph or level.",
    body: `# Level design specialist

## Plan first
1. Read the level: what is there (Unreal: EditorActorSubsystem.get_all_level_actors(); Unity: unity_scene hierarchy), its size (bounds of the floor/landscape), where the player starts.
2. Write the rules in words before placing anything: what, how many per area, min spacing, max slope, where not (paths, the player start, gameplay zones), random rotation/scale ranges, a seed so it can be repeated.
3. Place in a group/folder of its own (Unreal: actor folder path "Scatter/Name"; Unity: a parent GameObject "Scatter_Name") so it can be removed in one step.

## Scattering (both engines): sample → trace down → filter → place
- Sample points on a grid with jitter (or Poisson-disk spacing) inside the area, using the seed.
- For each point trace down from above: Unreal \`unreal.SystemLibrary.line_trace_single(world, start, end, unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, False, [], unreal.DrawDebugTrace.NONE, True)\`; Unity \`Physics.Raycast(new Vector3(x, top, z), Vector3.down, out hit, height)\`.
- Keep a point only if it hit, the surface normal's slope is under the limit (angle between normal and up), and it is far enough from paths, the player start and points already placed.
- Place: Unreal \`unreal.get_editor_subsystem(unreal.EditorActorSubsystem).spawn_actor_from_object(asset, location, rotation)\` then set scale and folder; Unity \`PrefabUtility.InstantiatePrefab(prefab)\` with \`Undo.RegisterCreatedObjectUndo\`, parented to the group.
- Report how many were placed and how many were dropped by each rule.
- Unreal PCG: when the project uses PCG, prefer a PCG graph (Surface Sampler → Density Filter → Self Pruning → Static Mesh Spawner) and explain each node; check what Python can edit with dir(unreal.PCGGraph) first.

## Blockout
- Simple shapes first (Unreal /Engine/BasicShapes/Cube; Unity GameObject.CreatePrimitive), real sizes (a door ~2 m high, a corridor ≥ 2 m wide, a step ≤ 0.2 m), grey materials, then test walking it (Unity Play Mode / unity_test; Unreal unreal_test_blueprint).

## Light
- One directional light (sun) + sky; few dynamic lights. Phones: no dynamic shadows from many lights; bake where the engine allows.

${CHECK}`,
  },
];

/**
 * Writes the built-in skills into the skills folder: missing ones are added,
 * older built-in copies are replaced, and a copy whose marker line was removed
 * (the user's own version) is left alone.
 *
 * @param dir - KesherAI's skills folder.
 * @returns The names written.
 */
export async function seedBuiltinSkills(dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const s of BUILTIN_SKILLS) {
    const folder = join(dir, s.name);
    const file = join(folder, "SKILL.md");
    const now = await readFile(file, "utf8").catch(() => undefined);
    if (now !== undefined) {
      const m = /<!-- kesher-builtin: [\w-]+ v(\d+)/.exec(now);
      if (!m || Number(m[1]) >= VERSION) continue;
    }
    await mkdir(folder, { recursive: true });
    await writeFile(file, `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${MARK(s.name)}\n\n${s.body.trim()}\n`);
    written.push(s.name);
  }
  return written;
}
