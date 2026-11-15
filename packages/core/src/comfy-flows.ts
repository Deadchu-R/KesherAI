import { existsSync } from "node:fs";
import { join } from "node:path";
import { listHubFiles, type DownloadManager } from "@kesher/downloads";

/**
 * Ready-made ComfyUI flows the Nodes page loads with one tap: music with
 * ACE-Step and 3D objects with Hunyuan3D 2 — both built into ComfyUI, no
 * custom nodes. Each flow lists the model files it needs; they download
 * into KesherAI's models folder, which ComfyUI reads too (`music/`, `3d/`).
 *
 * The flows follow ComfyUI's own examples (github.com/Comfy-Org/example_workflows),
 * in ComfyUI's API format. A checkpoint name is filled in when the flow
 * loads, from what ComfyUI lists, because ComfyUI writes sub-folders with
 * the computer's own separator ("music\\…" on Windows).
 */

/** A model file a flow needs. */
export interface FlowFile {
  label: string;
  /** Hugging Face repo and file (size and checksum come from the Hub). */
  repo: string;
  path: string;
  /** Path inside the models folder, with "/". */
  rel: string;
  /** Approximate size, GB. */
  gb: number;
}

/** A node in ComfyUI's API format. */
export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}

/** One ready-made flow. */
export interface ReadyFlow {
  id: string;
  icon: string;
  title: { en: string; he: string };
  description: { en: string; he: string };
  /** The model's licence, shown before downloading. */
  license: { name: string; url: string };
  files: FlowFile[];
  /** Node ids whose `ckpt_name` is set to the file with this name. */
  checkpoints: Record<string, string>;
  /** Other loaders' inputs (a diffusion model, text encoders, a VAE): set to the name ComfyUI lists in that folder. */
  names?: Array<{ node: string; input: string; folder: "diffusion_models" | "text_encoders" | "vae"; file: string }>;
  flow: Record<string, ApiNode>;
}

const seed = () => Math.floor(Math.random() * 2 ** 48);

