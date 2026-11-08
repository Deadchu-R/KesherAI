import { useEffect, useState } from "react";
import { partOn, type PartDefinition } from "@kesher/shared";
import { api } from "./api";

/** A part of KesherAI and whether it is on (Settings → Parts). */
export type Part = PartDefinition & { on: boolean };

let cache: Part[] | null = null;
const listeners = new Set<() => void>();

/** Loads the parts again (after turning one on or off). */
export async function refreshParts(): Promise<Part[]> {
  cache = (await api<{ parts: Part[] }>("/api/parts").catch(() => ({ parts: cache ?? [] }))).parts;
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

/** @returns The parts and a function telling whether one is on; re-renders when they change. */
export function useParts(): { parts: Part[]; on: (id: string) => boolean } {
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
  return { parts: cache ?? [], on: (id) => partOn(off, id) };
}
