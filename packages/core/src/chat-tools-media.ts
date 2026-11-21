/**
 * The tools a chat gets for making things other than text: pictures and video (the active media models), music
 * and 3D (the ready-made ComfyUI flows), and change_look (KesherAI's own look). Moved out of conversations.ts
 * (t7) as plain functions that take the manager's services; the manager calls them.
 */
import { randomInt } from "node:crypto";
import { type AgentTool } from "@kesher/agent";
import { ComfyUIProvider } from "@kesher/providers";
import { type JobProgress, APPEARANCE_COLORS, APPEARANCE_FONTS, APPEARANCE_NAV_GROUPS, APPEARANCE_PRESETS, cleanAppearance, type Appearance } from "@kesher/shared";
import { asksForMusic } from "./chat-tool-groups.js";
import { LOOK_ICON_PAGES, styleLook } from "./look-pictures.js";
import type { ConversationDeps } from "./conversation-deps.js";
import type { Translator } from "./translate.js";
import type { QuickServices } from "./chat-quick-actions.js";
import { PBR_NOTE, pbrTools } from "./pbr-tools.js";


/**
 * Whether an image or video prompt is written mostly in a non-Latin script (Hebrew, Arabic, Cyrillic, CJK), which
 * image models do not understand.
 *
 * @param prompt - The prompt the chat model wrote.
 */
export function nonEnglishPrompt(prompt: string): boolean {
  const letters = prompt.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const foreign = letters.filter((c) => !/[A-Za-z\u00C0-\u024F]/.test(c)).length;
  return foreign / letters.length > 0.3;
}
/**
 * The English prompt for an image, video or music model: as it is when already English, else KesherAI's translation.
 *
 * @param translator - KesherAI's translator (translate.ts), when the server has one.
 * @param prompt - The prompt the chat model wrote.
 * @param signal - Cancels the translation.
 * @returns The prompt to send and whether it was translated; undefined when it is not English and could not be
 *   translated (then the chat model is asked to translate it itself).
 */
export async function englishPromptVia(translator: Pick<Translator, "englishPrompt"> | undefined, prompt: string, signal?: AbortSignal): Promise<{ prompt: string; translated: boolean } | undefined> {
  if (!nonEnglishPrompt(prompt)) return { prompt, translated: false };
  if (!translator) return undefined;
  return translator.englishPrompt(prompt, signal).catch(() => undefined);
}
/** Told to the model when the image model is not ready, so it waits instead of improvising. */
const WAIT_NOTE =
  "Tell the user the image model is downloading and that they can follow it in the downloads circle, then stop. Do not try to make the image another way (no torch/diffusers installs, no drawing code).";

/** Files that help an image model but are not one (ComfyUI's model folders and the usual names). */
export const IMAGE_SUPPORT_FILE = /(^|[\\/])(vae|text_encoders?|clip|clip_vision|loras?|upscale(rs|_models)?|image-support|embeddings)[\\/]|(^|[\\/])[^\\/]*(_vae|-vae|\bvae)[^\\/]*\.(safetensors|ckpt|pt|gguf)$|umt5|t5xxl/i;

/**
 * Tools for the active non-chat models. Today that is `generate_image`
 * for the active image model; video, speech and music follow the same
 * pattern once their providers exist.
 *
 * @param deps - The manager's services.
 * @param quick - The chat buttons' services (the background remover, for make_ui_sprite).
 * @returns Tools and one line per tool for the system prompt.
 */
