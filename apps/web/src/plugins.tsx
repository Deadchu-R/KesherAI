import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { createConversation, toast } from "./library";
import { getLocale } from "./i18n";

/** A file as a `data:` URL, the form plugin pages get pictures and sound in. */
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
  const token = new URL(withToken("/x"), location.href).searchParams.get("token") || "local";
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
 */
export function PluginFrame({ pluginId, file, title, conversationId, onInsertPrompt, uses = [] }: { pluginId: string; file: string; title: string; conversationId?: string; onInsertPrompt?: (text: string) => void; uses?: string[] }) {
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
          return { pluginId, locale: getLocale(), conversationId: conversationId ?? null, uses, apiVersion: 2 };
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
          const png = await fetch(String(p.image ?? "")).then((x) => x.blob());
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
          const wav = await fetch(String(p.audio ?? "")).then((x) => x.blob());
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
  }, [pluginId, conversationId, onInsertPrompt, uses.join(",")]);
  return <iframe ref={ref} className="plugin-frame" title={title} src={pluginFileUrl(pluginId, file)} sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals" />;
}
