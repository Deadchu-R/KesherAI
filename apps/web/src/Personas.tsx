import { useEffect, useState } from "react";
import { Menu, MenuItem, MenuNote, MenuSeparator } from "./ui/Menu";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A saved persona, as the server returns it. */
export interface Persona { id: string; name: string; icon?: string; instructions: string; modelId?: string; knowledge?: string; params?: { temperature?: number; topP?: number; stop?: string[] }; starters?: string[]; agentWhen?: string }

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
 * The persona chip in a message box: a floating menu with "No persona" and the
 * saved personas (a click chooses one), and at the bottom "New persona", which
 * opens the personas page. Closes on a click outside or Escape.
 */
export function PersonaChip({ value, onChange }: { value?: string | undefined; onChange: (p: Persona | null) => void }) {
  const personas = usePersonas();
  const current = personas.find((p) => p.id === value);
  return (
    <Menu
      className="model-menu persona-menu"
      popClassName="model-pop persona-pop"
      triggerClassName={`model-chip${current ? " on" : ""}`}
      title={L("פרסונה: הוראות, מודל ומאגר ידע שמורים", "Persona: saved instructions, model and knowledge base")}
      aria-label={L("פרסונה", "Persona")}
      trigger={current ? `${current.icon ?? "🎭"} ${current.name}` : `🎭 ${L("פרסונה", "Persona")}`}
    >
      <MenuItem kind="radio" checked={!current} onSelect={() => onChange(null)}>{L("ללא פרסונה", "No persona")}</MenuItem>
      {personas.map((p) => (
        <MenuItem key={p.id} kind="radio" checked={p.id === value} icon={p.icon ?? "🎭"} dir="auto" onSelect={() => onChange(p)} title={p.instructions?.replace(/\s+/g, " ").slice(0, 200)}>
          {p.name}
          {p.instructions && <span className="muted small persona-hint" dir="auto"> {p.instructions.replace(/\s+/g, " ").slice(0, 60)}</span>}
        </MenuItem>
      ))}
      {!personas.length && <MenuNote>{L("אין עדיין פרסונות.", "No personas yet.")}</MenuNote>}
      <MenuSeparator />
      <MenuItem icon="＋" href="#/personas">{L("פרסונה חדשה", "New persona")}</MenuItem>
    </Menu>
  );
}
