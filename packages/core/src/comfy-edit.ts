/**
 * Editing a ComfyUI flow in words, with the local chat model: the flow (in
 * ComfyUI's API format: node id → `{ class_type, inputs }`) and the user's
 * request go to the model, which answers with the whole changed flow. The
 * answer is checked against the nodes ComfyUI really has, and sent back
 * once with the mistakes when it does not fit.
 */

/** A flow in ComfyUI's API format. */
export type ApiFlow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

/** What ComfyUI says about one node (from /object_info). */
export interface NodeInfo {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
  output?: string[];
  display_name?: string;
  category?: string;
}

/** Nodes worth offering a small model when it needs to add one (the full list is hundreds). */
const COMMON = ["LoraLoader", "LoraLoaderModelOnly", "CheckpointLoaderSimple", "CLIPTextEncode", "KSampler", "KSamplerAdvanced", "EmptyLatentImage", "VAEDecode", "VAEEncode", "LoadImage", "SaveImage", "PreviewImage", "ImageScale", "ImageScaleBy", "LatentUpscale", "LatentUpscaleBy", "UpscaleModelLoader", "ImageUpscaleWithModel", "ControlNetLoader", "ControlNetApplyAdvanced", "CLIPSetLastLayer", "VAELoader", "UNETLoader", "CLIPLoader", "DualCLIPLoader", "ModelSamplingSD3", "FluxGuidance", "EmptySD3LatentImage", "EmptyHunyuanLatentVideo", "SaveAnimatedWEBP", "ImageInvert", "ImageBlur", "ImageSharpen", "SetLatentNoiseMask", "InpaintModelConditioning"];

/** The input names and choices of a node, shortened for a prompt. */
function describe(name: string, info: NodeInfo): string {
  const part = (o: Record<string, unknown> | undefined) =>
    Object.entries(o ?? {})
      .map(([k, v]) => {
        const spec = Array.isArray(v) ? v[0] : v;
        if (Array.isArray(spec)) return `${k}: one of [${spec.slice(0, 12).map((x) => JSON.stringify(x)).join(", ")}${spec.length > 12 ? ", …" : ""}]`;
        return `${k}: ${String(spec)}`;
      })
      .join("; ");
  return `${name} (in: ${part(info.input?.required)}${info.input?.optional ? ` | optional: ${part(info.input.optional)}` : ""}) → out: [${(info.output ?? []).join(", ")}]`;
}

/**
 * Checks a flow against the nodes ComfyUI has.
 *
 * @param flow - The flow.
 * @param nodes - ComfyUI's /object_info.
 * @returns The problems, empty when it fits.
 */
export function checkFlow(flow: unknown, nodes: Record<string, NodeInfo>): string[] {
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) return ["The answer is not a flow object (node id → { class_type, inputs })."];
  const problems: string[] = [];
  const f = flow as ApiFlow;
  for (const [id, n] of Object.entries(f)) {
    if (!n || typeof n !== "object" || typeof n.class_type !== "string" || typeof n.inputs !== "object") {
      problems.push(`Node ${id} has no class_type and inputs.`);
      continue;
    }
    const info = nodes[n.class_type];
    if (!info) {
      problems.push(`Node ${id}: ComfyUI has no node "${n.class_type}".`);
      continue;
    }
    for (const req of Object.keys(info.input?.required ?? {})) if (!(req in n.inputs)) problems.push(`Node ${id} (${n.class_type}) is missing the input "${req}".`);
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" && !(v[0] in f)) problems.push(`Node ${id} input "${k}" links to node ${v[0]}, which is not in the flow.`);
      const spec = (info.input?.required?.[k] ?? info.input?.optional?.[k]) as unknown[] | undefined;
      const choices = Array.isArray(spec) && Array.isArray(spec[0]) ? (spec[0] as unknown[]) : undefined;
      if (choices && !Array.isArray(v) && !choices.includes(v)) problems.push(`Node ${id} input "${k}" is ${JSON.stringify(v)}, but ComfyUI only has: ${choices.slice(0, 15).map((x) => JSON.stringify(x)).join(", ")}.`);
    }
  }
  return problems;
}

/** The JSON object in a model's answer (it may add words or a code fence around it). */
export function jsonFrom(text: string): unknown {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(clean)?.[1];
  const raw = fenced ?? clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

/**
 * Changes a flow as the user asked.
 *
 * @param flow - The flow now.
 * @param request - What to change, in the user's words.
 * @param nodes - ComfyUI's /object_info.
 * @param ask - Sends messages to the chat model and returns its answer.
 * @returns The changed flow, and a short note from the model.
 * @throws Error when the model's answer still does not fit after a second try.
 */
export async function editFlow(flow: ApiFlow, request: string, nodes: Record<string, NodeInfo>, ask: (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<string>): Promise<{ flow: ApiFlow; note: string }> {
  const used = [...new Set(Object.values(flow).map((n) => n.class_type))];
  const extra = COMMON.filter((n) => nodes[n] && !used.includes(n));
  const system = `You edit ComfyUI flows. A flow is JSON in ComfyUI's API format: { "<node id>": { "class_type": "<node>", "inputs": { "<name>": <value or ["<other node id>", <output index>]> } } }.
Change the flow the way the user asks, keep everything else as it is, and answer with ONE JSON object: { "note": "<one short sentence, in the user's language, saying what you changed>", "flow": <the whole changed flow> }.
Use only nodes and choices listed below. New nodes get new string ids (numbers not used yet). Prompts inside CLIPTextEncode are written in English.

Nodes in this flow:
${used.filter((n) => nodes[n]).map((n) => describe(n, nodes[n]!)).join("\n")}

Other nodes you may add:
${extra.map((n) => describe(n, nodes[n]!)).join("\n")}`;
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    { role: "user", content: `The flow:\n${JSON.stringify(flow)}\n\nWhat to change: ${request}` },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await ask(messages);
    let parsed: { note?: unknown; flow?: unknown } | undefined;
    let problems: string[];
    try {
      parsed = jsonFrom(answer) as { note?: unknown; flow?: unknown };
      problems = checkFlow(parsed.flow, nodes);
    } catch {
      problems = ["The answer was not valid JSON."];
    }
    if (!problems.length && parsed) return { flow: parsed.flow as ApiFlow, note: typeof parsed.note === "string" ? parsed.note : "" };
    messages.push({ role: "assistant", content: answer }, { role: "user", content: `That flow does not work in ComfyUI:\n- ${problems.slice(0, 12).join("\n- ")}\nFix it and answer again with the JSON object only.` });
  }
  throw new Error("The model could not make a flow that works in ComfyUI. Try a simpler change, or a larger chat model.");
}
