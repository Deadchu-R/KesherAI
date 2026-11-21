/**
 * The chat's one-request texture tools (WORK_LIST "ComfyUI to Unity demo", "seamless albedo plus normal, roughness and
 * AO flow, and a UI-sprite flow"):
 * - make_pbr_texture: words → a seamless albedo in ComfyUI → seam check (and fix) → normal, roughness, AO and height
 *   (pbr-flow.ts). The maps are library pictures, so the side canvas shows them (grid and lit sphere) on the PC and on
 *   the phone, and unity_create_pbr_material takes them by id ("Apply to selected in Unity" under the result).
 * - make_ui_sprite: words → a picture with the chat's image model → its background removed (rembg) → a cut-out PNG
 *   that "Import to Unity" (unity_import_sprite) brings in as a 2D/UI sprite.
 */
import { randomInt } from "node:crypto";
import type { AgentTool } from "@kesher/agent";
import type { AssetStore } from "./assets.js";
import { albedoGraph, CORE_NODES, deriveMaps, FIX_NODES, materialName, missingNodes, pickCheckpoint, readPicture, SEAM_LIMIT, seamFixGraph, seamScore, TILING_NODES, type ComfyGraphRunner } from "./pbr-flow.js";

/** The map names of one set, in the order the result lists them (the chat's buttons read them back). */
export const SET_MAPS = ["albedo", "normal", "roughness", "ao", "height"] as const;

/** What the texture tools need. */
export interface PbrToolDeps {
  /** ComfyUI (undefined when it is not set up or the Nodes part is off). */
  comfy?: ComfyGraphRunner;
  assets: Pick<AssetStore, "save" | "get">;
  /** The active image model's ComfyUI checkpoint file, when the active image model is a ComfyUI one. */
  activeCheckpoint?: () => string | undefined;
  /** The chat's generate_image tool (for sprites). */
  generate?: AgentTool;
  /** rembg + BiRefNet; undefined when it is not set up (the Image editor sets it up). */
  removeBackground?: () => { remove(png: Buffer): Promise<Buffer>; ready(): boolean } | undefined;
}

/** The system-prompt line for the texture tools. */
export const PBR_NOTE =
  "For a texture or material (\"tileable wall texture\", \"טקסטורת קיר שחוזרת\", wood floor, rusty metal, PBR) call make_pbr_texture, not generate_image: it makes a seamless albedo and its normal, roughness, AO and height maps. To put it on the object selected in Unity, call unity_create_pbr_material next with the albedo, normal, roughness and ao ids it returns and apply_to [\"selection\"]. For a 2D game or UI sprite (an icon, a button, a character on a clear background) call make_ui_sprite, then unity_import_sprite with its picture id when the user wants it in Unity.";

/**
 * The texture tools for a chat.
 *
 * @param d - ComfyUI, the library and the services.
 * @returns make_pbr_texture (with ComfyUI) and make_ui_sprite (with an image model).
 */