export function mediaTools(deps: ConversationDeps, quick: () => QuickServices = () => ({})): { tools: AgentTool[]; notes: string[] } {
  const tools: AgentTool[] = [];
  const notes: string[] = [];
  const englishFor = (prompt: string, signal?: AbortSignal) => englishPromptVia(deps.translator, prompt, signal);
  const usable = (id: string | undefined): id is string => {
    if (!id || /(^|[-_./ ])mlx([-_./ ]|$)/i.test(id)) return false;
    // A support file of an image model (a VAE, a text encoder, a LoRA, an upscaler) cannot make a picture on its own.
    // Found on the PC: the active image model was wan_2.1_vae.safetensors (saved before ComfyUI's list left those out).
    if (IMAGE_SUPPORT_FILE.test(id)) return false;
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
        description: "Generate an image (a picture, photo, illustration) from a text prompt. The image is shown to the user. If no image model is ready yet, one is downloaded and the result says how long to wait. Never for a graph of a function, a chart of numbers or a diagram: write a ```graph, ```chart or ```mermaid block in the answer instead (the app draws it, interactive).",
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
      run: async (input, ctx) => {
        // A song is not a picture: a weak local model drew "covers" when asked for an mp3. Send it to make_music.
        if (ctx.lastUser && asksForMusic(ctx.lastUser)) {
          return { output: "Not generated: the user asked for music; use make_music. If make_music is not available, tell the user that music cannot be made right now (ComfyUI or its music model is missing) and offer to install it; do not draw instead." };
        }
        // Image models read English only: a Hebrew (or other non-Latin) prompt comes out as an unrelated picture
        // (a "monkey" became an owl). KesherAI's translator puts it into English; without one, it goes back to the
        // chat model to translate, instead of drawing the wrong thing.
        const en = await englishFor(String(input.prompt ?? ""), ctx.signal);
        if (!en) {
          return { output: "Not generated: the prompt is not in English, and image models only understand English. Translate the user's request into a detailed English prompt (keep every subject, style and detail) and call generate_image again. Do not mention this step to the user." };
        }
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
          prompt: en.prompt,
          ...(typeof input.negative_prompt === "string" ? { negativePrompt: (await englishFor(input.negative_prompt, ctx.signal))?.prompt ?? input.negative_prompt } : {}),
          width: Number(input.width ?? 1024),
          height: Number(input.height ?? 1024),
          steps: 0, // 0 = the model family's own default (4 for FLUX schnell, 8 for turbo models)
          seed: randomInt(2 ** 31),
          ...(ctx.jobProgress ? { onProgress: ctx.jobProgress } : {}),
        }, ctx.signal).catch((err: Error) => {
          if (/getting ready|still downloading/i.test(err.message)) throw new Error(`${err.message} ${WAIT_NOTE}`);
          throw err;
        });
        const assets = await Promise.all(
          files.map((f) => deps.assets.save(f.data, f.mimeType, { sourceModelId: imageModel, ...(f.meta ? { meta: f.meta } : {}) })),
        );
        return { output: `Generated ${assets.length} image(s); the user can see them (ids: ${assets.map((a) => a.id).join(", ")}).${switched}${en.translated ? ` The prompt was translated to English and is shown under the picture: "${en.prompt}".` : ""}`, assetIds: assets.map((a) => a.id), promptUsed: en.prompt };
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
      run: async (input, ctx) => {
        const en = await englishFor(String(input.prompt ?? ""), ctx.signal);
        if (!en) {
          return { output: "Not generated: the prompt is not in English, and video models only understand English. Translate the user's request into a detailed English prompt and call the tool again. Do not mention this step to the user." };
        }
        const r = await video.ensure();
        if (!r.path) return { output: `${r.message ?? "No video model is available."} ${WAIT_NOTE}` };
        const file = await video
          .generate(r.path, { prompt: en.prompt, ...(typeof input.negative_prompt === "string" ? { negativePrompt: (await englishFor(input.negative_prompt, ctx.signal))?.prompt ?? input.negative_prompt } : {}), seconds: Number(input.seconds ?? 2), seed: randomInt(2 ** 31) }, ctx.signal, ctx.jobProgress)
          .catch((err: Error) => {
            if (/getting ready|still downloading/i.test(err.message)) throw new Error(`${err.message} ${WAIT_NOTE}`);
            throw err;
          });
        const asset = await deps.assets.save(file.data, file.mimeType, { sourceModelId: "sdcpp-video", ...(file.meta ? { meta: file.meta } : {}) });
        return { output: `Generated a video; the user can watch it.${en.translated ? ` The prompt was translated to English and is shown under the video: "${en.prompt}".` : ""}`, videoIds: [asset.id], promptUsed: en.prompt };
      },
    });
  }
  tools.push(...flowTools(deps, notes));
  // One request to a tileable PBR set or a UI sprite (pbr-tools.ts).
  const textures = pbrTools({
    ...(deps.comfyGraph && deps.config.parts?.nodes !== false && on("images") ? { comfy: deps.comfyGraph } : {}),
    assets: deps.assets,
    activeCheckpoint: () => {
      const id = deps.config.activeModels.image;
      try {
        const r = id ? deps.registry.resolve(id) : undefined;
        return r && r.provider instanceof ComfyUIProvider ? r.providerModelId : undefined;
      } catch {
        return undefined;
      }
    },
    ...(tools.find((t) => t.spec.name === "generate_image") ? { generate: tools.find((t) => t.spec.name === "generate_image")! } : {}),
    removeBackground: () => {
      const q = quick();
      return q.removeBackground ? { remove: q.removeBackground, ready: () => q.removeBackgroundReady?.() ?? true } : undefined;
    },
  });
  if (textures.length) notes.push(PBR_NOTE);
  tools.push(...textures);
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