/** The flows. */
export function readyFlows(): ReadyFlow[] {
  return [
    {
      // ACE-Step 1.5 (January 2026), as in ComfyUI's own template (audio_ace_step_1_5_checkpoint): the turbo model in
      // one file, 8 steps; 10 seconds to 10 minutes; lyrics in 50+ languages in their own letters, Hebrew among them.
      id: "music-ace-step-15",
      icon: "🎵",
      title: { en: "Music from words (ACE-Step 1.5)", he: "מוזיקה ממילים (ACE-Step 1.5)" },
      description: {
        en: "Write the style and the lyrics, in any of 50+ languages (Hebrew too); ACE-Step 1.5 makes a song of up to 10 minutes, in seconds to a minute on a gaming graphics card.",
        he: "כותבים סגנון ומילים, באחת מ-50+ שפות (גם בעברית), ו-ACE-Step 1.5 יוצר שיר של עד 10 דקות, תוך שניות עד דקה בכרטיס גרפי של גיימינג.",
      },
      license: { name: "MIT", url: "https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE" },
      files: [
        {
          label: "ACE-Step 1.5 turbo (all in one)",
          repo: "Comfy-Org/ace_step_1.5_ComfyUI_files",
          path: "checkpoints/ace_step_1.5_turbo_aio.safetensors",
          rel: "music/ace_step_1.5_turbo_aio.safetensors",
          gb: 10,
        },
      ],
      checkpoints: { "1": "ace_step_1.5_turbo_aio.safetensors" },
      flow: {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "ace_step_1.5_turbo_aio.safetensors" }, _meta: { title: "ACE-Step 1.5" } },
        "2": {
          class_type: "TextEncodeAceStepAudio1.5",
          inputs: {
            clip: ["1", 1],
            tags: "pop, upbeat, female vocals, piano, guitar, drums, catchy, bright",
            lyrics: "[Verse]\nMorning light on the window\nCoffee warm in my hands\nEvery road that I follow\nLeads me back where I stand\n\n[Chorus]\nSing it loud, sing it free\nThis is where I want to be\n",
            seed: seed(),
            bpm: 120,
            duration: 60,
            timesignature: "4",
            language: "en",
            keyscale: "C major",
            generate_audio_codes: true,
            cfg_scale: 2,
            temperature: 0.85,
            top_p: 0.9,
            top_k: 0,
            min_p: 0,
          },
          _meta: { title: "Style and lyrics" },
        },
        "3": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
        "4": { class_type: "EmptyAceStep1.5LatentAudio", inputs: { seconds: 60, batch_size: 1 }, _meta: { title: "Length (seconds)" } },
        "5": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
        "8": { class_type: "KSampler", inputs: { model: ["5", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: seed(), steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        "9": { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["1", 2] } },
        "10": { class_type: "SaveAudioMP3", inputs: { audio: ["9", 0], filename_prefix: "audio/KesherAI", quality: "V0" } },
      },
    },
    {
      // ACE-Step 1.5 XL with the 4B planner, as in ComfyUI's template audio_ace_step1_5_xl_turbo: a bigger music model
      // and a bigger language model that plans the song before it is sung; better in languages it saw less, slower.
      id: "music-ace-step-15-xl",
      icon: "🎼",
      title: { en: "Music from words, higher quality (ACE-Step 1.5 XL)", he: "מוזיקה ממילים, איכות גבוהה (ACE-Step 1.5 XL)" },
      description: {
        en: "The bigger ACE-Step 1.5: an XL music model and a 4B planner. Better songs, especially in languages like Hebrew; slower, and a bigger download.",
        he: "ACE-Step 1.5 הגדול: מודל מוזיקה XL ומתכנן 4B. שירים טובים יותר, במיוחד בשפות כמו עברית; איטי יותר, והורדה גדולה יותר.",
      },
      license: { name: "MIT", url: "https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE" },
      files: [
        { label: "ACE-Step 1.5 XL turbo", repo: "Comfy-Org/ace_step_1.5_ComfyUI_files", path: "split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors", rel: "video/music/acestep_v1.5_xl_turbo_bf16.safetensors", gb: 10 },
        { label: "ACE-Step 1.5 planner (Qwen 4B)", repo: "Comfy-Org/ace_step_1.5_ComfyUI_files", path: "split_files/text_encoders/qwen_4b_ace15.safetensors", rel: "text_encoders/qwen_4b_ace15.safetensors", gb: 8 },
        { label: "ACE-Step 1.5 text encoder (Qwen 0.6B)", repo: "Comfy-Org/ace_step_1.5_ComfyUI_files", path: "split_files/text_encoders/qwen_0.6b_ace15.safetensors", rel: "text_encoders/qwen_0.6b_ace15.safetensors", gb: 1.2 },
        { label: "ACE-Step 1.5 VAE", repo: "Comfy-Org/ace_step_1.5_ComfyUI_files", path: "split_files/vae/ace_1.5_vae.safetensors", rel: "vae/ace_1.5_vae.safetensors", gb: 0.3 },
      ],
      checkpoints: {},
      names: [
        { node: "1", input: "unet_name", folder: "diffusion_models", file: "acestep_v1.5_xl_turbo_bf16.safetensors" },
        { node: "11", input: "clip_name1", folder: "text_encoders", file: "qwen_0.6b_ace15.safetensors" },
        { node: "11", input: "clip_name2", folder: "text_encoders", file: "qwen_4b_ace15.safetensors" },
        { node: "12", input: "vae_name", folder: "vae", file: "ace_1.5_vae.safetensors" },
      ],
      flow: {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "acestep_v1.5_xl_turbo_bf16.safetensors", weight_dtype: "default" }, _meta: { title: "ACE-Step 1.5 XL" } },
        "11": { class_type: "DualCLIPLoader", inputs: { clip_name1: "qwen_0.6b_ace15.safetensors", clip_name2: "qwen_4b_ace15.safetensors", type: "ace", device: "default" }, _meta: { title: "Text encoder and planner" } },
        "12": { class_type: "VAELoader", inputs: { vae_name: "ace_1.5_vae.safetensors" } },
        "2": {
          class_type: "TextEncodeAceStepAudio1.5",
          inputs: {
            clip: ["11", 0],
            tags: "pop, upbeat, female vocals, piano, guitar, drums, catchy, bright",
            lyrics: "[Verse]\nMorning light on the window\nCoffee warm in my hands\n\n[Chorus]\nSing it loud, sing it free\nThis is where I want to be\n",
            seed: seed(),
            bpm: 120,
            duration: 60,
            timesignature: "4",
            language: "en",
            keyscale: "C major",
            generate_audio_codes: true,
            cfg_scale: 2,
            temperature: 0.85,
            top_p: 0.9,
            top_k: 0,
            min_p: 0,
          },
          _meta: { title: "Style and lyrics" },
        },
        "3": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
        "4": { class_type: "EmptyAceStep1.5LatentAudio", inputs: { seconds: 60, batch_size: 1 }, _meta: { title: "Length (seconds)" } },
        "5": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
        "8": { class_type: "KSampler", inputs: { model: ["5", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: seed(), steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        "9": { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["12", 0] } },
        "10": { class_type: "SaveAudioMP3", inputs: { audio: ["9", 0], filename_prefix: "audio/KesherAI", quality: "V0" } },
      },
    },
    {
      id: "music-ace-step",
      icon: "🎵",
      title: { en: "Music from words (ACE-Step v1, older)", he: "מוזיקה ממילים (ACE-Step v1, הישן)" },
      description: {
        en: "The first ACE-Step (2025): a song up to 4 minutes, lyrics in English letters. ACE-Step 1.5 above is better and faster; this stays for those who already downloaded it.",
        he: "ACE-Step הראשון (2025): שיר של עד 4 דקות, מילים באותיות אנגליות. ACE-Step 1.5 שלמעלה טוב ומהיר יותר; זה נשאר למי שכבר הוריד אותו.",
      },
      license: { name: "Apache-2.0", url: "https://github.com/ace-step/ACE-Step/blob/main/LICENSE" },
      files: [
        {
          label: "ACE-Step v1 3.5B",
          repo: "Comfy-Org/ACE-Step_ComfyUI_repackaged",
          path: "all_in_one/ace_step_v1_3.5b.safetensors",
          rel: "music/ace_step_v1_3.5b.safetensors",
          gb: 7.7,
        },
      ],
      checkpoints: { "1": "ace_step_v1_3.5b.safetensors" },
      flow: {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "ace_step_v1_3.5b.safetensors" }, _meta: { title: "ACE-Step" } },
        "2": {
          class_type: "TextEncodeAceStepAudio",
          inputs: {
            clip: ["1", 1],
            tags: "pop, upbeat, female vocals, piano, guitar, drums, catchy, bright",
            lyrics: "[verse]\nMorning light on the window\nCoffee warm in my hands\nEvery road that I follow\nLeads me back where I stand\n\n[chorus]\nSing it loud, sing it free\nThis is where I want to be\n",
            lyrics_strength: 0.99,
          },
          _meta: { title: "Style and lyrics" },
        },
        "3": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
        "4": { class_type: "EmptyAceStepLatentAudio", inputs: { seconds: 60, batch_size: 1 }, _meta: { title: "Length (seconds)" } },
        "5": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 5 } },
        "6": { class_type: "LatentOperationTonemapReinhard", inputs: { multiplier: 1 }, _meta: { title: "Vocals (higher = louder)" } },
        "7": { class_type: "LatentApplyOperationCFG", inputs: { model: ["5", 0], operation: ["6", 0] } },
        "8": { class_type: "KSampler", inputs: { model: ["7", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: seed(), steps: 50, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        "9": { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 0], vae: ["1", 2] } },
        "10": { class_type: "SaveAudioMP3", inputs: { audio: ["9", 0], filename_prefix: "audio/KesherAI", quality: "V0" } },
      },
    },
    {
      id: "3d-hunyuan3d",
      icon: "🧊",
      title: { en: "3D object from a picture (Hunyuan3D 2)", he: "אובייקט תלת-ממד מתמונה (Hunyuan3D 2)" },
      description: {
        en: "Load a picture of one object on a plain background; Hunyuan3D 2 makes a 3D model (GLB, without colors) you can open in Blender, Unreal or Unity.",
        he: "טוענים תמונה של אובייקט אחד על רקע חלק, ו-Hunyuan3D 2 יוצר מודל תלת-ממד (GLB, בלי צבעים) שאפשר לפתוח ב-Blender, Unreal או Unity.",
      },
      license: { name: "Tencent Hunyuan 3D 2.0 Community License (not for use in the EU, UK or South Korea)", url: "https://huggingface.co/tencent/Hunyuan3D-2/blob/main/LICENSE" },
      files: [
        {
          label: "Hunyuan3D 2 (shape)",
          repo: "tencent/Hunyuan3D-2",
          path: "hunyuan3d-dit-v2-0/model.fp16.safetensors",
          rel: "3d/hunyuan3d-dit-v2.safetensors",
          gb: 4.9,
        },
      ],
      checkpoints: { "1": "hunyuan3d-dit-v2.safetensors" },
      flow: {
        "1": { class_type: "ImageOnlyCheckpointLoader", inputs: { ckpt_name: "hunyuan3d-dit-v2.safetensors" }, _meta: { title: "Hunyuan3D 2" } },
        "2": { class_type: "LoadImage", inputs: { image: "example.png" }, _meta: { title: "Picture of the object" } },
        "3": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["1", 1], image: ["2", 0], crop: "none" } },
        "4": { class_type: "Hunyuan3Dv2Conditioning", inputs: { clip_vision_output: ["3", 0] } },
        "5": { class_type: "EmptyLatentHunyuan3Dv2", inputs: { resolution: 3072, batch_size: 1 } },
        "6": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 1 } },
        "7": { class_type: "KSampler", inputs: { model: ["6", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0], seed: seed(), steps: 20, cfg: 1, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
        "8": { class_type: "VAEDecodeHunyuan3D", inputs: { samples: ["7", 0], vae: ["1", 2], num_chunks: 8000, octree_resolution: 256 } },
        "9": { class_type: "VoxelToMeshBasic", inputs: { voxel: ["8", 0], threshold: 0.6 } },
        "10": { class_type: "SaveGLB", inputs: { mesh: ["9", 0], filename_prefix: "mesh/KesherAI" } },
      },
    },
    {
      // Wan 2.2 TI2V 5B (Alibaba, Apache-2.0), as in ComfyUI's own template (video_wan2_2_5B_ti2v): one model for
      // picture-to-video and text-to-video, 24 fps, fits a 24 GB card at 1280x704 (smaller is faster).
      id: "video-wan22-ti2v",
      icon: "🎬",
      title: { en: "Video from a picture (Wan 2.2 5B)", he: "וידאו מתמונה (Wan 2.2 5B)" },
      description: {
        en: "Load a picture and describe the motion (\"the camera slowly moves in, leaves blow in the wind\"); Wan 2.2 makes a 5-second video at 24 frames a second. Without a picture it makes the video from the description alone.",
        he: "טוענים תמונה ומתארים את התנועה (\"המצלמה מתקרבת לאט, עלים נעים ברוח\"), ו-Wan 2.2 יוצר סרטון של 5 שניות ב-24 פריימים לשנייה. בלי תמונה הוא יוצר וידאו מהתיאור בלבד.",
      },
      license: { name: "Apache-2.0 (Wan 2.2)", url: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B" },
      files: [
        { label: "Wan 2.2 TI2V 5B", repo: "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", path: "split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", rel: "video/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", gb: 10 },
        { label: "Wan 2.2 VAE", repo: "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", path: "split_files/vae/wan2.2_vae.safetensors", rel: "vae/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/split_files/vae/wan2.2_vae.safetensors", gb: 1.4 },
        { label: "Wan text encoder (umt5 xxl)", repo: "Comfy-Org/Wan_2.1_ComfyUI_repackaged", path: "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", rel: "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", gb: 6.7 },
      ],
      checkpoints: {},
      names: [
        { node: "1", input: "unet_name", folder: "diffusion_models", file: "wan2.2_ti2v_5B_fp16.safetensors" },
        { node: "2", input: "clip_name", folder: "text_encoders", file: "umt5_xxl_fp8_e4m3fn_scaled.safetensors" },
        { node: "3", input: "vae_name", folder: "vae", file: "wan2.2_vae.safetensors" },
      ],
      flow: {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" }, _meta: { title: "Wan 2.2 TI2V 5B" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: "wan2.2_vae.safetensors" } },
        "4": { class_type: "LoadImage", inputs: { image: "example.png" }, _meta: { title: "Start picture" } },
        "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "the camera slowly moves in, gentle natural motion, cinematic, detailed" }, _meta: { title: "The motion you want" } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "blurry, low quality, static, distorted, text, watermark, extra limbs" }, _meta: { title: "What to avoid" } },
        "7": { class_type: "Wan22ImageToVideoLatent", inputs: { vae: ["3", 0], start_image: ["4", 0], width: 1280, height: 704, length: 121, batch_size: 1 }, _meta: { title: "Size and length (121 frames = 5 s)" } },
        "8": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
        "9": { class_type: "KSampler", inputs: { model: ["8", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed: seed(), steps: 20, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1 } },
        "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
        "11": { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: 24 } },
        "12": { class_type: "SaveVideo", inputs: { video: ["11", 0], filename_prefix: "video/KesherAI", format: "auto", codec: "auto" } },
      },
    },
    {
      id: "styled-frame",
      icon: "🎞️",
      title: { en: "A styled game frame (keeps the scene's shapes)", he: "פריים מעוצב מהמשחק (שומר על הצורות של הסצנה)" },
      description: {
        en: "Load a screenshot of your game (Unity's Game view or Unreal's viewport) and describe the look (\"watercolor, warm sunset\", \"anime cel shading\"). The edges of the scene guide a ControlNet, so the layout stays and only the style changes. Use it for concept art, key art or a look test before you build it in the engine.",
        he: "טוענים צילום מסך מהמשחק (Game view ב-Unity או ה-viewport ב-Unreal) ומתארים את המראה (\"צבעי מים, שקיעה חמה\", \"אנימה cel shading\"). הקווים של הסצנה מנחים ControlNet, כך שהקומפוזיציה נשמרת ורק הסגנון משתנה. טוב לקונספט, לתמונת שער או לבדיקת מראה לפני שבונים אותו במנוע.",
      },
      license: { name: "CreativeML Open RAIL-M (Stable Diffusion 1.5); ControlNet 1.1: OpenRAIL", url: "https://huggingface.co/spaces/CompVis/stable-diffusion-license" },
      files: [
        { label: "Stable Diffusion 1.5 (fp16)", repo: "Comfy-Org/stable-diffusion-v1-5-archive", path: "v1-5-pruned-emaonly-fp16.safetensors", rel: "image/v1-5-pruned-emaonly-fp16.safetensors", gb: 2.1 },
        { label: "ControlNet 1.1 canny (fp16)", repo: "comfyanonymous/ControlNet-v1-1_fp16_safetensors", path: "control_v11p_sd15_canny_fp16.safetensors", rel: "controlnet/control_v11p_sd15_canny_fp16.safetensors", gb: 0.7 },
      ],
      checkpoints: { "1": "v1-5-pruned-emaonly-fp16.safetensors" },
      flow: {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5-pruned-emaonly-fp16.safetensors" }, _meta: { title: "Stable Diffusion 1.5" } },
        "2": { class_type: "LoadImage", inputs: { image: "example.png" }, _meta: { title: "Screenshot of the game" } },
        "3": { class_type: "ImageScale", inputs: { image: ["2", 0], upscale_method: "lanczos", width: 768, height: 432, crop: "center" }, _meta: { title: "Size (16:9)" } },
        "4": { class_type: "Canny", inputs: { image: ["3", 0], low_threshold: 0.3, high_threshold: 0.6 }, _meta: { title: "The scene's edges" } },
        "5": { class_type: "ControlNetLoader", inputs: { control_net_name: "control_v11p_sd15_canny_fp16.safetensors" } },
        "6": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "watercolor painting of a game scene, soft warm sunset light, painterly, detailed" }, _meta: { title: "The look you want" } },
        "7": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "blurry, low quality, text, watermark, distorted" }, _meta: { title: "What to avoid" } },
        "8": { class_type: "ControlNetApplyAdvanced", inputs: { positive: ["6", 0], negative: ["7", 0], control_net: ["5", 0], image: ["4", 0], strength: 0.9, start_percent: 0, end_percent: 1, vae: ["1", 2] }, _meta: { title: "Keep the shapes (strength)" } },
        "9": { class_type: "VAEEncode", inputs: { pixels: ["3", 0], vae: ["1", 2] } },
        "10": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["8", 0], negative: ["8", 1], latent_image: ["9", 0], seed: seed(), steps: 25, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 0.75 }, _meta: { title: "How much to change (denoise)" } },
        "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
        "12": { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: "styled/KesherAI" } },
      },
    },
  ];
}

