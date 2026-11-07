import { useEffect, useState } from "react";
import type { ConversationSummary, Project } from "@kesher/shared";
import { ApiError, api } from "./api";
import { pickModel } from "./ModelPicker";

/**
 * The sidebar's data: projects and conversation summaries, shared by every
 * screen. Call {@link refreshLibrary} after creating, renaming or deleting
 * something and every subscriber updates.
 */
let state: { projects: Project[]; conversations: ConversationSummary[] } = { projects: [], conversations: [] };
const listeners = new Set<() => void>();

/** Reloads projects and conversations from the server. */
export async function refreshLibrary(): Promise<void> {
  const [projects, conversations] = await Promise.all([
    api<Project[]>("/api/projects"),
    api<ConversationSummary[]>("/api/conversations"),
  ]);
  state = { projects, conversations };
  listeners.forEach((l) => l());
}

/** @returns The current projects and conversations; re-renders when they change. */
export function useLibrary() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    if (state.projects.length === 0 && state.conversations.length === 0) void refreshLibrary().catch(() => undefined);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

/** Desktop-only helpers the Electron preload script exposes. */
interface DesktopBridge {
  pickFolder(): Promise<string | null>;
  /** Missing in desktop apps older than 0.3.2. */
  restart?(): Promise<void>;
  /** Opens a folder in Explorer / Finder. Missing before 0.3.3. */
  openPath?(path: string): Promise<void>;
  /** Runs a program the agent built (the user clicked Run). Missing before 0.4.1. */
  runFile?(path: string): Promise<void>;
  /** Picks one or more files. Missing before 0.3.3. */
  pickFiles?(): Promise<string[]>;
  /** The path of a file dropped on the window. Missing before 0.3.3. */
  pathOf?(file: File): string;
}

/** @returns The desktop bridge when running in the desktop app, else `undefined`. */
export function desktop(): DesktopBridge | undefined {
  return (window as unknown as { kesherDesktop?: DesktopBridge }).kesherDesktop;
}

/**
 * Creates a conversation and opens it.
 *
 * @param body - Kind, project, folder, model.
 * @returns The new conversation's id.
 */
export async function createConversation(body: {
  kind: "chat" | "code";
  projectId?: string | null;
  workspace?: string;
  modelId?: string;
}): Promise<string> {
  let c: { id: string };
  try {
    c = await api<{ id: string }>("/api/conversations", { method: "POST", body });
  } catch (e) {
    // No chat model yet: let the user choose one instead of showing an error.
    if (!(e instanceof ApiError) || e.code !== "no-model") throw e;
    const modelId = await pickModel(e.category ?? "chat");
    if (!modelId) return "";
    c = await api<{ id: string }>("/api/conversations", { method: "POST", body: { ...body, modelId } });
  }
  await refreshLibrary();
  location.hash = `#/c/${c.id}`;
  return c.id;
}

const toastListeners = new Set<(msg: string) => void>();

/**
 * Shows a short message at the bottom of the screen (errors that have no
 * better place, like a failed "New chat").
 *
 * @param message - Text to show.
 */
export function toast(message: string): void {
  toastListeners.forEach((l) => l(message));
}

/** @returns The current toast message, cleared after a few seconds. */
export function useToast(): string {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const l = (m: string) => {
      setMsg(m);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(""), 6000);
    };
    toastListeners.add(l);
    return () => {
      toastListeners.delete(l);
      clearTimeout(timer);
    };
  }, []);
  return msg;
}