/** The languages ACE-Step 1.5 sings in (ComfyUI's TextEncodeAceStepAudio1.5). */
const MUSIC_LANGUAGES = new Set("ar az bg bn ca cs da de el en es fa fi fr he hi hr ht hu id is it ja ko la lt ms ne nl no pa pl pt ro ru sa sk sr sv sw ta te th tl tr uk ur vi yue zh".split(" "));

/**
 * A song's language for ACE-Step 1.5.
 *
 * @param v - A language code or name from the model ("he", "Hebrew", "iw").
 * @returns A code ACE-Step 1.5 knows ("en" when unknown).
 */
export function musicLanguage(v: unknown): string {
  const t = String(v ?? "").trim().toLowerCase();
  const named: Record<string, string> = { hebrew: "he", iw: "he", english: "en", arabic: "ar", spanish: "es", french: "fr", german: "de", russian: "ru", japanese: "ja", korean: "ko", chinese: "zh", cantonese: "yue", italian: "it", portuguese: "pt" };
  const code = named[t] ?? t.slice(0, 3).replace(/[^a-z]/g, "");
  return MUSIC_LANGUAGES.has(code) ? code : MUSIC_LANGUAGES.has(code.slice(0, 2)) ? code.slice(0, 2) : "en";
}

/**
 * A key for ACE-Step 1.5 ("C major" … "B minor", with sharps or flats).
 *
 * @param v - A key from the model ("a minor", "F#", "Bb maj").
 * @returns The key as the node lists it, or undefined.
 */
export function musicKey(v: unknown): string | undefined {
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*(maj(?:or)?|min(?:or)?|m)?\s*$/.exec(String(v ?? ""));
  if (!m) return undefined;
  const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2];
  const root = m[1]!.toUpperCase() + acc;
  if (["E#", "B#", "Fb", "Cb"].includes(root)) return undefined;
  return `${root} ${m[3] && /^m(in)?/.test(m[3]) && !/^maj/.test(m[3]) ? "minor" : "major"}`;
}

/**
 * A square cover picture for a song, with the active image model (none: undefined).
 *
 * @param deps - The chat's dependencies.
 * @param tags - The song's style.
 * @param title - Its title.
 * @param signal - Stops it.
 * @returns The picture's asset id.
 */
