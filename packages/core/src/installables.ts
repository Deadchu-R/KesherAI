/**
 * Things a chat may need that are not installed yet, and the Install button for them (docs/WORK_LIST.md "Chat step
 * 8b", Roee 2026-11-20 19:38): when the chosen tool needs an engine or a model that is missing, the assistant says so
 * and calls offer_install; the chat shows "Install", which opens a window with what it is, its size and where it is
 * saved; after installing, the chat goes on with the request by itself (routes/installables.ts).
 *
 * Every install reuses the app's own installer (the image/video setup, ComfyUI, the engines, speech); nothing here
 * downloads by itself, and no path comes from the chat or the model: things are saved in the folders set in Settings.
 */
import type { AgentTool } from "@kesher/agent";

/** Where an installable is saved: the models folder, or the engines folder (which moves to the heavy-data drive). */
export type InstallFolder = "models" | "engines";

/** What the Install window shows about one thing, before any live state. */
export interface InstallableInfo {
  id: string;
  he: string;
  en: string;
  /** One line: what it does for the user. */
  aboutHe: string;
  aboutEn: string;
  folder: InstallFolder;
}

/** The things the Install button knows, by id (the ids the router's `needs` and offer_install use). */
export const INSTALLABLES: readonly InstallableInfo[] = [
  { id: "image-model", he: "מודל תמונות", en: "Image model", aboutHe: "יוצר תמונות במחשב שלך (Qwen-Image או FLUX, לפי כרטיס המסך).", aboutEn: "Makes pictures on your computer (Qwen-Image or FLUX, by your graphics card).", folder: "models" },
  { id: "video-model", he: "מודל וידאו", en: "Video model", aboutHe: "יוצר סרטונים קצרים במחשב שלך (Wan 2.1).", aboutEn: "Makes short videos on your computer (Wan 2.1).", folder: "models" },
  { id: "comfyui", he: "ComfyUI", en: "ComfyUI", aboutHe: "מנוע זרימות לתמונות ווידאו מתקדמים.", aboutEn: "A workflow engine for advanced pictures and video.", folder: "engines" },
  { id: "chat-engine", he: "מנוע הצ'אט המובנה", en: "Built-in chat engine", aboutHe: "llama.cpp: מריץ מודלי שפה במחשב שלך.", aboutEn: "llama.cpp: runs language models on your computer.", folder: "engines" },
  { id: "speech-to-text", he: "המרת דיבור לטקסט", en: "Speech to text", aboutHe: "whisper.cpp: מתמלל הקלטות וסרטונים.", aboutEn: "whisper.cpp: transcribes recordings and videos.", folder: "engines" },
  { id: "text-to-speech", he: "הקראה בקול", en: "Text to speech", aboutHe: "Kokoro: מקריא טקסט בקול טבעי.", aboutEn: "Kokoro: reads text aloud in a natural voice.", folder: "engines" },
  { id: "ffmpeg", he: "FFmpeg", en: "FFmpeg", aboutHe: "קורא וממיר קבצי שמע ווידאו.", aboutEn: "Reads and converts audio and video files.", folder: "engines" },
];

/** The tool's name; its call shows the Install button in the chat (ChatCards/InstallOffer). */
export const OFFER_INSTALL_TOOL = "offer_install";

/**
 * offer_install: shows an Install button in the chat for something missing. It installs nothing itself (the user
 * presses the button), so it runs without asking.
 *
 * @param ready - Whether a thing is already installed (then the model is told to just go on).
 * @returns The tool.
 */
export function offerInstallTool(ready: (id: string) => Promise<boolean>): AgentTool {
  return {
    risk: "read",
    spec: {
      name: OFFER_INSTALL_TOOL,
      description: `Show the user an Install button for something this request needs that is not installed. Ids: ${INSTALLABLES.map((i) => `${i.id} (${i.aboutEn})`).join("; ")}. After calling it, tell the user in one short sentence and stop; the chat continues by itself once it is installed.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", enum: INSTALLABLES.map((i) => i.id) }, why: { type: "string", description: "Why the request needs it, in the user's language (one short line)." } },
        required: ["id"],
      },
    },
    run: async (input) => {
      const item = INSTALLABLES.find((i) => i.id === input.id);
      if (!item) throw new Error(`Unknown id. Use one of: ${INSTALLABLES.map((i) => i.id).join(", ")}.`);
      if (await ready(item.id).catch(() => false)) return { output: `${item.en} is already installed. Go on with the request.` };
      return { output: `The Install button for ${item.en} is shown in the chat. Tell the user in one short sentence and stop here; after it is installed the chat continues by itself.` };
    },
  };
}
