import { useEffect, useState } from "react";
import { partOn, type PartDefinition } from "@kesher/shared";
import { api } from "./api";

/** A part of KesherAI and whether it is on (Settings → Parts). */
export type Part = PartDefinition & { on: boolean };

let cache: Part[] | null = null;
let simpleMode = false;
const listeners = new Set<() => void>();

/** Loads the parts again (after turning one on or off). */
export async function refreshParts(): Promise<Part[]> {
  const r = await api<{ parts: Part[]; simple?: boolean }>("/api/parts").catch(() => ({ parts: cache ?? [], simple: simpleMode }));
  cache = r.parts;
  simpleMode = r.simple === true;
  listeners.forEach((l) => l());
  return cache;
}

/**
 * Turns parts on or off.
 *
 * @param body - `{ parts: { id: on } }` or `{ preset: "chat" | "all" }`.
 */
export async function setParts(body: { parts?: Record<string, boolean>; preset?: "chat" | "all" }): Promise<void> {
  cache = (await api<{ parts: Part[] }>("/api/parts", { method: "PUT", body })).parts;
  listeners.forEach((l) => l());
}

/**
 * Simple mode on or off (Settings → Parts, and the welcome for a new install).
 *
 * @param on - true: the menu shows chat, pictures, models and settings only.
 */
export async function setSimple(on: boolean): Promise<void> {
  const r = await api<{ parts: Part[]; simple?: boolean }>("/api/parts/simple", { method: "PUT", body: { simple: on } });
  cache = r.parts;
  simpleMode = r.simple === true;
  listeners.forEach((l) => l());
}

/** @returns The parts, whether one is on, and simple mode; re-renders when they change. */
export function useParts(): { parts: Part[]; on: (id: string) => boolean; simple: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    if (!cache) void refreshParts();
    return () => {
      listeners.delete(l);
    };
  }, []);
  const off = Object.fromEntries((cache ?? []).filter((p) => !p.on).map((p) => [p.id, false]));
  return { parts: cache ?? [], on: (id) => partOn(off, id), simple: simpleMode };
}
