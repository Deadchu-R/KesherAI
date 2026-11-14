/**
 * The tools a chat gets for making things other than text: pictures and video (the active media models), music
 * and 3D (the ready-made ComfyUI flows), and change_look (KesherAI's own look). Moved out of conversations.ts
 * (t7) as plain functions that take the manager's services; the manager calls them.
 */
import { randomInt } from "node:crypto";
import { type AgentTool } from "@kesher/agent";
import { APPEARANCE_COLORS, APPEARANCE_FONTS, APPEARANCE_NAV_GROUPS, APPEARANCE_PRESETS, cleanAppearance, type Appearance } from "@kesher/shared";
import { LOOK_ICON_PAGES, styleLook } from "./look-pictures.js";
import type { ConversationDeps } from "./conversation-deps.js";

/** Told to the model when the image model is not ready, so it waits instead of improvising. */
const WAIT_NOTE =
  "Tell the user the image model is downloading and that they can follow it in the downloads circle, then stop. Do not try to make the image another way (no torch/diffusers installs, no drawing code).";

/**
 * Tools for the active non-chat models. Today that is `generate_image`
 * for the active image model; video, speech and music follow the same
 * pattern once their providers exist.
 *
 * @param deps - The manager's services.
 * @returns Tools and one line per tool for the system prompt.
 */
