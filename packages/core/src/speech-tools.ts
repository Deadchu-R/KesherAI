import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { resolveForTool, type AgentTool } from "@kesher/agent";
import type { ProviderConfig } from "@kesher/providers";
import { cloudTranscribe, type WhisperEngine } from "./whisper.js";

/**
 * Speech as tools for chats and agents:
 *
 * - `transcribe_audio`: a recording or video → text (whisper.cpp on this
 *   computer, or Groq / OpenAI when connected and chosen), optionally with times.
 * - `speak_text`: text → an audio file the user can play or download (an
 *   OpenAI voice when connected, otherwise the computer's own voices).
 */

/** Cloud services that transcribe through an OpenAI-compatible endpoint. */
export const CLOUD_STT: Record<string, { model: string; label: string; base: string }> = {
  groq: { model: "whisper-large-v3-turbo", label: "Groq (Whisper large-v3 turbo)", base: "https://api.groq.com/openai/v1" },
  openai: { model: "gpt-4o-mini-transcribe", label: "OpenAI", base: "https://api.openai.com/v1" },
};

const WHISPER_READS = /^\.(wav|mp3|flac|ogg)$/i;
const MEDIA = /^\.(wav|mp3|flac|ogg|m4a|aac|opus|wma|webm|mp4|mkv|mov|avi|3gp|amr)$/i;

function run(cmd: string, args: string[], timeout = 600_000, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || err.message).toString().trim().split("\n").slice(-3).join(" ")), { code: (err as NodeJS.ErrnoException).code }));
      else resolve(stdout.toString());
    });
  });
}

/** What the speech tools need. */
export interface SpeechDeps {
  whisper: WhisperEngine;
  /** The user's choice: `auto`, `local` or `cloud:<id>`; and the spoken language. */
  speech: () => { stt: string; language: string };
  providers: () => ProviderConfig[];
}

/**
 * Turns a recording into text with the engine the user chose (like the
 * microphone button does).
 *
 * @param d - Engines and settings.
 * @param data - The file's bytes.
 * @param ext - Its type, e.g. `.mp3`.
 * @param language - `auto` or a code like `he`.
 * @param timestamps - Keep times (local engine only).
 * @returns The text and which engine made it.
 */
export async function transcribeWith(d: SpeechDeps, data: Buffer, ext: string, language: string, timestamps = false): Promise<{ text: string; engine: string }> {
  const { stt } = d.speech();
  const local = await d.whisper.status();
  const clouds = d.providers().filter((p) => CLOUD_STT[p.id] && p.apiKey);
  const cloudId = stt.startsWith("cloud:") ? stt.slice(6) : stt === "auto" && !(local.engine && local.model) ? clouds[0]?.id : undefined;
  if (cloudId) {
    const p = d.providers().find((x) => x.id === cloudId);
    if (!p?.apiKey) throw new Error(`The ${cloudId} connection has no API key.`);
    return { text: await cloudTranscribe(p.baseUrl ?? CLOUD_STT[cloudId]?.base ?? "https://api.openai.com/v1", p.apiKey, CLOUD_STT[cloudId]?.model ?? "whisper-1", data, language), engine: cloudId };
  }
  if (!local.engine || !local.model) throw new Error("Speech to text is not set up yet: turn it on in Settings → Speech (KesherAI downloads whisper.cpp and a model), or connect Groq or OpenAI.");
  return { text: await d.whisper.transcribe(data, language, ext, timestamps), engine: "local" };
}

/** Converts any audio or video to 16 kHz mono WAV with ffmpeg, when it is installed. */
async function toWav(path: string): Promise<Buffer> {
  const out = join(tmpdir(), `kesher-audio-${randomUUID()}.wav`);
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", out], 1_800_000);
    return await readFile(out);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new Error(`This file type (${extname(path)}) needs FFmpeg to be read. Install it with install_tool (ffmpeg), or give a WAV, MP3, FLAC or OGG file.`);
    throw e;
  } finally {
    await rm(out, { force: true });
  }
}

/**
 * Says text with the computer's own voices into an audio file.
 *
 * @param text - What to say.
 * @param out - The file to write, without extension.
 * @returns The file written.
 */