/**
 * @param flow - A ready-made flow.
 * @param modelsDir - KesherAI's models folder.
 * @param downloads - To see what is downloading.
 * @returns Whether its files are there, downloading, and how much is missing.
 */
export function flowState(flow: ReadyFlow, modelsDir: string, downloads: DownloadManager): { ready: boolean; downloading: boolean; missingGb: number } {
  const missing = flow.files.filter((f) => !existsSync(join(modelsDir, ...f.rel.split("/"))));
  const downloading = missing.some((f) => downloads.list().some((j) => j.dest === join(modelsDir, ...f.rel.split("/")) && !["failed", "cancelled", "done"].includes(j.status)));
  return { ready: !missing.length, downloading, missingGb: Math.round(missing.reduce((n, f) => n + f.gb, 0) * 10) / 10 };
}

/**
 * Starts downloading a flow's missing files (follow them in the downloads circle).
 *
 * @param flow - The flow.
 * @param modelsDir - KesherAI's models folder.
 * @param downloads - The download manager.
 * @returns How many downloads started.
 * @throws Error when the Hub no longer has a file.
 */
export async function setupFlow(flow: ReadyFlow, modelsDir: string, downloads: DownloadManager): Promise<number> {
  let n = 0;
  for (const f of flow.files) {
    const dest = join(modelsDir, ...f.rel.split("/"));
    if (existsSync(dest) || downloads.list().some((j) => j.dest === dest && !["failed", "cancelled", "done"].includes(j.status))) continue;
    const hub = (await listHubFiles(f.repo)).find((x) => x.path === f.path);
    if (!hub) throw new Error(`${f.repo} no longer has ${f.path}.`);
    downloads.enqueue({ url: hub.url, dest, size: hub.size, ...(hub.sha256 ? { sha256: hub.sha256 } : {}), label: `${flow.icon} ${f.label}` });
    n++;
  }
  return n;
}

