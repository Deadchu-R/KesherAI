/**
 * The chat's inline action buttons under a result (design ChatQuickActions, like the one-tap chips of ComfyUI
 * frontends and ChatGPT's image actions): Upscale, 4 variations, Remove background, Import to Unity, Use as texture,
 * Transcribe, and under a PBR set Apply to selected in Unity, Save as material and 4 variations. A button runs one tool directly with inputs it already knows (AgentSession.runDirect), so no model turn
 * and no tokens; the tool's approval rules still apply. Only the tools listed here can be run this way.
 */
import { type AgentTool } from "@kesher/agent";
import type { AssetStore } from "./assets.js";

/** The services the button-only tools need (set by the server once they exist). */
export interface QuickServices {
  /** Real-ESRGAN 4× on the built-in engine (a PNG in, a PNG out); undefined when the engine is not there. */
  upscale?(png: Buffer, signal: AbortSignal): Promise<Buffer>;
  /** Whether the upscaler is set up (it downloads on first use, which is asked for separately). */
  upscaleReady?(): Promise<boolean>;
  /** rembg + BiRefNet: the picture with its background clear (PNG out). */
  removeBackground?(picture: Buffer): Promise<Buffer>;
  /** Whether the background remover is installed. */
  removeBackgroundReady?(): boolean;
}

/** Tools the model has too, which a button may run with known inputs. */
const SESSION_TOOLS = new Set(["generate_image", "transcribe_audio", "unity_import_sprite", "unity_create_pbr_material", "make_pbr_texture"]);
/** Tools only the buttons have (not in the model's list, so they cost no prompt tokens). */
const BUTTON_TOOLS = new Set(["upscale_image", "remove_background"]);
const ASSET_ID = /^[0-9a-f-]{36}$/;

/**
 * Checks a button's call before it runs: a known tool, small inputs, picture ids that look like ids.
 *
 * @param name - The tool.
 * @param input - Its arguments.
 * @returns Why it is refused, or undefined when it may run.
 */
export function quickActionProblem(name: string, input: unknown): string | undefined {
  if (!SESSION_TOOLS.has(name) && !BUTTON_TOOLS.has(name)) return `${name} cannot run from a button.`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The input must be an object.";
  if (JSON.stringify(input).length > 8000) return "The input is too long.";
  const i = input as Record<string, unknown>;
  if (BUTTON_TOOLS.has(name) && !(typeof i.asset === "string" && ASSET_ID.test(i.asset))) return "Give the picture's asset id.";
  if (name === "unity_import_sprite" && !(typeof i.file === "string" && ASSET_ID.test(i.file))) return "Give the picture's asset id.";
  if ((name === "generate_image" || name === "make_pbr_texture") && !(typeof i.prompt === "string" && i.prompt.trim())) return "Give the prompt.";
  if (name === "unity_create_pbr_material") {
    // A button only passes library pictures of a set it showed, and only ever puts it on the selection.
    const maps = i.maps;
    if (!maps || typeof maps !== "object" || Array.isArray(maps) || !Object.values(maps).length || !Object.values(maps).every((v) => typeof v === "string" && ASSET_ID.test(v))) return "Give the maps as library picture ids.";
    if (i.apply_to !== undefined && !(Array.isArray(i.apply_to) && i.apply_to.length === 1 && i.apply_to[0] === "selection")) return "A button only puts the material on the selected objects.";
  }
  return undefined;
}

/** @returns Whether a tool is one only the buttons have (made by {@link quickTool}). */
export function isButtonTool(name: string): boolean {
  return BUTTON_TOOLS.has(name);
}

/**
 * The names a chat's buttons can run now: the session's own tools from the list, and the button-only tools whose
 * service is there.
 *
 * @param sessionTools - The chat's tool names.
 * @param q - The services.
 */
export function quickActionNames(sessionTools: readonly string[], q: QuickServices): string[] {
  const names = sessionTools.filter((n) => SESSION_TOOLS.has(n));
  if (q.upscale) names.push("upscale_image");
  if (q.removeBackground) names.push("remove_background");
  return names.sort();
}

/**
 * A button-only tool: Upscale (4×) or Remove background on a picture of the chat. The result is a new picture (a new
 * asset), so the original stays and both show in the side canvas's history.
 *
 * @param name - "upscale_image" or "remove_background".
 * @param assets - Where pictures are kept.
 * @param q - The services.
 * @returns The tool, or undefined when its service is not there.
 */
export function quickTool(name: string, assets: AssetStore, q: QuickServices): AgentTool | undefined {
  const picture = async (input: Record<string, unknown>) => {
    const got = await assets.get(String(input.asset ?? ""));
    if (!got || !got.asset.mimeType.startsWith("image/")) throw new Error("That picture is not in KesherAI's library any more.");
    return got;
  };
  const spec = (description: string) => ({ name, description, inputSchema: { type: "object", properties: { asset: { type: "string" } }, required: ["asset"] } });
  if (name === "upscale_image" && q.upscale) {
    const upscale = q.upscale;
    return {
      risk: "safe",
      spec: spec("Upscale a picture 4× (Real-ESRGAN, on this computer)."),
      run: async (input, ctx) => {
        if (q.upscaleReady && !(await q.upscaleReady())) return { output: "The upscaler is not set up yet. Set it up in the Image editor (Upscale), then press Upscale again." };
        const { asset, data } = await picture(input);
        if (asset.mimeType !== "image/png") return { output: "Only PNG pictures can be upscaled here; open it in the Image editor to convert it." };
        ctx.jobProgress?.({ phase: "upscaling" });
        const out = await upscale(data, ctx.signal);
        const made = await assets.save(out, "image/png", { sourceModelId: "upscale-4x", meta: { from: asset.id } });
        return { output: `Upscaled the picture 4× (new picture ${made.id}).`, assetIds: [made.id] };
      },
    };
  }
  if (name === "remove_background" && q.removeBackground) {
    const remove = q.removeBackground;
    return {
      risk: "safe",
      spec: spec("Remove a picture's background (rembg + BiRefNet, on this computer)."),
      run: async (input, ctx) => {
        if (q.removeBackgroundReady && !q.removeBackgroundReady()) return { output: "The background remover is not set up yet. Set it up in the Image editor (Remove background), then press it again." };
        const { asset, data } = await picture(input);
        ctx.jobProgress?.({ phase: "cutting out" });
        const out = await remove(data);
        const made = await assets.save(out, "image/png", { sourceModelId: "remove-background", meta: { from: asset.id } });
        return { output: `Removed the background (new picture ${made.id}).`, assetIds: [made.id] };
      },
    };
  }
  return undefined;
}
