import { useEffect, useRef, useState } from "react";
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
 * The persona chip in a message box: a floating menu with "No persona" and the
 * saved personas (a click chooses one), and at the bottom "New persona", which
 * opens the personas page. Closes on a click outside or Escape.
 */
export function PersonaChip({ value, onChange }: { value?: string | undefined; onChange: (p: Persona | null) => void }) {
  const personas = usePersonas();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  const current = personas.find((p) => p.id === value);
  const pick = (p: Persona | null) => {
    setOpen(false);
    onChange(p);
  };
  return (
    <div className="model-menu persona-menu" ref={ref}>
      <button type="button" className={`model-chip${current ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={L("פרסונה: הוראות, מודל ומאגר ידע שמורים", "Persona: saved instructions, model and knowledge base")}>
        {current ? `${current.icon ?? "🎭"} ${current.name}` : `🎭 ${L("פרסונה", "Persona")}`}
      </button>
      {open && (
        <div className="model-pop persona-pop" role="menu" aria-label={L("פרסונה", "Persona")}>
          <div className="model-pop-list">
            <button type="button" role="menuitemradio" aria-checked={!current} className={!current ? "on" : ""} onClick={() => pick(null)}>{L("ללא פרסונה", "No persona")}</button>
            {personas.map((p) => (
              <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === value} className={p.id === value ? "on" : ""} onClick={() => pick(p)}>
                <span>{p.icon ?? "🎭"} </span>
                <span className="grow" dir="auto">{p.name}</span>
                {p.instructions && <span className="muted small persona-hint" dir="auto">{p.instructions.replace(/\s+/g, " ").slice(0, 60)}</span>}
              </button>
            ))}
            {!personas.length && <p className="muted small">{L("אין עדיין פרסונות.", "No personas yet.")}</p>}
          </div>
          <a className="model-pop-foot" href="#/personas" onClick={() => setOpen(false)}>＋ {L("פרסונה חדשה", "New persona")}</a>
        </div>
      )}
    </div>
  );
}
