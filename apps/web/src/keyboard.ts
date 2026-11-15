import { useEffect, useState } from "react";
import { pressMatches, shortcutKey, type ShortcutMap } from "@kesher/shared";
import { api } from "./api";

/** The user's keyboard settings (Settings → Keyboard), read once and shared. */
let state: { shortcuts: ShortcutMap; off: boolean } = { shortcuts: {}, off: false };
let asked = false;
const listeners = new Set<() => void>();
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** Reads the settings from the computer (once), and when they change. */
export function loadKeyboard(): void {
  void api<{ shortcuts: ShortcutMap; off: boolean }>("/api/settings/keyboard").then((r) => setKeyboard(r), () => undefined);
}

/** Shares new settings with every page (after Settings → Keyboard saved them). */
export function setKeyboard(next: { shortcuts: ShortcutMap; off: boolean }): void {
  state = next;
  for (const l of listeners) l();
}

/** @returns The settings, kept up to date. */
export function useKeyboard(): { shortcuts: ShortcutMap; off: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    listeners.add(on);
    if (!asked) {
      asked = true;
      loadKeyboard();
    }
    return () => void listeners.delete(on);
  }, []);
  return state;
}

/**
 * Whether a key press is this in-app shortcut now (its combination may have been changed, or all turned off).
 *
 * @param e - The key event.
 * @param id - The shortcut (see SHORTCUTS).
 */
export function isShortcut(e: KeyboardEvent, id: string): boolean {
  if (!asked) {
    asked = true;
    loadKeyboard();
  }
  if (state.off) return false;
  return pressMatches(e, shortcutKey(id, state.shortcuts, isMac()));
}
