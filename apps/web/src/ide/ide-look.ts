import { api } from "../api";

/** A code editor on the computer, as the server lists it. */
export interface IdeInfo { id: string; name: string }

/** An editor's look (from /api/ides/look): a Monaco theme and its font. */
export interface IdeLook {
  ide: string;
  themeName?: string;
  theme?: { base: "vs" | "vs-dark" | "hc-black" | "hc-light"; inherit: boolean; rules: Array<{ token: string; foreground?: string; fontStyle?: string }>; colors: Record<string, string> };
  fontFamily?: string;
  fontSize?: number;
  ligatures?: boolean;
  lineHeight?: number;
  tabSize?: number;
}

const KEY = "kesher-ide";
let chosen: string = (() => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
})();
let look: IdeLook | undefined;
let loading: Promise<IdeLook | undefined> | undefined;
let list: Promise<IdeInfo[]> | undefined;
const listeners = new Set<(l: IdeLook | undefined) => void>();

/** The editors on this computer (asked once per page). */
export function ides(): Promise<IdeInfo[]> {
  return (list ??= api<IdeInfo[]>("/api/ides").catch(() => []));
}

/** The editor whose look KesherAI's code panels use ("" = KesherAI's own). */
export function chosenIde(): string {
  return chosen;
}

/** The chosen editor's look, read once. */
export function ideLook(): Promise<IdeLook | undefined> {
  if (!chosen) return Promise.resolve(undefined);
  if (look?.ide === chosen) return Promise.resolve(look);
  const id = chosen;
  return (loading ??= api<IdeLook>(`/api/ides/look?id=${encodeURIComponent(id)}`)
    .then((l) => (chosen === id ? (look = l) : undefined), () => undefined)
    .finally(() => (loading = undefined)));
}

/**
 * Chooses the editor whose look the code panels take ("" for KesherAI's own); every open editor follows.
 *
 * @param id - An id from ides(), or "".
 */
export async function chooseIde(id: string): Promise<void> {
  chosen = id;
  look = undefined;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* a private window: for this page only */
  }
  const l = await ideLook();
  for (const f of listeners) f(l);
}

/**
 * Calls back when the chosen look changes.
 *
 * @returns Stops listening.
 */
export function onIdeLook(f: (l: IdeLook | undefined) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/**
 * Opens a file at a line in the chosen editor (or the first one found).
 *
 * @param file - The file's full path on the computer.
 */
export async function openInChosenIde(file: string, line: number): Promise<void> {
  const id = chosen || (await ides())[0]?.id;
  if (!id) throw new Error("No code editor was found on this computer (VS Code, Cursor, Rider, Visual Studio).");
  await api("/api/ides/open", { method: "POST", body: { id, file, line } });
}