export async function songCover(deps: ConversationDeps, tags: string, title: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  const id = deps.config.activeModels.image;
  if (!id || IMAGE_SUPPORT_FILE.test(id) || deps.config.parts?.images === false) return undefined;
  const { provider, providerModelId } = deps.registry.resolve(id);
  if (!provider.generateImage) return undefined;
  // No words on the picture: image models misspell them (and a Hebrew title in letters they cannot draw).
  const prompt = `Album cover art for a ${tags.slice(0, 300)} song${title ? ` called "${title.slice(0, 80)}"` : ""}. Striking, simple composition, rich colors, square. No text, no letters, no words.`;
  const files = await provider.generateImage({ providerModelId, prompt, width: 768, height: 768, steps: 0, seed: randomInt(2 ** 31) }, signal);
  const f = files[0];
  if (!f) return undefined;
  return (await deps.assets.save(f.data, f.mimeType, { sourceModelId: id, meta: { use: "song-cover" } })).id;
}

/**
 * make_music and make_3d: the ready-made ComfyUI flows, from the chat.
 * A missing model (several GB) is downloaded only after the user agrees.
 */
export function flowTools(deps: ConversationDeps, notes: string[]): AgentTool[] {
  const flows = deps.flows;
  if (!flows || deps.config.parts?.nodes === false) return [];
  /** A prompt in English for a ComfyUI model (translated when needed); the prompt as it is when that fails. */
  const englishOr = async (prompt: string, signal?: AbortSignal) => (await englishPromptVia(deps.translator, prompt, signal))?.prompt ?? prompt;
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
    "animate_picture sets a picture in motion (Wan 2.2 5B; a video that starts from it, e.g. a shot's last frame to continue it). make_sound makes a sound effect or ambiance from a description (Stable Audio 3 Small-SFX), seconds long; make_music writes a song (style tags and lyrics, in the song's own language and letters, Hebrew too) with ACE-Step 1.5 in ComfyUI; check the lyrics' spelling and rhythm before calling it (a song sung from clumsy lyrics sounds clumsy). make_3d turns a picture of one object into a 3D model (GLB) with Hunyuan3D 2. Both take minutes. If they say a download is needed, ask the user first.",
  );
  // ACE-Step 1.5 XL when it is here (better, above all in languages it saw less), else 1.5; the first ACE-Step only
  // when it is already here and 1.5 is not (no second download needed).
  const musicFlow = () => pickMusicFlow((id) => flows.state(id).ready);
  const music: AgentTool = {
    risk: "safe",
    askFirst: (input) => askDownload(musicFlow())(input),
    spec: {
      name: "make_music",
      description: "Make a song or a piece of music from style tags and lyrics (ACE-Step 1.5 in ComfyUI), 10 seconds to 10 minutes. The user gets a player. Takes from seconds to a few minutes.",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "string", description: "Style in English: genre, mood, instruments, voice, production. E.g. 'pop, upbeat, female vocals, piano, warm'." },
          lyrics: { type: "string", description: "Lyrics with [Verse], [Chorus], [Bridge] markers, in the song's language and its own letters (Hebrew in Hebrew letters). Write them to be sung: short lines of about the same length (6-9 syllables), simple everyday words spelled correctly, a chorus that repeats, rhymes at line ends; no long or rare words. For music without singing use [Instrumental]." },
          language: { type: "string", description: "The lyrics' language code: en, he, ar, es, fr, de, ru, ja, ko, zh… (default en)." },
          seconds: { type: "number", description: "Length in seconds, 10–600 (default 60)." },
          bpm: { type: "number", description: "Tempo, 40–220 (optional)." },
          key: { type: "string", description: "Key, like 'A minor' or 'F# major' (optional)." },
          title: { type: "string", description: "The song's title (for its cover picture)." },
          cover: { type: "boolean", description: "Also make a cover picture with the image model (default true; false when the user does not want one)." },
          download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
        },
        required: ["tags"],
      },
    },
    run: async (input, ctx) => {
      const id = musicFlow();
      const blocked = gate(id, input.download);
      if (blocked) return { output: blocked };
      const v15 = id.startsWith("music-ace-step-15");
      const seconds = Math.min(v15 ? 600 : 240, Math.max(10, Number(input.seconds ?? 60) || 60));
      // The style tags in English (the music model reads English tags; lyrics stay in their own language).
      const tags = (await englishOr(String(input.tags ?? ""), ctx.signal)).slice(0, 1000);
      const files = await flows.run(id, (flow) => {
        const enc = flow["2"]!.inputs;
        // Bounded (scan 75): the words go into ComfyUI's text encoder and into the song's saved details.
        enc.tags = tags;
        enc.lyrics = String(input.lyrics ?? (v15 ? "[Instrumental]" : "[instrumental]")).slice(0, 8000);
        flow["4"]!.inputs.seconds = seconds;
        flow["8"]!.inputs.seed = randomInt(2 ** 31);
        if (v15) {
          enc.duration = seconds;
          enc.seed = randomInt(2 ** 31);
          enc.language = musicLanguage(input.language);
          const bpm = Number(input.bpm);
          if (bpm >= 40 && bpm <= 220) enc.bpm = Math.round(bpm);
          const key = musicKey(input.key);
          if (key) enc.keyscale = key;
        }
      }, ctx.signal, ctx.jobProgress);
      const audio = files.filter((f) => f.mimeType.startsWith("audio/"));
      if (!audio.length) return { output: "ComfyUI finished but saved no sound." };
      const assets = await Promise.all(audio.map((f) => deps.assets.save(f.data, f.mimeType, { sourceModelId: id === "music-ace-step-15-xl" ? "comfyui/ace-step-1.5-xl" : v15 ? "comfyui/ace-step-1.5" : "comfyui/ace-step", meta: { tags: String(input.tags ?? "").slice(0, 1000), lyrics: String(input.lyrics ?? "").slice(0, 8000), ...(input.title ? { title: String(input.title).slice(0, 200) } : {}) } })));
      // A cover picture, like Gemini's and Suno's songs: with the active image model, when there is one that runs
      // here; a failure leaves the song without one.
      const cover = input.cover === false ? undefined : await songCover(deps, String(input.tags ?? ""), input.title ? String(input.title) : undefined, ctx.signal).catch(() => undefined);
      if (cover) {
        return { output: `Made the song (${seconds} s) and its cover picture; the user can play and download them.`, audioIds: assets.map((a) => a.id), assetIds: [cover] };
      }
      return { output: `Made the song (${seconds} s${v15 ? "" : ", with the first ACE-Step: ACE-Step 1.5 sings in more languages, on the Nodes page"}); the user can play and download it.`, audioIds: assets.map((a) => a.id) };
    },
  };
  // Sound effects (Stable Audio 3 Small-SFX): rain, a door, footsteps, an engine, a crowd — not songs (make_music).
  const sfxId = "sfx-stable-audio-3-small";
  const sound: AgentTool = {
    risk: "safe",
    askFirst: askDownload(sfxId),
    spec: {
      name: "make_sound",
      description: "Make a sound effect or ambiance from a description (Stable Audio 3 Small-SFX in ComfyUI): rain, a door creaking, footsteps, an engine, a crowd, birds; 1 second to 2 minutes. Not for songs or music (use make_music). The user gets a player. Takes seconds to a minute.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The sound in English, concrete: what makes it, where, how near, how it changes. E.g. 'heavy rain on a tin roof, distant thunder, close'." },
          seconds: { type: "number", description: "Length in seconds, 1–120 (default 10)." },
          download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing (about 3.5 GB)." },
        },
        required: ["prompt"],
      },
    },
    run: async (input, ctx) => {
      const blocked = gate(sfxId, input.download);
      if (blocked) return { output: blocked };
      const seconds = Math.min(120, Math.max(1, Math.round(Number(input.seconds ?? 10) || 10)));
      // Bounded (as make_music): the words go into ComfyUI's text encoder and the sound's saved details.
      const prompt = (await englishOr(String(input.prompt ?? ""), ctx.signal)).slice(0, 1000);
      const files = await flows.run(sfxId, (flow) => {
        flow["3"]!.inputs.text = prompt;
        flow["5"]!.inputs.seconds = seconds;
        flow["6"]!.inputs.seed = randomInt(2 ** 31);
      }, ctx.signal, ctx.jobProgress);
      const audio = files.filter((f) => f.mimeType.startsWith("audio/"));
      if (!audio.length) return { output: "ComfyUI finished but saved no sound." };
      const assets = await Promise.all(audio.map((f) => deps.assets.save(f.data, f.mimeType, { sourceModelId: "comfyui/stable-audio-3-small-sfx", meta: { prompt } })));
      return { output: `Made the sound (${seconds} s); the user can play and download it.`, audioIds: assets.map((a) => a.id), promptUsed: prompt };
    },
  };
  // A picture set in motion (Wan 2.2 TI2V 5B in ComfyUI): the video editor's "continue this shot" (its last frame),
  // Premiere's reference frames for its video model.
  const animate: AgentTool = {
    risk: "safe",
    askFirst: askDownload("video-wan22-ti2v"),
    spec: {
      name: "animate_picture",
      description: "Set a picture in motion: a 1–5 second video that starts from the picture (Wan 2.2 5B in ComfyUI, 24 fps), with the motion described in words. Use it to continue a video's shot from its last frame, or to bring a still to life. Slow (minutes on a gaming graphics card).",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "The picture: the path the user attached it as (\"[Attached: …]\"), a file in this chat's folder." },
          prompt: { type: "string", description: "The motion and what happens, in English: camera move, subject's action, mood." },
          seconds: { type: "number", description: "Length, 1–5 (default 5)." },
          download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
        },
        required: ["image", "prompt"],
      },
    },
    run: async (input, ctx) => {
      const blocked = gate("video-wan22-ti2v", input.download);
      if (blocked) return { output: blocked };
      const rel = String(input.image ?? "").replace(/^\[?Attached:\s*/i, "").replace(/\]$/, "").trim();
      if (!ctx.workspace) return { output: "There is no folder for this chat to read the picture from." };
      const { resolve: resolvePath, relative, basename } = await import("node:path");
      const { readFile } = await import("node:fs/promises");
      const file = resolvePath(ctx.workspace, rel);
      if (relative(ctx.workspace, file).startsWith("..")) return { output: "The picture must be one attached to this chat." };
      const data = await readFile(file).catch(() => undefined);
      if (!data) return { output: `No picture at ${rel}. Ask the user to attach it.` };
      // Wan 2.2 5B's sizes: wide 1280×704 or tall 704×1280, by the picture's own shape; frames 4n+1 at 24 a second.
      const size = pictureSize(new Uint8Array(data));
      const tall = size ? size.h > size.w : false;
      const seconds = Math.min(5, Math.max(1, Number(input.seconds ?? 5) || 5));
      const frames = 4 * Math.round((seconds * 24) / 4) + 1;
      const prompt = (await englishOr(String(input.prompt ?? ""), ctx.signal)).slice(0, 1000);
      const files = await flows.run("video-wan22-ti2v", async (flow, upload) => {
        flow["4"]!.inputs.image = await upload(new Uint8Array(data), `kesher-${randomInt(1e9)}-${basename(file)}`);
        flow["5"]!.inputs.text = prompt;
        Object.assign(flow["7"]!.inputs, { width: tall ? 704 : 1280, height: tall ? 1280 : 704, length: frames });
        flow["9"]!.inputs.seed = randomInt(2 ** 31);
      }, ctx.signal, ctx.jobProgress);
      const vid = files.find((f) => f.mimeType.startsWith("video/"));
      if (!vid) return { output: "ComfyUI finished but saved no video." };
      const asset = await deps.assets.save(vid.data, vid.mimeType, { sourceModelId: "comfyui/wan-2.2-ti2v-5b", meta: { prompt } });
      return { output: `Made a ${seconds}-second video from the picture; the user can watch it.`, videoIds: [asset.id], promptUsed: prompt };
    },
  };
  const model3d: AgentTool = {
    risk: "safe",
    askFirst: (input) => askDownload(input.colours === false ? "3d-hunyuan3d" : "3d-trellis2")(input),
    spec: {
      name: "make_3d",
      description: "Turn a picture of one object into a 3D model (GLB): with colours: true, painted with its colours and materials (TRELLIS.2, PBR textures; better, slower, needs ComfyUI 0.34+); otherwise the shape only (Hunyuan3D 2, faster). The user gets the file. Slow (minutes).",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "The picture: the path the user attached it as (\"[Attached: …]\"), a file in this chat's folder." },
          colours: { type: "boolean", description: "With its colours and materials (TRELLIS.2). Default true; false for the shape only." },
          download: { type: "boolean", description: "Only after the user agreed: download the model if it is missing." },
        },
        required: ["image"],
      },
    },
    run: async (input, ctx) => {
      const colours = input.colours !== false;
      const blocked = gate(colours ? "3d-trellis2" : "3d-hunyuan3d", input.download);
      if (blocked) return { output: blocked };
      if (!ctx.workspace) return { output: "There is no folder for this chat to read the picture from." };
      const made = await pictureTo3d(flows, ctx.workspace, String(input.image ?? ""), ctx.signal, colours, ctx.jobProgress);
      if ("error" in made) return { output: made.error };
      const out = made.path;
      return { output: `Made the 3D model ${out} (GLB, ${colours ? "with its colours and materials" : "shape only"}); the user can download it and open it in Blender, Unreal or Unity.`, files: [out.split("\\").join("/")] };
    },
  };
  return [music, sound, animate, model3d];
}