async function systemVoice(text: string, out: string): Promise<string> {
  const textFile = join(tmpdir(), `kesher-tts-${randomUUID()}.txt`);
  await writeFile(textFile, text, "utf8");
  try {
    if (process.platform === "win32") {
      const file = `${out}.wav`;
      // The text and file come in through the environment, so nothing in them is run as a command.
      const script = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:KESHER_TTS_OUT); $s.Speak([IO.File]::ReadAllText($env:KESHER_TTS_IN, [Text.Encoding]::UTF8)); $s.Dispose()";
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 600_000, { KESHER_TTS_IN: textFile, KESHER_TTS_OUT: file });
      return file;
    }
    if (process.platform === "darwin") {
      const file = `${out}.aiff`;
      await run("say", ["-f", textFile, "-o", file]);
      return file;
    }
    const file = `${out}.wav`;
    try {
      await run("espeak-ng", ["-f", textFile, "-w", file]);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") throw new Error("No voice is installed on this computer: install espeak-ng, or connect OpenAI for its voices.");
      throw e;
    }
    return file;
  } finally {
    await rm(textFile, { force: true });
  }
}

/**
 * The speech tools.
 *
 * @param d - Engines and settings.
 * @returns `transcribe_audio` and `speak_text`.
 */
export function speechTools(d: SpeechDeps): AgentTool[] {
  return [
    {
      risk: "read",
      spec: {
        name: "transcribe_audio",
        description:
          "Turn a recording or video file (WAV, MP3, M4A, OGG, FLAC, MP4, …) into text, on this computer with whisper unless the user chose a cloud service. Use it to summarize meetings, voice notes or videos. Set timestamps: true to get [m:ss] times per line.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The audio or video file." },
            language: { type: "string", description: "Language code like he or en; leave out to detect it." },
            timestamps: { type: "boolean" },
          },
          required: ["path"],
        },
      },
      async run(input, ctx) {
        const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], String(input.path ?? ""));
        const ext = extname(path);
        if (!MEDIA.test(ext)) throw new Error(`${basename(path)} is not an audio or video file.`);
        const st = await stat(path);
        if (st.size > 2 * 1024 ** 3) throw new Error("The file is over 2 GB.");
        const usable = WHISPER_READS.test(ext) && st.size < 400 * 1024 ** 2;
        const data = usable ? await readFile(path) : await toWav(path);
        const lang = typeof input.language === "string" && input.language.trim() ? input.language.trim() : d.speech().language;
        const { text, engine } = await transcribeWith(d, data, usable ? ext : ".wav", lang, input.timestamps === true);
        if (!text.trim()) return { output: `${basename(path)}: no speech was found.` };
        return { output: `${basename(path)} (${engine === "local" ? "transcribed on this computer" : `transcribed by ${engine}`}):\n\n${text}` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "speak_text",
        description:
          "Read text aloud into an audio file the user can play and download (for example a summary to listen to, or a voice-over). Uses an OpenAI voice when OpenAI is connected, otherwise the computer's own voices.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            name: { type: "string", description: "File name without extension, e.g. summary." },
            voice: { type: "string", description: "OpenAI voice: alloy, nova, shimmer, onyx, echo, fable, ash, coral, sage." },
          },
          required: ["text"],
        },
      },
      async run(input, ctx) {
        const text = String(input.text ?? "").trim();
        if (!text) throw new Error("No text to say.");
        if (!ctx.workspace) throw new Error("This conversation has no folder for files.");
        await mkdir(ctx.workspace, { recursive: true });
        const name = (String(input.name ?? "").replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || `speech-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`).slice(0, 60);
        const openai = d.providers().find((p) => p.id === "openai" && p.apiKey);
        if (openai) {
          const res = await fetch(`${(openai.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/audio/speech`, {
            method: "POST",
            headers: { authorization: `Bearer ${openai.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: typeof input.voice === "string" ? input.voice : "nova", input: text.slice(0, 4000), response_format: "mp3" }),
            signal: ctx.signal ?? AbortSignal.timeout(120_000),
          });
          if (!res.ok) throw new Error(`OpenAI answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
          await writeFile(join(ctx.workspace, `${name}.mp3`), Buffer.from(await res.arrayBuffer()));
          return { output: `Saved ${name}.mp3 (OpenAI voice${text.length > 4000 ? "; only the first 4000 characters" : ""}).`, files: [`${name}.mp3`] };
        }
        const file = await systemVoice(text.slice(0, 50_000), join(ctx.workspace, name));
        return { output: `Saved ${basename(file)} (this computer's voice).`, files: [basename(file)] };
      },
    },
  ];
}
