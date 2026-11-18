import { useEffect, useRef, useState } from "react";
import { refreshParts, setParts } from "./parts";
import type { PageInput } from "./page-input";
import { api, withToken } from "./api";
import { createConversation, toast } from "./library";
import { getLocale } from "./i18n";

/** A file as a `data:` URL, the form plugin pages get pictures and sound in. */
/**
 * A file a plugin page handed over: only a `data:` URL is read, never an address, which would be fetched with this
 * app's rights (security review, scan 145).
 */
function fromDataUrl(given: unknown): Promise<Response> {
  const url = String(given ?? "");
  const m = /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,/.exec(url);
  if (!m) return Promise.reject(new Error("Send the file as a data: URL."));
  // Read here, not with fetch: the app's own CSP (connect-src 'self') does not let it fetch data: addresses, which
  // is what made "Send to the chat" do nothing in the desktop app (found on the PC, 0.6.375).
  const body = url.slice(m[0].length);
  let bytes: Uint8Array<ArrayBuffer>;
  if (m[3]) {
    const bin = atob(body);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else bytes = new Uint8Array(new TextEncoder().encode(decodeURIComponent(body)));
  return Promise.resolve(new Response(new Blob([bytes], { type: m[1] || "application/octet-stream" })));
}

/**
 * Each editor is a part of its own (asked 2026-11-18): when one editor needs another (the video editor's sound into the
 * sound editor), the other may be off. This offers to turn it on, says what it is and its size, and waits for the
 * plugin to load.
 *
 * @param part - The part's id (packages/shared/src/parts.ts).
 * @param why - What she was doing, for the question.
 * @returns Whether it is on now.
 */
export async function offerPart(part: string, why: string): Promise<boolean> {
  const parts = await refreshParts();
  const it = parts.find((x) => x.id === part);
  if (!it) return false;
  if (it.on) return true;
  const he = getLocale() === "he";
  const title = he ? it.title.he : it.title.en;
  const size = it.downloadGb ? (he ? ` (הורדה של ${it.downloadGb} GB)` : ` (a ${it.downloadGb} GB download)`) : he ? " (בלי הורדה)" : " (nothing to download)";
  if (!confirm(he ? `${why}: צריך את ${title}, חלק נפרד של KesherAI${size}. להפעיל אותו עכשיו?` : `${why} needs the ${title}, a separate part of KesherAI${size}. Turn it on now?`)) return false;
  await setParts({ parts: { [part]: true } });
  for (let i = 0; i < 20; i++) {
    await refreshPluginUi();
    if (cache.pages.some((pg) => pg.pluginId === part)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** What active plugins add to the interface (from `/api/plugins/ui`). */
export interface PluginUi {
  pages: Array<{ pluginId: string; id: string; title: string; icon?: string; file: string; layout?: "page" | "app"; uses?: string[] }>;
  panels: Array<{ pluginId: string; id: string; title: string; file: string; uses?: string[] }>;
  styles: Array<{ pluginId: string; file: string }>;
  composerActions: Array<{ pluginId: string; id: string; label: string; prompt: string }>;
  /** The key in plugin pages' addresses: it opens only plugins' files (never the app's token). */
  filesKey?: string;
}

const EMPTY: PluginUi = { pages: [], panels: [], styles: [], composerActions: [] };
let cache: PluginUi = EMPTY;
const listeners = new Set<() => void>();

/** Reloads what plugins add (after installing, enabling or removing one). */
export async function refreshPluginUi(): Promise<void> {
  cache = await api<PluginUi>("/api/plugins/ui").catch(() => EMPTY);
  listeners.forEach((l) => l());
}
let loaded = false;

/** @returns What active plugins add to the interface; re-renders when it changes. */
export function usePluginUi(): PluginUi {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    if (!loaded) {
      loaded = true;
      void refreshPluginUi();
    }
    return () => {
      listeners.delete(l);
    };
  }, []);
  return cache;
}

/**
 * URL of a plugin's file. The token is a path segment so the page's own
 * relative links (scripts, styles, images) keep it inside a sandboxed frame.
 *
 * @param pluginId - Plugin.
 * @param file - Path inside the plugin folder.
 * @returns The URL.
 */
export function pluginFileUrl(pluginId: string, file: string): string {
  const token = cache.filesKey || "local";
  return `/api/plugin-files/${encodeURIComponent(token)}/${pluginId}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/** Adds every plugin stylesheet (themes, visual mods) to the page. */
export function PluginStyles() {
  const { styles } = usePluginUi();
  return (
    <>
      {styles.map((st) => (
        <link key={`${st.pluginId}/${st.file}`} rel="stylesheet" href={pluginFileUrl(st.pluginId, st.file)} data-plugin={st.pluginId} />
      ))}
    </>
  );
}

type Call = { kesher: 1; id: number; method: string; params?: Record<string, unknown> };

/**
 * A plugin page or panel in a sandboxed frame (scripts run, but it cannot
 * read the app, its token or its storage). It talks to the app through
 * `postMessage`; the plugin's page can use the tiny client in
 * docs/PLUGINS.md (`kesher.call("chat", …)`).
 *
 * @param props.pluginId - Plugin.
 * @param props.file - Its HTML file.
 * @param props.title - Accessible title.
 * @param props.conversationId - For panels: the open conversation.
 * @param props.onInsertPrompt - For panels: puts text into the composer.
 * @param props.input - For pages: a file of a chat it was opened with ("Edit" on a chat's picture), which the page
 *   reads with `editor.input` and may send back to that chat only, with `chat.sendFile`.
 */
export function PluginFrame({ pluginId, file, title, conversationId, onInsertPrompt, uses = [], input }: { pluginId: string; file: string; title: string; conversationId?: string; onInsertPrompt?: (text: string) => void; uses?: string[]; input?: PageInput }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const reply = (id: number, body: { result?: unknown; error?: string; partial?: string }) => frame.contentWindow?.postMessage({ kesher: 1, id, ...body }, "*");
    // A plugin uses only the local models it declared in its manifest ("uses"), which the user saw before installing it.
    const need = (use: string) => {
      if (!uses.includes(use)) throw new Error(`This plugin did not ask to use the ${use} models (add "${use}" to "uses" in kesher-plugin.json).`);
    };
    const imageModel = async (given: unknown) => {
      if (typeof given === "string") return given;
      const s = await api<{ activeModels?: Record<string, string> }>("/api/settings");
      const id = s.activeModels?.image;
      if (!id) throw new Error("No picture model is chosen yet (Models → Pictures).");
      return id;
    };
    const handle = async (msg: Call): Promise<unknown> => {
      const p = msg.params ?? {};
      switch (msg.method) {
        case "info":
          return { pluginId, locale: getLocale(), conversationId: conversationId ?? input?.conversationId ?? null, uses, apiVersion: 3 };
        // The file the page was opened with (a picture of a chat), as a data URL.
        case "editor.input": {
          if (!input) return null;
          const blob = await fetch(withToken(`/api/conversations/${encodeURIComponent(input.conversationId)}/files/download?path=${encodeURIComponent(input.path)}`)).then((x) => {
            if (!x.ok) throw new Error(`The file could not be read (${x.status}).`);
            return x.blob();
          });
          const name = input.path.split(/[\\/]/).pop() ?? "";
          const fileOf = async (path: string) => {
            const x = await fetch(withToken(`/api/conversations/${encodeURIComponent(input.conversationId)}/files/download?path=${encodeURIComponent(path)}`));
            return x.ok ? x.blob() : undefined;
          };
          // The hand-off: where to go back (the page shows "Back to …"), what came back, and a guide layer.
          const extra = {
            ...(input.returnTo ? { returnTo: { plugin: input.returnTo.plugin, slot: input.returnTo.slot } } : {}),
            ...(input.back ? { back: { slot: input.back.slot, name: input.back.path.split("/").pop(), data: await fileOf(input.back.path).then((b) => (b ? dataUrl(b) : undefined)) } } : {}),
            ...(input.guide ? { guide: await fileOf(input.guide).then((b) => (b ? dataUrl(b) : undefined)) } : {}),
          };
          // A video goes over as its bytes (the page makes its own blob: address for the player); a picture as a data URL.
          if (blob.size > 2 * 1024 ** 3) throw new Error("This file is over 2 GB, too big to open here.");
          if (/\.(mp4|webm|mov|m4v|mkv|mp3|wav|m4a|ogg|flac|aac|opus|glb|gltf)$/i.test(name)) return { conversationId: input.conversationId, path: input.path, name, type: blob.type || "video/mp4", bytes: await blob.arrayBuffer(), ...extra, ...(input.sound ? { sound: input.sound, soundBytes: await fetch(withToken(`/api/conversations/${encodeURIComponent(input.conversationId)}/files/download?path=${encodeURIComponent(input.sound)}`)).then((x) => (x.ok ? x.arrayBuffer() : undefined)) } : {}), ...(input.returnVideo ? { returnVideo: input.returnVideo } : {}) };
          return { conversationId: input.conversationId, path: input.path, name, data: await dataUrl(blob), ...extra };
        }
        // The video editor's export: the kept stretches of the video the page was opened with, as a new file in that
        // chat's folder (cut by FFmpeg on the computer); with `send`, attached to the chat with an optional message.
        case "video.cut": {
          need("video");
          if (!input) throw new Error("This page was not opened from a chat.");
          const { path, captions } = await api<{ path: string; captions?: string }>(`/api/conversations/${encodeURIComponent(input.conversationId)}/files/cut`, { method: "POST", body: { path: input.path, ...(input.sound ? { sound: input.sound } : {}), segments: p.segments, ...(typeof p.name === "string" ? { name: p.name } : {}), ...(Array.isArray(p.captions) ? { captions: p.captions } : {}) } });
          if (p.send) {
            const text = typeof p.text === "string" ? p.text.slice(0, 4000) : "";
            await api(`/api/conversations/${encodeURIComponent(input.conversationId)}/messages`, { method: "POST", body: { text: `${text}${text ? "\n\n" : ""}[Attached: ${path}]${captions ? `\n[Attached: ${captions}]` : ""}` } });
            location.hash = `#/c/${input.conversationId}`;
          }
          return { path, captions };
        }
        // Voices on this computer for the sound editor's "In another voice": the cloned ones (any language, Hebrew too)
        // and Kokoro's (English).
        case "sound.voices": {
          need("sound");
          const [clone, kokoro] = await Promise.all([
            api<{ voices?: string[]; installed?: boolean }>("/api/voice-clone").catch(() => ({ voices: [] as string[] })),
            api<{ ready?: boolean; voices?: Array<{ id: number; name: string }> }>("/api/speech/tts/local").catch(() => ({ ready: false, voices: [] })),
          ]);
          return [
            ...(clone.voices ?? []).map((v) => ({ id: `clone:${v}`, name: v, kind: "clone" })),
            ...(kokoro.ready ? (kokoro.voices ?? []).map((v) => ({ id: `kokoro:${v.id}`, name: v.name, kind: "kokoro" })) : []),
          ];
        }
        // Text said by one of those voices, as WAV bytes.
        case "sound.say": {
          need("sound");
          const voice = String(p.voice ?? "");
          const text = String(p.text ?? "").slice(0, 2000);
          if (!text.trim()) throw new Error("Write what to say.");
          const res = voice.startsWith("clone:")
            ? await fetch(withToken("/api/voice-clone/say"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice: voice.slice(6), text, lang: typeof p.lang === "string" ? p.lang : getLocale() === "he" ? "he" : "en" }) })
            : await fetch(withToken("/api/speech/tts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, provider: "local", voice: Number(voice.replace("kokoro:", "")) || 3 }) });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
          return res.arrayBuffer();
        }
        // A hand-off to another editor (each editor its own part; they work together through files): saves the file,
        // and a guide when there is one, in the chat's folder, and opens the other editor with the way back (`ret` = the
        // file this page will reopen, `slot` = where the result goes in it).
        case "editor.handoff": {
          if (!input) throw new Error("This page was not opened from a chat.");
          const to = String(p.to ?? "");
          if (!/^(image|video|sound|model)-editor$/.test(to) || to === pluginId) throw new Error("Hand off to another editor.");
          const slot = String(p.slot ?? "");
          if (!/^[\p{L}\p{N}_:.\- ]{1,80}$/u.test(slot)) throw new Error("A short slot name.");
          const c = encodeURIComponent(input.conversationId);
          const save = async (data: unknown, name: string) => {
            const bytes = await fromDataUrl(data).then((x) => x.blob());
            if (!bytes.size || bytes.size > 300 * 1024 * 1024) throw new Error("The file is empty or larger than 300 MB.");
            const up = await fetch(withToken(`/api/conversations/${c}/files?name=${encodeURIComponent(name.slice(0, 120))}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
            if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? String(up.status));
            return `shared/${((await up.json()) as { name: string }).name}`;
          };
          // This page's own state goes along as a working copy, so coming back finds it as it was left.
          const ret = typeof p.working === "string" ? await save(p.working, String(p.workingName ?? input.path.split("/").pop())) : input.path;
          const file = await save(p.data, String(p.name ?? "file"));
          const guide = typeof p.guide === "string" ? await save(p.guide, String(p.guideName ?? "guide.png")) : undefined;
          const label = getLocale() === "he" ? "כדי לערוך את זה" : "Editing this";
          if (!(await offerPart(to, label))) return false;
          location.hash = `#/p/${to}/editor?c=${c}&f=${encodeURIComponent(file)}&ret=${encodeURIComponent(ret)}&retp=${pluginId}&slot=${encodeURIComponent(slot)}${guide ? `&g=${encodeURIComponent(guide)}` : ""}`;
          return true;
        }
        // Back from a hand-off: the result into the chat's folder, and the editor it came from opened again with it.
        case "editor.handBack": {
          if (!input?.returnTo) throw new Error("This page was not opened from another editor.");
          const c = encodeURIComponent(input.conversationId);
          const bytes = await fromDataUrl(p.data).then((x) => x.blob());
          if (!bytes.size || bytes.size > 300 * 1024 * 1024) throw new Error("The file is empty or larger than 300 MB.");
          const up = await fetch(withToken(`/api/conversations/${c}/files?name=${encodeURIComponent(String(p.name ?? "edited.png").slice(0, 120))}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
          if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? String(up.status));
          const { name } = (await up.json()) as { name: string };
          const { plugin, path, slot } = input.returnTo;
          if (!(await offerPart(plugin, getLocale() === "he" ? "כדי לחזור" : "Going back"))) return false;
          location.hash = `#/p/${plugin}/editor?c=${c}&f=${encodeURIComponent(path)}&back=${encodeURIComponent(`shared/${name}`)}&slot=${encodeURIComponent(slot)}`;
          return true;
        }
        // The parts engine (P3-SAM) for the 3D editor: its state; setting it up (asks first: a few GB); splitting a mesh.
        case "model.parts.status":
          need("model");
          return api("/api/part-seg");
        case "model.parts.setup": {
          need("model");
          const he = getLocale() === "he";
          if (!confirm(he ? "לחלוקה לפי משמעות KesherAI יוריד את P3-SAM של Tencent (Hunyuan3D-Part): Python עם PyTorch, הקוד והמשקלים, כמה GB פעם אחת. זה רץ במחשב שלך. להוריד?" : "To split by meaning, KesherAI downloads Tencent's P3-SAM (Hunyuan3D-Part): Python with PyTorch, its code and weights, a few GB once. It runs on your computer. Download?")) return false;
          await api("/api/part-seg/install", { method: "POST" });
          return true;
        }
        case "model.parts.segment": {
          need("model");
          const bytes = await fromDataUrl(p.data).then((x) => x.blob());
          const res = await fetch(withToken("/api/part-seg/segment"), { method: "POST", headers: { "content-type": "model/gltf-binary" }, body: bytes });
          const j = (await res.json()) as { faces?: Array<[number, number, number, number]>; error?: string };
          if (!res.ok) throw Object.assign(new Error(j.error ?? String(res.status)), { code: res.status });
          return j.faces ?? [];
        }
        // A file of the plugin's own folder as bytes (its page may not fetch; the sound editor's instrument samples).
        case "own.file": {
          const path = String(p.path ?? "");
          if (!/^[\w-]+(\/[\w.-]+)*$/.test(path) || path.split("/").includes("..")) throw new Error("Give a path inside the plugin's folder.");
          const res = await fetch(pluginFileUrl(pluginId, path));
          if (!res.ok) throw new Error(`${path}: ${res.status}`);
          return res.arrayBuffer();
        }
        // The video's sound into the sound editor (double-click the sound track): a WAV of it in the chat's folder,
        // opened there with the way back to this video.
        case "video.openSound": {
          need("video");
          if (!input) throw new Error("This page was not opened from a chat.");
          if (!(await offerPart("sound-editor", getLocale() === "he" ? "כדי לשנות את הסאונד" : "Changing the sound"))) return { offered: false };
          const c = encodeURIComponent(input.conversationId);
          const { path } = await api<{ path: string }>(`/api/conversations/${c}/files/sound`, { method: "POST", body: { path: input.path } });
          location.hash = `#/p/sound-editor/editor?c=${c}&f=${encodeURIComponent(path)}&ret=${encodeURIComponent(input.path)}`;
          return { path };
        }
        // Back from the sound editor to the video it came from, with the new sound (a WAV data URL) for it.
        case "sound.backToVideo": {
          need("sound");
          if (!input?.returnVideo) throw new Error("This sound did not come from a video.");
          const bytes = await fromDataUrl(p.data).then((x) => x.blob());
          if (!bytes.size || bytes.size > 300 * 1024 * 1024) throw new Error("The sound is empty or larger than 300 MB.");
          const c = encodeURIComponent(input.conversationId);
          const up = await fetch(withToken(`/api/conversations/${c}/files?name=${encodeURIComponent(String(p.name ?? "sound-edited.wav").slice(0, 120))}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
          if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? String(up.status));
          const { name } = (await up.json()) as { name: string };
          if (!(await offerPart("video-editor", getLocale() === "he" ? "כדי לחזור לווידאו" : "Going back to the video"))) return false;
          location.hash = `#/p/video-editor/editor?c=${c}&f=${encodeURIComponent(input.returnVideo)}&a=${encodeURIComponent(`shared/${name}`)}`;
          return true;
        }
        // What is said in the video the page was opened with, in pieces with their times (whisper on the computer).
        case "video.transcript":
        case "sound.transcript": {
          need(msg.method === "video.transcript" ? "video" : "sound");
          if (!input) throw new Error("This page was not opened from a chat.");
          const res = await fetch(withToken(`/api/conversations/${encodeURIComponent(input.conversationId)}/files/transcript`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: input.path }) });
          const j = (await res.json()) as { parts?: Array<{ start: number; end: number; text: string }>; error?: string };
          if (!res.ok) throw new Error(j.error === "needs-setup" ? "Speech to text is not set up yet (Settings → Speech)." : j.error ?? String(res.status));
          return j.parts ?? [];
        }
        // Sends a file (a data URL) to the chat the page was opened from, as an attachment with an optional message.
        case "chat.sendFile": {
          if (!input) throw new Error("This page was not opened from a chat.");
          const bytes = await fromDataUrl(p.data).then((x) => x.blob());
          if (!bytes.size || bytes.size > 50 * 1024 * 1024) throw new Error("The file is empty or larger than 50 MB.");
          const name = String(p.name ?? "edited.png").slice(0, 120);
          const up = await fetch(withToken(`/api/conversations/${encodeURIComponent(input.conversationId)}/files?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
          if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? String(up.status));
          const { path } = (await up.json()) as { path: string };
          const text = typeof p.text === "string" ? p.text.slice(0, 4000) : "";
          await api(`/api/conversations/${encodeURIComponent(input.conversationId)}/messages`, { method: "POST", body: { text: `${text}${text ? "\n\n" : ""}[Attached: ${path}]` } });
          location.hash = `#/c/${input.conversationId}`;
          return { path };
        }
        case "image.generate":
        case "image.edit": {
          need("image");
          const body = {
            modelId: await imageModel(p.model),
            prompt: String(p.prompt ?? ""),
            ...(typeof p.negativePrompt === "string" ? { negativePrompt: p.negativePrompt } : {}),
            ...(typeof p.width === "number" ? { width: p.width } : {}),
            ...(typeof p.height === "number" ? { height: p.height } : {}),
            ...(typeof p.steps === "number" ? { steps: p.steps } : {}),
            ...(typeof p.seed === "number" ? { seed: p.seed } : {}),
            ...(typeof p.image === "string" ? { initImage: p.image } : {}),
            ...(typeof p.mask === "string" ? { mask: p.mask } : {}),
            ...(typeof p.strength === "number" ? { strength: p.strength } : {}),
          };
          const r = await api<{ assets: Array<{ id: string }> }>("/api/images", { method: "POST", body });
          return Promise.all(r.assets.map(async (a) => dataUrl(await fetch(withToken(`/api/assets/${a.id}`)).then((x) => x.blob()))));
        }
        case "image.upscale": {
          need("image");
          const png = await fromDataUrl(p.image).then((x) => x.blob());
          const res = await fetch(withToken("/api/images/upscale"), { method: "POST", headers: { "content-type": "image/png" }, body: png });
          if (res.status === 409) {
            await api("/api/images/upscale/setup", { method: "POST" });
            throw new Error("The enlarger is downloading (follow it in the downloads circle). Try again when it is done.");
          }
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
          return dataUrl(await res.blob());
        }
        case "speech.transcribe": {
          need("speech");
          const wav = await fromDataUrl(p.audio).then((x) => x.blob());
          const res = await fetch(withToken(`/api/speech/transcribe${typeof p.language === "string" ? `?lang=${encodeURIComponent(p.language)}` : ""}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
          const j = (await res.json()) as { text?: string; error?: string };
          if (!res.ok) throw new Error(j.error === "needs-setup" ? "Speech to text is not set up yet (Models → Speech to text)." : j.error ?? String(res.status));
          return j.text ?? "";
        }
        case "speech.speak": {
          need("speech");
          const res = await fetch(withToken("/api/speech/tts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: String(p.text ?? ""), provider: "local", ...(p.voice !== undefined ? { voice: p.voice } : {}) }) });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
          return dataUrl(await res.blob());
        }
        case "models":
          return (await api<{ models: Array<{ id: string; name: string; category: string; location: string }> }>("/api/models")).models.map(({ id, name, category, location }) => ({ id, name, category, location }));
        case "chat": {
          const model = typeof p.model === "string" ? p.model : (await api<{ activeModels?: Record<string, string> }>("/api/settings").catch(() => ({ activeModels: {} as Record<string, string> }))).activeModels?.chat;
          if (!model) throw new Error("No chat model is chosen.");
          if (p.stream) {
            // Streams: each new piece goes to the page as { partial }, then the whole answer.
            const res = await fetch(withToken("/v1/chat/completions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: p.messages ?? [], stream: true, ...(typeof p.temperature === "number" ? { temperature: p.temperature } : {}) }) });
            if (!res.ok || !res.body) throw new Error(`The chat model answered ${res.status}`);
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = "";
            let all = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += value;
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                const data = line.replace(/^data:\s*/, "");
                if (!line.startsWith("data:") || data === "[DONE]") continue;
                const piece = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? "";
                if (piece) {
                  all += piece;
                  reply(msg.id, { partial: piece });
                }
              }
            }
            return all;
          }
          const r = await api<{ choices: Array<{ message: { content: string } }> }>("/v1/chat/completions", { method: "POST", body: { model, messages: p.messages ?? [], ...(typeof p.temperature === "number" ? { temperature: p.temperature } : {}) } });
          return r.choices[0]?.message.content ?? "";
        }
        case "runTool":
          return (await api<{ result: unknown }>(`/api/tools/${encodeURIComponent(String(p.name))}`, { method: "POST", body: (p.input as Record<string, unknown>) ?? {} })).result;
        case "storage.get":
          return (await api<{ value: unknown }>(`/api/plugins/${pluginId}/storage/${encodeURIComponent(String(p.key))}`)).value;
        case "storage.set":
          await api(`/api/plugins/${pluginId}/storage/${encodeURIComponent(String(p.key))}`, { method: "PUT", body: { value: p.value } });
          return true;
        case "newChat": {
          const cid = await createConversation({ kind: "chat" });
          if (cid && typeof p.prompt === "string" && p.prompt) await api(`/api/conversations/${cid}/messages`, { method: "POST", body: { text: p.prompt } });
          if (cid) location.hash = `#/c/${cid}`;
          return cid ?? null;
        }
        case "conversation": {
          if (!conversationId) return null;
          const c = await api<{ title: string; events: Array<{ type: string; text?: string }> }>(`/api/conversations/${conversationId}`);
          return { title: c.title, messages: c.events.flatMap((e) => (e.type === "user" || e.type === "assistant" ? [{ role: e.type, content: e.text ?? "" }] : [])) };
        }
        case "insertPrompt":
          if (!onInsertPrompt) throw new Error("Only panels can do this.");
          onInsertPrompt(String(p.text ?? ""));
          return true;
        // Files shared with other apps on the computer (needs the "filesystem" permission).
        case "files.write":
          return api<{ path: string; mtime: number }>(`/api/plugins/${pluginId}/files/${encodeURIComponent(String(p.name))}`, { method: "PUT", body: { data: p.data } });
        case "files.read":
          return api<{ mtime: number; data: string }>(`/api/plugins/${pluginId}/files/${encodeURIComponent(String(p.name))}`);
        case "files.stat":
          return api<{ mtime: number; size: number }>(`/api/plugins/${pluginId}/files/${encodeURIComponent(String(p.name))}?stat=1`).catch(() => null);
        case "files.openInAffinity":
          return api<{ app: string }>(`/api/plugins/${pluginId}/files/${encodeURIComponent(String(p.name))}/open`, { method: "POST" });
        case "apps.affinity":
          return api<{ installed: boolean; platform: string }>("/api/apps/affinity");
        case "toast":
          toast(String(p.text ?? ""));
          return true;
        default:
          throw new Error(`Unknown method ${msg.method}`);
      }
    };
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const msg = e.data as Call;
      if (!msg || msg.kesher !== 1 || typeof msg.id !== "number") return;
      handle(msg).then(
        (result) => reply(msg.id, { result }),
        (err: Error) => reply(msg.id, { error: err.message }),
      );
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [pluginId, conversationId, onInsertPrompt, uses.join(","), input?.conversationId, input?.path, input?.sound, input?.returnVideo, input?.returnTo?.path, input?.back?.path, input?.guide]);
  return <iframe ref={ref} className="plugin-frame" title={title} src={pluginFileUrl(pluginId, file)} sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals" {...(uses.includes("sound") ? { allow: "microphone" } : {})} />;
}