/**
 * A picture of one object turned into a 3D model (GLB, shape only) with the ready flow Hunyuan3D 2 in ComfyUI, saved
 * in the chat's folder under 3d/. Used by the chat's make_3d and by the 3D editor's "A model from words" (its route).
 *
 * @param flows - The ready flows' runner (ready and allowed is checked by the caller).
 * @param workspace - The chat's folder.
 * @param image - The picture's path in it (an "[Attached: …]" is taken off).
 * @param signal - To stop it.
 * @param colours - With its colours and materials (TRELLIS.2, PBR textures) instead of the shape only (Hunyuan3D 2).
 * @returns The model's path in the folder, or what went wrong.
 */
export async function pictureTo3d(flows: NonNullable<ConversationDeps["flows"]>, workspace: string, image: string, signal: AbortSignal, colours = false, onProgress?: (p: JobProgress) => void): Promise<{ path: string } | { error: string }> {
  const rel = image.replace(/^\[?Attached:\s*/i, "").replace(/\]$/, "").trim();
  const { resolve: resolvePath, relative, join: joinPath, dirname, basename } = await import("node:path");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const file = resolvePath(workspace, rel);
  if (relative(workspace, file).startsWith("..")) return { error: "The picture must be one attached to this chat." };
  const data = await readFile(file).catch(() => undefined);
  if (!data) return { error: `No picture at ${rel}. Ask the user to attach it.` };
  const files = await flows.run(colours ? "3d-trellis2" : "3d-hunyuan3d", async (flow, upload) => {
    const name = await upload(new Uint8Array(data), `kesher-${randomInt(1e9)}-${basename(file)}`);
    if (colours) {
      // TRELLIS.2's graph (comfy-flows.ts "3d-trellis2"): the picture, and a new seed for its structure.
      flow["122"]!.inputs.image = name;
      flow["3"]!.inputs.seed = randomInt(2 ** 31);
    } else {
      flow["2"]!.inputs.image = name;
      flow["7"]!.inputs.seed = randomInt(2 ** 31);
    }
  }, signal, onProgress);
  const glb = files.find((f) => /\.glb$/i.test(f.filename) || f.mimeType === "model/gltf-binary");
  if (!glb) return { error: "ComfyUI finished but saved no 3D model." };
  const out = joinPath("3d", `${basename(file).replace(/\.[^.]+$/, "")}-${Date.now().toString(36)}.glb`);
  await mkdir(dirname(joinPath(workspace, out)), { recursive: true });
  await writeFile(joinPath(workspace, out), glb.data);
  return { path: out.split("\\").join("/") };
}