/**
 * Puts the real checkpoint names (as ComfyUI lists them) into a flow.
 *
 * @param flow - The flow.
 * @param available - Checkpoint names ComfyUI offers, e.g. `music\\ace_step_v1_3.5b.safetensors`.
 * @returns A copy with `ckpt_name` filled in; names not found stay as they were.
 */
export function withCheckpoints(flow: ReadyFlow, available: readonly string[], inFolder: Partial<Record<string, readonly string[]>> = {}): Record<string, ApiNode> {
  const out = structuredClone(flow.flow);
  const named = (list: readonly string[], file: string) => list.find((a) => a.split(/[\\/]/).pop() === file);
  for (const [id, file] of Object.entries(flow.checkpoints)) {
    const found = named(available, file);
    if (found && out[id]) out[id].inputs.ckpt_name = found;
  }
  for (const n of flow.names ?? []) {
    const found = named(inFolder[n.folder] ?? [], n.file);
    const node = out[n.node];
    if (found && node) node.inputs[n.input] = found;
  }
  return out;
}

/**
 * The names ComfyUI lists in each folder a flow's loaders read (its /models/<folder>), for withCheckpoints.
 *
 * @param flow - The flow.
 * @param list - Lists one folder (ComfyUI's /models/<folder>; empty when it fails).
 * @returns The names by folder.
 */
export async function folderNames(flow: ReadyFlow, list: (folder: string) => Promise<string[]>): Promise<Record<string, string[]>> {
  const folders = [...new Set((flow.names ?? []).map((n) => n.folder))];
  return Object.fromEntries(await Promise.all(folders.map(async (f) => [f, await list(f).catch(() => [])] as const)));
}
