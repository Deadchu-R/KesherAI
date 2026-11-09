import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A saved persona, as the server returns it. */
export interface Persona { id: string; name: string; icon?: string; instructions: string; modelId?: string; knowledge?: string }

let cache: Persona[] | null = null;
const listeners = new Set<(p: Persona[]) => void>();

/** Reloads personas everywhere they are shown. */
export async function refreshPersonas(): Promise<Persona[]> {
  const r = await api<{ personas: Persona[] }>("/api/personas");
  cache = r.personas;
  for (const l of listeners) l(r.personas);
  return r.personas;
}

/** @returns The saved personas (loads them once). */
export function usePersonas(): Persona[] {
  const [list, setList] = useState<Persona[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (!cache) void refreshPersonas().catch(() => undefined);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/**
 * The persona chip in a message box: no persona, one of the saved ones, or
 * a link to make one.
 */
export function PersonaChip({ value, onChange }: { value?: string | undefined; onChange: (p: Persona | null) => void }) {
  const personas = usePersonas();
  // No personas yet: still visible, so it is clear a chat can have one (it opens the page that makes them).
  if (!personas.length && !value) {
    return (
      <button type="button" className="model-chip" onClick={() => (location.hash = "#/personas")} title={L("פרסונה: הוראות, מודל ומאגר ידע שמורים. אין עדיין פרסונות: לחצו כדי ליצור אחת.", "Persona: saved instructions, model and knowledge base. None yet: click to make one.")}>
        🎭 {L("פרסונה", "Persona")}
      </button>
    );
  }
  return (
    <select
      className="model-chip"
      value={value ?? ""}
      aria-label={L("פרסונה", "Persona")}
      title={L("פרסונה: הוראות, מודל ומאגר ידע שמורים", "Persona: saved instructions, model and knowledge base")}
      onChange={(e) => {
        if (e.target.value === "__manage") return void (location.hash = "#/personas");
        onChange(personas.find((p) => p.id === e.target.value) ?? null);
      }}
    >
      <option value="">{L("ללא פרסונה", "No persona")}</option>
      {personas.map((p) => <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ""}{p.name}</option>)}
      <option value="__manage">{L("ניהול פרסונות…", "Manage personas…")}</option>
    </select>
  );
}