/**
 * A PNG's or JPEG's size from its first bytes (no decoding), for picking a video's shape.
 *
 * @param b - The file's bytes.
 * @returns Width and height, or undefined for another kind of file.
 */
export function pictureSize(b: Uint8Array): { w: number; h: number } | undefined {
  const be = (i: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + (b[i + k] ?? 0); return v; };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: be(16, 4), h: be(20, 4) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the frame header (SOF0–SOF15, not DHT, JPG or DAC).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be(i + 7, 2), h: be(i + 5, 2) };
      i += 2 + be(i + 2, 2);
    }
  }
  return undefined;
}

/**
 * Which song model to use: ACE-Step 1.5 XL when it is here, else 1.5; the first ACE-Step only when it is already here
 * and 1.5 is not (no second download needed). With none here, 1.5 (the one to download).
 *
 * @param ready - Whether a flow's model is downloaded.
 * @returns The flow id.
 */
export function pickMusicFlow(ready: (id: string) => boolean): string {
  if (ready("music-ace-step-15-xl")) return "music-ace-step-15-xl";
  if (!ready("music-ace-step-15") && ready("music-ace-step")) return "music-ace-step";
  return "music-ace-step-15";
}

/**
 * Paints a model that is already made: the ready flow "3d-paint-views" sees it from four sides, draws each side by the
 * words (Stable Diffusion 1.5 + ControlNet depth) and bakes them onto it as its colour texture. The result is saved
 * beside it in the chat's folder (…-painted-….glb). Used by the 3D editor's "Paint this model" (its route).
 *
 * @param flows - The ready flows' runner (ready and allowed is checked by the caller).
 * @param workspace - The chat's folder.
 * @param model - The model's path in it (a GLB).
 * @param look - How it should look, in English words (cut to 600 characters).
 * @param signal - To stop it.
 * @returns The painted model's path in the folder, or what went wrong.
 */