export function pbrTools(d: PbrToolDeps): AgentTool[] {
  const tools: AgentTool[] = [];
  const comfy = d.comfy;
  if (comfy) {
    tools.push({
      risk: "safe",
      spec: {
        name: "make_pbr_texture",
        description: "Make a seamless (tileable) PBR texture set from words with ComfyUI: albedo, normal, roughness, AO and height maps that tile. The user sees the maps (grid and a lit sphere in the side canvas) with buttons to apply it to the object selected in Unity. Takes from seconds to a few minutes.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The surface in English, concrete: material, colour, wear, scale. E.g. 'old red brick wall, white mortar, slightly weathered'." },
            name: { type: "string", description: "The material's name (default: from the prompt)." },
            count: { type: "integer", description: "Variations to make, 1-4 (default 1)." },
          },
          required: ["prompt"],
        },
      },
      run: async (input, ctx) => {
        const prompt = String(input.prompt ?? "").trim().slice(0, 1000);
        if (!prompt) return { output: "Give the texture's description (prompt)." };
        const st = comfy.state();
        if (!st.allowed) return { output: "ComfyUI is turned off by the organisation's business mode, so textures cannot be made here." };
        if (!st.installed) return { output: "ComfyUI is not installed. Tell the user to install it once on the Nodes page (Install ComfyUI), then ask again." };
        const progress = (phase: string) => ctx.jobProgress?.({ phase, step: 0, steps: 0 });
        progress("queued");
        const have = await comfy.nodes(ctx.signal);
        const lacking = missingNodes(have, CORE_NODES);
        if (lacking.length) return { output: `This ComfyUI lacks its own nodes ${lacking.join(", ")} (an old or broken install). Tell the user to update ComfyUI on the Nodes page.` };
        const ckpt = pickCheckpoint(await comfy.checkpoints(), d.activeCheckpoint?.());
        if (!ckpt) return { output: "ComfyUI has no picture checkpoint to make the texture with. Tell the user to add an image model for ComfyUI (Models → Images, e.g. an SDXL checkpoint), then ask again." };
        const tiling = !missingNodes(have, TILING_NODES).length;
        const canFix = !missingNodes(have, FIX_NODES).length;
        const count = Math.min(4, Math.max(1, Math.round(Number(input.count ?? 1)) || 1));
        const files = await comfy.run(() => albedoGraph({ ckpt, prompt, count, tiling, seed: randomInt(2 ** 31) }), ctx.signal, ctx.jobProgress);
        const pictures = files.filter((f) => f.mimeType === "image/png" || /\.png$/i.test(f.filename));
        if (!pictures.length) return { output: "ComfyUI finished but saved no picture." };
        const name = String(input.name ?? "").trim().slice(0, 60) || materialName(prompt);
        const sets: string[] = [];
        const albedos: string[] = [];
        const notes: string[] = [];
        for (const [n, file] of pictures.entries()) {
          let data = file.data;
          let pic = readPicture(data);
          if (!pic) {
            notes.push(`Set ${n + 1}: ComfyUI saved a picture this reader cannot open, so only its albedo was kept.`);
            const a = await d.assets.save(data, "image/png", { sourceModelId: `comfyui/${ckpt}`, meta: { prompt, pbr: "albedo" } });
            albedos.push(a.id);
            continue;
          }
          progress("seam check");
          let score = seamScore(pic);
          let how = tiling ? "tiled while made" : "checked";
          if (score > SEAM_LIMIT && canFix && pic.w % 2 === 0 && pic.h % 2 === 0) {
            progress("fixing seam");
            const w = pic.w;
            const h = pic.h;
            const fixed = (await comfy.run(async (upload) => seamFixGraph({ image: await upload(data, `kesher-pbr-${randomInt(1e9)}.png`), w, h, ckpt, prompt, seed: randomInt(2 ** 31) }), ctx.signal, ctx.jobProgress)).find((f) => /\.png$/i.test(f.filename) || f.mimeType === "image/png");
            const again = fixed ? readPicture(fixed.data) : undefined;
            if (fixed && again) {
              data = fixed.data;
              pic = again;
              score = seamScore(again);
              how = "seam fixed";
            }
          }
          if (score > SEAM_LIMIT) notes.push(`Set ${n + 1} may show a faint seam when tiled (score ${score.toFixed(2)}${canFix ? "" : "; this ComfyUI lacks the nodes to fix it"}).`);
          progress("maps");
          const maps = deriveMaps(pic);
          const meta = { prompt, name, pbr: "" };
          const save = (bytes: Uint8Array, map: string) => d.assets.save(bytes, "image/png", { sourceModelId: map === "albedo" ? `comfyui/${ckpt}` : "kesher/pbr-maps", meta: { ...meta, pbr: map } });
          const ids = {
            albedo: (await save(data, "albedo")).id,
            normal: (await save(maps.normal, "normal")).id,
            roughness: (await save(maps.roughness, "roughness")).id,
            ao: (await save(maps.ao, "ao")).id,
            height: (await save(maps.height, "height")).id,
          };
          albedos.push(ids.albedo);
          sets.push(`Set ${n + 1}: ${SET_MAPS.map((k) => `${k}=${ids[k]}`).join(" ")} (${pic.w}x${pic.h}, ${how}, seam ${score.toFixed(2)})`);
        }
        const head = `Made ${sets.length || albedos.length} PBR texture set(s) "${name}" with ${ckpt}; the user sees the maps.`;
        const next = sets.length ? `To put set 1 on the object selected in Unity: unity_create_pbr_material with name "${name}", maps albedo, normal, roughness and ao from set 1, and apply_to ["selection"].` : "";
        return { output: [head, ...sets, ...notes, next].filter(Boolean).join("\n"), assetIds: albedos };
      },
    });
  }
  const generate = d.generate;
  if (generate) {
    tools.push({
      risk: "safe",
      spec: {
        name: "make_ui_sprite",
        description: "Make a 2D game or UI sprite from words: a picture of one centred thing (icon, button, item, character) with the image model, then its background removed so it is a cut-out PNG. Import it into Unity with unity_import_sprite (its picture id).",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The sprite in English: what it is and its style. E.g. 'golden coin game icon, flat cartoon style, thick outline'." },
            size: { type: "integer", description: "Square size in pixels, 512 or 1024 (default 1024)." },
          },
          required: ["prompt"],
        },
      },
      run: async (input, ctx) => {
        const prompt = String(input.prompt ?? "").trim().slice(0, 1000);
        if (!prompt) return { output: "Give the sprite's description (prompt)." };
        const size = Number(input.size) === 512 ? 512 : 1024;
        const made = await generate.run({ prompt: `${prompt}, single centered object, isolated on a plain white background, game asset, clean edges, no text`, width: size, height: size }, ctx);
        const id = made.assetIds?.[0];
        if (!id) return made;
        const remover = d.removeBackground?.();
        if (!remover?.ready()) return { output: `Made the picture (${id}), but the background remover is not set up yet, so it still has its background. Tell the user to set it up in the Image editor (Remove background), or use it as it is. Import it with unity_import_sprite (file ${id}).`, assetIds: [id] };
        const got = await d.assets.get(id);
        if (!got) return { output: `Made the picture (${id}), but it is not in the library any more.` };
        ctx.jobProgress?.({ phase: "cutting out", step: 0, steps: 0 });
        const cut = await remover.remove(got.data);
        const sprite = await d.assets.save(cut, "image/png", { sourceModelId: "remove-background", meta: { from: id, prompt, sprite: true } });
        return { output: `Made the sprite ${sprite.id} (a ${size}x${size} cut-out PNG with a clear background). To put it into Unity: unity_import_sprite with file ${sprite.id}.`, assetIds: [sprite.id] };
      },
    });
  }
  return tools;
}