export function mediaTools(deps: ConversationDeps): { tools: AgentTool[]; notes: string[] } {
  const tools: AgentTool[] = [];
  const notes: string[] = [];
  const usable = (id: string | undefined): id is string => {
    if (!id || /(^|[-_./ ])mlx([-_./ ]|$)/i.test(id)) return false;
    try {
      return !!deps.registry.resolve(id).provider.generateImage;
    } catch {
      return false;
    }
  };
  const active = deps.config.activeModels.image;
  const on = (part: string) => deps.config.parts?.[part] !== false;
  if (on("images") && (usable(active) || deps.ensureImageModel)) {
    notes.push(
      usable(active)
        ? `generate_image uses the user's active image model (${active}). Write the prompt in English.`
        : "generate_image makes pictures with KesherAI's built-in image engine; if no image model is ready it downloads one that fits this computer and says so. Write the prompt in English.",
      "For every request for a picture, photo, drawing, illustration or image, call generate_image. Never make images another way: do not install torch, diffusers or Stable Diffusion, and do not draw with turtle, PIL, matplotlib or SVG code, unless the user explicitly asks for code. If generate_image says the model is still downloading, tell the user that and stop.",
    );
    tools.push({
      risk: "safe",
      spec: {
        name: "generate_image",
        description: "Generate an image from a text prompt. The image is shown to the user. If no image model is ready yet, one is downloaded and the result says how long to wait.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Detailed description of the image, in English." },
            negative_prompt: { type: "string" },
            width: { type: "integer", description: "Default 1024." },
            height: { type: "integer", description: "Default 1024." },
          },
          required: ["prompt"],
        },
      },
      run: async (input) => {
        let imageModel = deps.config.activeModels.image;
        let switched = "";
        if (!usable(imageModel)) {
          const before = imageModel;
          const r = (await deps.ensureImageModel?.()) ?? {};
          const why = before ? `The user's image model ${before} does not run on this computer${/mlx/i.test(before) ? " (it is an Apple MLX build, for Macs only)" : ""}. ` : "";
          if (!r.modelId) return { output: why + (r.message ?? "No image model is available. Ask the user to pick one under Models → Images.") + ` ${WAIT_NOTE}` };
          imageModel = r.modelId;
          if (before) switched = ` ${why}KesherAI switched to ${r.modelId}, which runs here; tell the user, and that they can change it under Models → Images.`;
        }
        const { provider, providerModelId } = deps.registry.resolve(imageModel);
        const files = await provider.generateImage!({
          providerModelId,
          prompt: String(input.prompt ?? ""),
          ...(typeof input.negative_prompt === "string" ? { negativePrompt: input.negative_prompt } : {}),
          width: Number(input.width ?? 1024),
          height: Number(input.height ?? 1024),
          steps: 0, // 0 = the model family's own default (4 for FLUX schnell, 8 for turbo models)
          seed: randomInt(2 ** 31),
        }).catch((err: Error) => {
          if (/getting ready|still downloading/i.test(err.message)) throw new Error(`${err.message} ${WAIT_NOTE}`);
          throw err;
        });
        const assets = await Promise.all(
          files.map((f) => deps.assets.save(f.data, f.mimeType, { sourceModelId: imageModel, ...(f.meta ? { meta: f.meta } : {}) })),
        );
        return { output: `Generated ${assets.length} image(s); the user can see them (ids: ${assets.map((a) => a.id).join(", ")}).${switched}`, assetIds: assets.map((a) => a.id) };
      },
    });
  }
  // A part the user switched off: say so instead of "I have no such tool" (found on the PC: the model told the
  // user video was impossible when it was only off).
  if (deps.video && !on("video")) notes.push("Making videos is switched off (Settings → Parts → Video). If the user asks for a video, tell them it can be switched on there (it downloads the video model, about 7 GB).");
  if (deps.video && on("video")) {
    const video = deps.video;
    notes.push("generate_video makes a short video clip (about 2 seconds) from an English description with the built-in video engine; it takes a few minutes. If the model is still downloading, tell the user and stop.");
    tools.push({
      risk: "safe",
      spec: {
        name: "generate_video",
        description: "Generate a short video clip (1–5 seconds) from a text description. The video is shown to the user. Slow (minutes). If no video model is ready, one is downloaded and the result says so.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Detailed description of the scene and the motion, in English." },
            negative_prompt: { type: "string" },
            seconds: { type: "number", description: "Length, 1–5 (default 2)." },
          },
          required: ["prompt"],
        },
      },
      run: async (input) => {
        const r = await video.ensure();
        if (!r.path) return { output: `${r.message ?? "No video model is available."} ${WAIT_NOTE}` };
        const file = await video
          .generate(r.path, { prompt: String(input.prompt ?? ""), ...(typeof input.negative_prompt === "string" ? { negativePrompt: input.negative_prompt } : {}), seconds: Number(input.seconds ?? 2), seed: randomInt(2 ** 31) })
          .catch((err: Error) => {
            if (/getting ready|still downloading/i.test(err.message)) throw new Error(`${err.message} ${WAIT_NOTE}`);
            throw err;
          });
        const asset = await deps.assets.save(file.data, file.mimeType, { sourceModelId: "sdcpp-video", ...(file.meta ? { meta: file.meta } : {}) });
        return { output: "Generated a video; the user can watch it.", videoIds: [asset.id] };
      },
    });
  }
  tools.push(...flowTools(deps, notes));
  tools.push(...lookTools(deps, notes));
  return { tools, notes };
}

/**
 * change_look: the user asks in words ("make it light", "bigger text",
 * "green accent", "put Work first") and the model changes KesherAI's look.
 * Only looks: checked by cleanAppearance, nothing else can change.
 */
