/**
 * KesherAI's keyboard shortcuts, which the user can change (as Open WebUI 0.11 and VS Code): Settings → Keyboard.
 * "global" ones work from any app (the desktop app registers them with the system); "app" ones work inside
 * KesherAI. A combination is written like "Ctrl+Alt+K" (Ctrl stands for Cmd on a Mac for app shortcuts).
 */

/** One shortcut the user can change. */
export interface ShortcutDef {
  id: string;
  scope: "global" | "app";
  /** Windows and Linux. */
  key: string;
  /** macOS, when different. */
  mac?: string;
  en: string;
  he: string;
}

/** Every shortcut that can be changed, in the order the settings list them. */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "palette", scope: "app", key: "Ctrl+K", en: "Search and commands", he: "חיפוש ופקודות" },
  { id: "closePanes", scope: "app", key: "Ctrl+\\", en: "Close the chat's side panes", he: "סגירת החלוניות שליד הצ'אט" },
  { id: "textHelper", scope: "global", key: "Ctrl+Alt+K", mac: "Ctrl+Alt+K", en: "Text helper (selected text in any app)", he: "עוזר טקסט (טקסט מסומן בכל אפליקציה)" },
  { id: "dictate", scope: "global", key: "Ctrl+Alt+D", mac: "Ctrl+Alt+D", en: "Dictation into any app", he: "הכתבה לכל אפליקציה" },
  { id: "gameHelper", scope: "global", key: "Ctrl+Alt+G", mac: "Cmd+Alt+G", en: "Game helper", he: "עוזר משחקים" },
  { id: "stopComputer", scope: "global", key: "Ctrl+Alt+Escape", mac: "Cmd+Shift+Escape", en: "Stop computer control", he: "עצירת שליטה במחשב" },
];

/** What the user changed: a new combination, or null for off. */
export type ShortcutMap = Record<string, string | null>;

const MODS = ["Ctrl", "Cmd", "Alt", "Shift"] as const;
const KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space|Escape|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|[`\-=[\];',./\\])$/;

/**
 * A combination in one spelling ("ctrl + alt + k" → "Ctrl+Alt+K"), or undefined when it is not one.
 *
 * @param combo - What was typed or recorded.
 */
export function normalizeCombo(combo: string): string | undefined {
  // "\" and "+" can be keys: split on "+" only between parts.
  const parts = combo.trim().split(/\s*\+\s*(?=.)/).filter(Boolean);
  if (!parts.length) return undefined;
  const mods = new Set<string>();
  let key = "";
  for (const raw of parts) {
    const p = raw.trim();
    const m = MODS.find((x) => x.toLowerCase() === p.toLowerCase() || (x === "Ctrl" && /^control$/i.test(p)) || (x === "Cmd" && /^(command|meta|super|win)$/i.test(p)) || (x === "Alt" && /^option$/i.test(p)));
    if (m) mods.add(m);
    else if (key) return undefined;
    else key = p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase().replace(/^(Pageup|Pagedown)$/, (x) => (x === "Pageup" ? "PageUp" : "PageDown"));
  }
  if (key === "Esc") key = "Escape";
  if (!key || !KEY.test(key)) return undefined;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/**
 * The combination a key press makes (for recording a new one), or undefined for a modifier alone.
 *
 * @param e - The key event's fields.
 */
export function comboOf(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | undefined {
  if (/^(Control|Meta|Alt|Shift|OS|AltGraph)$/.test(e.key)) return undefined;
  // The key's place, not its letter, so a Hebrew layout gives "K" for the K key (ל).
  const fromCode = e.code && /^Key([A-Z])$/.exec(e.code)?.[1] ? /^Key([A-Z])$/.exec(e.code)![1]! : e.code && /^Digit(\d)$/.exec(e.code)?.[1] ? /^Digit(\d)$/.exec(e.code)![1]! : undefined;
  const name = fromCode ?? (e.key === " " ? "Space" : e.key.startsWith("Arrow") ? e.key.slice(5) : e.key);
  return normalizeCombo([e.ctrlKey && "Ctrl", e.metaKey && "Cmd", e.altKey && "Alt", e.shiftKey && "Shift", name].filter(Boolean).join("+"));
}

/**
 * The shortcut's combination now.
 *
 * @param id - Its id.
 * @param map - The user's changes.
 * @param mac - On a Mac.
 * @returns The combination, or null when the user turned it off.
 */
export function shortcutKey(id: string, map: ShortcutMap | undefined, mac = false): string | null {
  const d = SHORTCUTS.find((s) => s.id === id);
  if (map && id in map) return map[id] ?? null;
  return d ? (mac && d.mac) || d.key : null;
}

/**
 * Whether a key press is this shortcut (an app shortcut's Ctrl also matches Cmd on a Mac).
 *
 * @param e - The key event.
 * @param combo - The combination (or null: off).
 */
export function pressMatches(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, combo: string | null): boolean {
  if (!combo) return false;
  const got = comboOf(e);
  if (!got) return false;
  return got === combo || got.replace(/^Cmd\+/, "Ctrl+") === combo;
}

/**
 * The combination as Electron's global shortcut wants it ("Ctrl+Alt+K" → "Control+Alt+K", Cmd → "Command").
 *
 * @param combo - The combination.
 */
export function toAccelerator(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p === "Ctrl" ? "Control" : p === "Cmd" ? "Command" : p === "Escape" ? "Escape" : p === "\\" ? "\\" : p))
    .join("+");
}

/**
 * Shortcuts that share a combination (each pair once).
 *
 * @param map - The user's changes.
 * @param mac - On a Mac.
 */
export function shortcutConflicts(map: ShortcutMap | undefined, mac = false): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const keys = SHORTCUTS.map((s) => [s.id, shortcutKey(s.id, map, mac)] as const).filter((x) => x[1]);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (keys[i]![1] === keys[j]![1]) out.push([keys[i]![0], keys[j]![0]]);
  return out;
}

/**
 * Only valid changes: known ids, real combinations, a global one with Ctrl, Cmd or Alt (a bare key from every app would
 * take typing away), or null for off.
 *
 * @param input - Anything (a request body).
 */
export function cleanShortcuts(input: unknown): ShortcutMap {
  const out: ShortcutMap = {};
  if (!input || typeof input !== "object") return out;
  for (const [id, v] of Object.entries(input as Record<string, unknown>)) {
    const d = SHORTCUTS.find((s) => s.id === id);
    if (!d) continue;
    if (v === null) out[id] = null;
    else if (typeof v === "string") {
      const c = normalizeCombo(v);
      if (!c) continue;
      if (!/(^|\+)(Ctrl|Cmd|Alt)\+/.test(c)) continue;
      out[id] = c;
    }
  }
  return out;
}