export async function paintModel(flows: NonNullable<ConversationDeps["flows"]>, workspace: string, model: string, look: string, signal: AbortSignal): Promise<{ path: string } | { error: string }> {
  const { resolve: resolvePath, relative, join: joinPath, dirname, basename } = await import("node:path");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const file = resolvePath(workspace, model);
  if (relative(workspace, file).startsWith("..") || !/\.glb$/i.test(file)) return { error: "The model must be a GLB in this chat's files." };
  const data = await readFile(file).catch(() => undefined);
  if (!data) return { error: `No model at ${model}.` };
  const files = await flows.run("3d-paint-views", async (flow, upload) => {
    // Into input/3d, where ComfyUI's Load 3D lists files.
    flow["1"]!.inputs.model_file = await upload(new Uint8Array(data), `kesher-${randomInt(1e9)}-${basename(file)}`, "3d");
    flow["9"]!.inputs.text = `${look.slice(0, 600)}, the whole object, evenly lit, flat studio light, no shadows, detailed texture`;
    flow["13"]!.inputs.seed = randomInt(2 ** 31);
  }, signal);
  const glb = files.find((f) => /\.glb$/i.test(f.filename) || f.mimeType === "model/gltf-binary");
  if (!glb) return { error: "ComfyUI finished but saved no model." };
  const out = joinPath(dirname(relative(workspace, file)), `${basename(file).replace(/\.[^.]+$/, "")}-painted-${Date.now().toString(36)}.glb`);
  await mkdir(dirname(joinPath(workspace, out)), { recursive: true });
  await writeFile(joinPath(workspace, out), glb.data);
  return { path: out.split("\\").join("/") };
}