export function lookTools(deps: Pick<ConversationDeps, "look" | "assets">, notes: string[]): AgentTool[] {
  const look = deps.look;
  if (!look) return [];
  notes.push(
    "change_look changes how KesherAI itself looks (colours, font, text size, corners, spacing, background, icons, motion and the order of the tool groups) when the user asks for it. When the user names a style (a series, a film, a game, a place: \"like One Piece\"), ALWAYS pass style with its name in English — change_look then finds real pictures of it on the web by itself (a wallpaper as the background, icons for the tools) — and in the same call give colours, font and motion that feel like it. Pass only what should change; undo: true goes back one step. After it, tell the user in one line what changed (and the picture credits it gives) and that they can say \"undo\" or open Settings → Appearance.",
  );
  const fonts = APPEARANCE_FONTS.map((f) => `${f.id}${f.hebrew ? "" : " (no Hebrew letters)"}`).join(", ");
  return [
    {
      risk: "safe",
      spec: {
        name: "change_look",
        description: "Change how the KesherAI app looks. Every field is optional; what is not given stays as it is. The page updates at once.",
        inputSchema: {
          type: "object",
          properties: {
            preset: { type: "string", enum: APPEARANCE_PRESETS.map((p) => p.id), description: "Start from a ready-made look (graphite is the default; paper is light). Clears the user's own colours." },
            colors: {
              type: "object",
              description: "Colours as #rrggbb. bg: page; panel: cards; panel-2: fields and menus; raised: hover; text; muted: secondary text; accent: buttons and what is selected. Keep text readable on bg.",
              properties: Object.fromEntries(APPEARANCE_COLORS.map((c) => [c, { type: "string" }])),
            },
            font: { type: "string", description: `One of: ${fonts}.` },
            fontSize: { type: "number", description: "Text size in px, 12–20 (default 15)." },
            radius: { type: "number", description: "Corner roundness in px, 0 (square) – 28 (very round); default 16." },
            density: { type: "string", enum: ["compact", "normal", "roomy"] },
            background: { type: "object", description: "{ kind: 'plain' }, { kind: 'gradient', from: '#rrggbb', to: '#rrggbb', angle: 0–360 }, or a picture: { kind: 'image', assetId: '<id of a picture made in this chat>', dim: 0–90 (how much the page colour covers it, default 55) }. For a picture background, make the picture first (generate_image, wide), then use its id." },
            navOrder: { type: "array", items: { type: "string", enum: [...APPEARANCE_NAV_GROUPS] }, description: "The tool groups top to bottom (create, work, assistant, system)." },
            navHide: { type: "array", items: { type: "string", enum: [...APPEARANCE_NAV_GROUPS] }, description: "Tool groups to hide from the menus." },
            motion: { type: "string", enum: ["none", "subtle", "lively"], description: "How much moves: lively adds a slowly moving background, cards that lift and page transitions." },
            icons: { type: "object", description: "Icons for tools, by page: { \"#/images\": { \"emoji\": \"🏴‍☠️\" } } or { \"assetId\": \"<id of a picture made in this chat>\" }. Pages: #/images, #/pages, #/knowledge, #/models, #/settings, #/nodes, #/unreal, #/unity, #/day, #/compare, #/pipelines, #/personas, #/memory." },
            css: { type: "string", description: "Extra CSS for looks (replaces the previous extra CSS): rules, @media and @keyframes; no @import, no outside addresses (pictures only as url(\"/api/assets/<id>\")), no position: fixed. Classes: .card, .sidebar, .appbar, .page, .home, .greeting, .composer, .app-tile, .phone-tabs, button.primary. Keep it short." },
            style: { type: "string", description: "A style the user named, in English (\"One Piece\", \"Studio Ghibli\", \"cyberpunk city\"): finds pictures of it on the web (a wallpaper for the background, icons for the tools), unless background or icons are given too." },
            pictures: { type: "string", enum: ["both", "background", "icons", "none"], description: "With style: which pictures to look for (default both)." },
            name: { type: "string", description: "A name for the look." },
            homeOrder: { type: "array", items: { type: "string", enum: ["ideas", "recent", "pins"] }, description: "The start screen under the message box, top to bottom: ideas, recent chats, pinned tools." },
            homeHide: { type: "array", items: { type: "string", enum: ["ideas", "recent", "pins"] }, description: "Start-screen parts to hide." },
            tabsOrder: { type: "array", items: { type: "string", enum: ["chats", "new", "tools", "settings"] }, description: "The phone's bottom bar, start to end." },
            reset: { type: "boolean", description: "Back to the default look." },
            undo: { type: "boolean", description: "Go back one step." },
          },
        },
      },
      run: async (input, ctx) => {
        if (input.undo === true) return { output: (await look.undo()) ? "Went back to the previous look." : "There is nothing to undo." };
        if (input.reset === true) {
          await look.set({});
          return { output: "Back to the default look." };
        }
        const credits: string[] = [];
        let found = "";
        // Small models often give the look a name but forget style: a name with no pictures of its own counts as the style.
        const named = typeof input.name === "string" && !input.background && !input.icons ? input.name.replace(/[-_]+/g, " ").replace(/\b(style|theme|look|inspired|design)\b/gi, "").trim() : "";
        const style = (typeof input.style === "string" ? input.style : named).trim().slice(0, 80);
        const want = typeof input.pictures === "string" ? input.pictures : "both";
        const pics: Record<string, unknown> = {};
        if (style && want !== "none") {
          try {
            const r = await styleLook(style, {
              background: want !== "icons" && !input.background,
              iconPages: want !== "background" && !input.icons ? LOOK_ICON_PAGES : [],
              save: async (p, use) => (await deps.assets.save(p.data, p.mimeType, { meta: { use, style, source: p.page, license: p.license, artist: p.artist } })).id,
              signal: ctx.signal,
            });
            if (r.background) pics.background = r.background;
            if (r.icons) pics.icons = r.icons;
            credits.push(...r.credits);
            found = r.background || r.icons ? "" : ` Found no pictures of "${style}" on the web; use emoji icons and a gradient background that fit instead (call again with icons and background).`;
          } catch (err) {
            found = ` Could not search for pictures (${(err as Error).message}); use emoji icons and a gradient instead.`;
          }
        }
        const change = cleanAppearance({ ...input, ...pics });
        if (!Object.keys(change).length) return { output: `Nothing valid to change. Colours must be #rrggbb; fonts and groups must be from the lists.${found}` };
        const cur = look.get();
        const next: Appearance = change.preset ? { ...change } : { ...cur, ...change, colors: { ...cur.colors, ...change.colors }, ...(change.icons ? { icons: { ...cur.icons, ...change.icons } } : {}) };
        if (!next.colors || !Object.keys(next.colors).length) delete next.colors;
        await look.set(next);
        return { output: `Changed the look: ${Object.keys(change).join(", ")}.${credits.length ? ` Pictures: ${credits.join("; ")}.` : ""}${found}` };
      },
    },
  ];
}

