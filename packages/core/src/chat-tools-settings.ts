/**
 * change_setting (audit F12, like Locally Uncensored 3.0.8): the user asks the chat to change one of KesherAI's
 * settings ("keep meeting recordings for a week", "use Qwen for pictures") and the chat does it, always after an
 * approval card that shows the old and the new value. Only a short list of settings can change this way; access,
 * keys, remote control, permissions and business settings never can (they stay in Settings).
 */
import type { AgentTool } from "@kesher/agent";
import type { KesherConfig } from "./config.js";

/** One setting the chat may change: what it means, and how a value is checked. */
interface Settable {
  about: string;
  /** The checked value, or an error message. */
  check(v: unknown): { value: unknown } | { error: string };
}

const bool = (about: string): Settable => ({ about, check: (v) => (typeof v === "boolean" ? { value: v } : v === "true" || v === "false" ? { value: v === "true" } : { error: "Give true or false." }) });
const int = (about: string, min: number, max: number): Settable => ({
  about,
  check: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: `Give a whole number from ${min} to ${max}.` };
  },
});

/** Kinds of model the active-models settings have. */
const MODEL_KINDS = ["chat", "image", "video", "music", "speech-to-text", "text-to-speech", "embedding", "3d"];

/** The settings the chat may change, by key. */
export const SETTABLE: Record<string, Settable> = {
  "meetings.keepRecording": bool("Keep meeting recordings (off: deleted after the write-up)."),
  "meetings.keepRecordingDays": int("How many days a kept meeting recording stays.", 1, 3650),
  "meetings.speakers": bool("Tell the people on a call apart."),
  "notifications.desktop": bool("A notification on this computer when long work ends."),
  "notifications.waiting": bool("Tell when an agent waits for an approval or an answer."),
  "notifications.minSeconds": int("Notify only for work that took at least this many seconds.", 0, 86_400),
  "notifications.includeText": bool("Put the start of the answer in the notification."),
  "speech.language": { about: 'The spoken language for dictation, e.g. "he", "en" or "auto".', check: (v) => (typeof v === "string" && /^(auto|[a-z]{2,3}(-[A-Za-z]{2})?)$/.test(v) ? { value: v } : { error: 'Give a language code like "he" or "auto".' }) },
  ...Object.fromEntries(
    MODEL_KINDS.map((k): [string, Settable] => [
      `activeModels.${k}`,
      { about: `The ${k} model (its full id, as the models list shows it).`, check: (v) => (typeof v === "string" && v.length > 0 && v.length <= 300 && !/[\r\n]/.test(v) ? { value: v } : { error: "Give the model's id." }) },
    ]),
  ),
};

/**
 * Reads a setting's current value.
 *
 * @param config - KesherAI's settings.
 * @param key - A key of SETTABLE ("meetings.keepRecordingDays").
 * @returns The value, or undefined.
 */
export function currentSetting(config: KesherConfig, key: string): unknown {
  const [group, name] = key.split(".") as [string, string];
  return (config as unknown as Record<string, Record<string, unknown> | undefined>)[group]?.[name];
}

/**
 * Changes one setting (after the approval card) and saves.
 *
 * @param config - KesherAI's settings.
 * @param key - A key of SETTABLE.
 * @param value - The new value, checked.
 * @param save - Saves the settings.
 * @returns What happened, for the model.
 */
export async function applySetting(config: KesherConfig, key: string, value: unknown, save: () => Promise<void> | void): Promise<string> {
  const s = SETTABLE[key];
  if (!s) return `That setting can only be changed in Settings. These can change from a chat: ${Object.keys(SETTABLE).join(", ")}.`;
  const r = s.check(value);
  if ("error" in r) return `Not changed: ${r.error}`;
  const [group, name] = key.split(".") as [string, string];
  const target = (config as unknown as Record<string, Record<string, unknown>>)[group];
  if (!target) return "Not changed: that part of the settings is missing.";
  const before = target[name];
  target[name] = r.value;
  await save();
  return `Changed ${key}: ${show(before)} → ${show(r.value)}. It works from now on; Settings shows it too.`;
}

const show = (v: unknown) => (v === undefined ? "(not set)" : typeof v === "string" ? v : JSON.stringify(v));

/**
 * The chat's change_setting tool. It always shows a card ("meetings.keepRecordingDays: 30 → 7") before it changes
 * anything, whatever the chat's approvals mode.
 *
 * @param config - KesherAI's settings.
 * @param save - Saves them.
 * @returns The tool.
 */
export function settingsTool(config: KesherConfig, save: () => Promise<void> | void): AgentTool {
  const card = (input: Record<string, unknown>) => `${String(input.key)}: ${show(currentSetting(config, String(input.key)))} → ${show(input.value)}`;
  return {
    risk: "exec",
    askFirst: (input) => `${KEY_NOTE} ${card(input)}`,
    preview: async (input) => card(input),
    spec: {
      name: "change_setting",
      description:
        "Change one of KesherAI's own settings when the user asks for it (the user approves a card with the old and new value first). Only these keys: " +
        Object.entries(SETTABLE).map(([k, s]) => `${k} (${s.about})`).join("; ") +
        ". For the look (colours, text size, font) use change_look instead. Anything else is changed by the user in Settings: tell them where.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", enum: Object.keys(SETTABLE) }, value: { description: "The new value (true/false, a number, or text)." } },
        required: ["key", "value"],
      },
    },
    run: async (input) => ({ output: await applySetting(config, String(input.key), input.value, save) }),
  };
}

const KEY_NOTE = "Change a KesherAI setting:";
