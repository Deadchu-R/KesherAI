import { useRef, useState, type ReactNode } from "react";
import { api, withToken } from "./api";
import { Annotator, type Annotated } from "./Annotator";
import type { AddMenuProps } from "./AddMenu";
import { getLocale, t } from "./i18n";
import { desktop } from "./library";
import { uploadToConversation } from "./phone";

/** What adding a project to a chat answered. */
export interface ProjectAdded {
  kind: string;
  line: string;
  path: string;
  engine?: string;
  connected?: boolean;
}

/**
 * Everything a chat box can add to a message (files, photos, a marked-up
 * screenshot, a Unity/Unreal project, a script), in ONE place, so every chat
 * box (the start screen, a chat, the code start screen) has the same + menu
 * and gets every new item at once.
 *
 * A box with no chat yet (the start screen) passes `ensure`, which makes the
 * chat on the first thing added; the message then goes to that same chat.
 *
 * @param o.convId - The chat, when there is one.
 * @param o.ensure - Makes the chat when there is none yet; returns its id.
 * @param o.insert - Adds a line to the message box.
 * @param o.onError - Shows a problem.
 * @param o.onProject - After a project was added (a chat shows Unreal setup, Unity's chip refreshes).
 * @returns The + menu's handlers, and the hidden inputs and the picture editor to render once.
 */
export function useChatAttach(o: {
  convId?: string;
  ensure?: () => Promise<string | undefined>;
  insert: (text: string) => void;
  onError: (message: string) => void;
  onProject?: (r: ProjectAdded) => void;
}): { menu: Pick<AddMenuProps, "onFiles" | "onPhoto" | "onAnnotate" | "onProject" | "onGameProject" | "onScript" | "convId">; elements: ReactNode; takePhoto: () => void; attach: (paths: string[]) => Promise<void> } {
  const uploadInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const annotInput = useRef<HTMLInputElement>(null);
  const [annotSrc, setAnnotSrc] = useState("");
  const line = (path: string) => `[${t("attached")}: ${path}]`;
  const chat = async () => o.convId ?? (await o.ensure?.());

  const attach = async (paths: string[]) => {
    const id = await chat();
    if (!id) return;
    const added: string[] = [];
    for (const p of paths) {
      try {
        added.push((await api<{ path: string }>(`/api/conversations/${id}/access`, { method: "POST", body: { path: p } })).path);
      } catch (e) {
        o.onError((e as Error).message);
      }
    }
    if (added.length) o.insert(`${added.map(line).join("\n")}\n`);
  };
  const upload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const id = await chat();
    if (!id) return;
    const lines: string[] = [];
    for (const f of list) {
      try {
        lines.push(line(await uploadToConversation(id, f.name || "photo.jpg", f)));
      } catch (e) {
        o.onError(`${f.name}: ${(e as Error).message}`);
      }
    }
    if (lines.length) o.insert(`${lines.join("\n")}\n`);
  };
  const startAnnotate = async (from: "screen" | "file") => {
    if (from === "file") return annotInput.current?.click();
    try {
      const res = await fetch(withToken("/api/computer/screen?w=2400"));
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      setAnnotSrc(URL.createObjectURL(await res.blob()));
    } catch (e) {
      o.onError(getLocale() === "he" ? `אי אפשר לצלם את המסך: ${(e as Error).message} (צריך שליטה במחשב פעילה: הגדרות → שליטה במחשב)` : `Cannot capture the screen: ${(e as Error).message} (turn on computer control in Settings)`);
    }
  };
  const finishAnnotate = async (r: Annotated | null) => {
    URL.revokeObjectURL(annotSrc);
    setAnnotSrc("");
    if (!r) return;
    try {
      const id = await chat();
      if (!id) return;
      const path = await uploadToConversation(id, `marked-up-${Date.now()}.png`, r.png);
      const notes = r.notes.length ? `${getLocale() === "he" ? "הסימונים בתמונה" : "The marks in the picture"}:\n${r.notes.join("\n")}\n` : "";
      o.insert(`${line(path)}\n${notes}`);
    } catch (e) {
      o.onError((e as Error).message);
    }
  };
  const addProject = async (picked?: string) => {
    const folder = picked ?? (await desktop()?.pickFolder());
    if (!folder) return;
    try {
      const id = await chat();
      if (!id) return;
      const r = await api<ProjectAdded>(`/api/conversations/${id}/project`, { method: "POST", body: { path: folder } });
      o.insert(`${r.line}\n`);
      if (r.kind === "unity") dispatchEvent(new Event("kesher-unity-added"));
      o.onProject?.(r);
    } catch (e) {
      o.onError((e as Error).message);
    }
  };

  const bridge = desktop();
  return {
    menu: {
      onFiles: () => (bridge?.pickFiles ? void bridge.pickFiles().then((f) => attach(f)) : uploadInput.current?.click()),
      onPhoto: () => photoInput.current?.click(),
      onAnnotate: (from) => void startAnnotate(from),
      ...(bridge?.pickFiles ? { onProject: () => void addProject() } : {}),
      onGameProject: (path) => void addProject(path),
      // Scripts are found in the chat's own folders, so only a chat that exists can list them.
      ...(o.convId ? { convId: o.convId, onScript: (path: string) => o.insert(`${line(path)}\n`) } : {}),
    },
    takePhoto: () => photoInput.current?.click(),
    attach,
    elements: (
      <>
        <input ref={uploadInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files).finally(() => { if (uploadInput.current) uploadInput.current.value = ""; })} />
        <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
        <input ref={annotInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setAnnotSrc(URL.createObjectURL(f)); e.target.value = ""; }} />
        {annotSrc && <Annotator src={annotSrc} onDone={(r) => void finishAnnotate(r)} />}
      </>
    ),
  };
}