/**
 * make_music and make_3d: the ready-made ComfyUI flows, from the chat.
 * A missing model (several GB) is downloaded only after the user agrees.
 */
export function flowTools(deps: ConversationDeps, notes: string[]): AgentTool[] {
  const flows = deps.flows;
  if (!flows || deps.config.parts?.nodes === false) return [];
  const gate = (id: string, download: unknown): string | undefined => {
    const st = flows.state(id);
    if (!st.allowed) return "ComfyUI is turned off by the organisation's business mode.";
    if (!st.installed) return "ComfyUI is not installed. Tell the user to install it once on the Nodes page (Install ComfyUI), then ask again.";
    if (st.ready) return undefined;
    if (st.downloading) return `The model is still downloading (about ${st.missingGb} GB left in total); the user can follow it in the downloads circle. ${WAIT_NOTE}`;
    if (download === true) {
      void flows.setup(id).catch(() => undefined);
      return `Started downloading the model (about ${st.missingGb} GB); tell the user to follow it in the downloads circle and ask again when it is done.`;
    }
    return `This needs a model download of about ${st.missingGb} GB first. Ask the user whether to download it; only if they agree, call again with download: true.`;
  };
  // The yes to a download is the person's (an approval card), never the model's own: seen live, a model told
  // "don't ask me questions" set download: true by itself and started 7.7 GB.
  const askDownload = (id: string) => (input: Record<string, unknown>): string | undefined => {
    if (input.download !== true) return undefined;
    const st = flows.state(id);
    return st.ready || st.downloading ? undefined : `Downloads a model of about ${st.missingGb} GB.`;
  };
  notes.push(
    "make_music writes a song (style tags and lyrics) with ACE-Step in ComfyUI, and make_3d turns a picture of one object into a 3D model (GLB) with Hunyuan3D 2. Both take minutes. If they say a download is needed, ask the user first.",
  );
  const music: AgentTool = {
    risk: "safe",
    askFirst: askDownload("music-ace-step"),
    spec: {
      name: "make_music",
      description: "Make a song or a piece of music from style tags and lyrics (ACE-Step in ComfyUI). The user gets a player. Slow (minutes).",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "string", description: "Style, comma-separated English words: genre, mood, instruments, voice, tempo. E.g. 'pop, upbeat, female vocals, piano, 120 bpm'." },
          lyrics: { type: "string", description: "Lyrics with [verse], [chorus], [bridge] markers, in English letters (other languages written in Latin letters, with [he] or [ja] at the start of the line). For music without singing use [instrumental]." },
          seconds: { type: "number", description: "Length in seconds, 10–240 (default 60)." },
          download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
        },
        required: ["tags"],
      },
    },
    run: async (input, ctx) => {
      const blocked = gate("music-ace-step", input.download);
      if (blocked) return { output: blocked };
      const files = await flows.run("music-ace-step", (flow) => {
        flow["2"]!.inputs.tags = String(input.tags ?? "");
        flow["2"]!.inputs.lyrics = String(input.lyrics ?? "[instrumental]");
        flow["4"]!.inputs.seconds = Math.min(240, Math.max(10, Number(input.seconds ?? 60) || 60));
        flow["8"]!.inputs.seed = randomInt(2 ** 31);
      }, ctx.signal);
      const audio = files.filter((f) => f.mimeType.startsWith("audio/"));
      if (!audio.length) return { output: "ComfyUI finished but saved no sound." };
      const assets = await Promise.all(audio.map((f) => deps.assets.save(f.data, f.mimeType, { sourceModelId: "comfyui/ace-step", meta: { tags: input.tags, lyrics: input.lyrics } })));
      return { output: "Made the song; the user can play and download it.", audioIds: assets.map((a) => a.id) };
    },
  };
  const model3d: AgentTool = {
    risk: "safe",
    askFirst: askDownload("3d-hunyuan3d"),
    spec: {
      name: "make_3d",
      description: "Turn a picture of one object (plain background) into a 3D model (GLB, shape only, no colors) with Hunyuan3D 2 in ComfyUI. The user gets the file. Slow (minutes).",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "The picture: the path the user attached it as (\"[Attached: …]\"), a file in this chat's folder." },
          download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
        },
        required: ["image"],
      },
    },
    run: async (input, ctx) => {
      const blocked = gate("3d-hunyuan3d", input.download);
      if (blocked) return { output: blocked };
      const rel = String(input.image ?? "").replace(/^\[?Attached:\s*/i, "").replace(/\]$/, "").trim();
      if (!ctx.workspace) return { output: "There is no folder for this chat to read the picture from." };
      const { resolve: resolvePath, relative, join: joinPath, dirname, basename } = await import("node:path");
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const file = resolvePath(ctx.workspace, rel);
      if (relative(ctx.workspace, file).startsWith("..")) return { output: "The picture must be one attached to this chat." };
      const data = await readFile(file).catch(() => undefined);
      if (!data) return { output: `No picture at ${rel}. Ask the user to attach it.` };
      const files = await flows.run("3d-hunyuan3d", async (flow, upload) => {
        flow["2"]!.inputs.image = await upload(new Uint8Array(data), `kesher-${randomInt(1e9)}-${basename(file)}`);
        flow["7"]!.inputs.seed = randomInt(2 ** 31);
      }, ctx.signal);
      const glb = files.find((f) => /\.glb$/i.test(f.filename) || f.mimeType === "model/gltf-binary");
      if (!glb) return { output: "ComfyUI finished but saved no 3D model." };
      const out = joinPath("3d", `${basename(file).replace(/\.[^.]+$/, "")}-${Date.now().toString(36)}.glb`);
      await mkdir(dirname(joinPath(ctx.workspace, out)), { recursive: true });
      await writeFile(joinPath(ctx.workspace, out), glb.data);
      return { output: `Made the 3D model ${out} (GLB, shape only); the user can download it and open it in Blender, Unreal or Unity.`, files: [out.split("\\").join("/")] };
    },
  };
  return [music, model3d];
}
