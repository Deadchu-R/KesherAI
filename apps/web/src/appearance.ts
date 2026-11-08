import { useEffect, useState } from "react";
import { APPEARANCE_FONTS, APPEARANCE_NAV_GROUPS, isLight, resolveAppearance, type Appearance } from "@kesher/shared";
import { api } from "./api";

/**
 * Applies the saved look (Settings → Appearance, or the chat's change_look)
 * on top of the default tokens in styles.css, and keeps it in step: after a
 * change here, after the chat changed it, and when the window comes back.
 */

/** Each font's files, loaded only when that font is picked (they ship with the app). */
const FONT_FILES: Record<string, () => Promise<unknown>> = {
  heebo: () => Promise.all([import("@fontsource/heebo/400.css"), import("@fontsource/heebo/500.css"), import("@fontsource/heebo/700.css")]),
  assistant: () => Promise.all([import("@fontsource/assistant/400.css"), import("@fontsource/assistant/600.css")]),
  "varela-round": () => import("@fontsource/varela-round/400.css"),
  "secular-one": () => import("@fontsource/secular-one/400.css"),
  inter: () => Promise.all([import("@fontsource/inter/400.css"), import("@fontsource/inter/500.css"), import("@fontsource/inter/600.css")]),
};

const CACHE = "kesher.look";
let current: Appearance = {};
const listeners = new Set<(a: Appearance) => void>();

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

/** @param saved - The look as saved (before its preset is applied). */
export function applyAppearance(saved: Appearance): void {
  current = saved;
  const a = resolveAppearance(saved);
  const root = document.documentElement;
  const st = root.style;
  for (const p of [...st]) if (p.startsWith("--") || p === "font-family" || p === "font-size" || p === "color-scheme") st.removeProperty(p);
  for (const [k, v] of Object.entries(a.colors ?? {})) if (v) st.setProperty(`--${k}`, v);
  const bg = a.colors?.bg;
  const light = !!bg && isLight(bg);
  if (light) {
    st.setProperty("color-scheme", "light");
    st.setProperty("--border", "rgb(0 0 0 / 0.08)");
    st.setProperty("--border-strong", "rgb(0 0 0 / 0.14)");
    st.setProperty("--text-2", a.colors?.text ?? "#2a2a2e");
    st.setProperty("--shadow-1", "0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.06)");
    st.setProperty("--shadow-2", "0 2px 6px rgb(0 0 0 / 0.08), 0 24px 64px rgb(0 0 0 / 0.12)");
  }
  root.dataset.light = light ? "1" : "";
  const accent = a.colors?.accent;
  if (accent) {
    st.setProperty("--accent-soft", `rgb(${hexToRgb(accent)} / ${light ? 0.14 : 0.13})`);
    st.setProperty("--accent-ink", isLight(accent) ? "#121213" : "#ffffff");
  }
  const font = APPEARANCE_FONTS.find((f) => f.id === a.font);
  if (font && font.id !== "rubik") {
    void FONT_FILES[font.id]?.().catch(() => undefined);
    st.setProperty("font-family", font.stack);
  }
  if (a.fontSize) st.setProperty("font-size", `${a.fontSize}px`);
  if (a.radius !== undefined) st.setProperty("--r-scale", String(a.radius / 16));
  root.dataset.density = a.density && a.density !== "normal" ? a.density : "";
  document.body.style.background = a.background?.kind === "gradient" ? `linear-gradient(${a.background.angle ?? 160}deg, ${a.background.from}, ${a.background.to}) fixed` : "";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg ?? "#121213");
  try {
    localStorage.setItem(CACHE, JSON.stringify(saved));
  } catch {
    // the next start fetches it again
  }
  for (const l of listeners) l(saved);
}

/** Loads the look: at once from this browser's copy (no flash), then from the computer. */
export function loadAppearance(): void {
  try {
    const cached = localStorage.getItem(CACHE);
    if (cached) applyAppearance(JSON.parse(cached) as Appearance);
  } catch {
    // ignore
  }
  const refresh = () => void api<{ appearance: Appearance }>("/api/appearance").then((r) => applyAppearance(r.appearance), () => undefined);
  refresh();
  addEventListener("kesher-appearance", refresh);
  addEventListener("focus", refresh);
}

/** Tells the page the look changed elsewhere (the chat's change_look). */
export function appearanceChanged(): void {
  dispatchEvent(new Event("kesher-appearance"));
}

/**
 * @param next - The whole new look ({} is the default).
 * @returns Whether Undo is possible now.
 */
export async function saveAppearance(next: Appearance): Promise<boolean> {
  applyAppearance(next);
  const r = await api<{ appearance: Appearance; canUndo: boolean }>("/api/appearance", { method: "PUT", body: { appearance: next } });
  applyAppearance(r.appearance);
  return r.canUndo;
}

/** @returns Whether there is more to undo. */
export async function undoAppearance(): Promise<boolean> {
  const r = await api<{ appearance: Appearance; canUndo: boolean }>("/api/appearance", { method: "PUT", body: { undo: true } });
  applyAppearance(r.appearance);
  return r.canUndo;
}

/** @returns The current look, kept up to date. */
export function useAppearance(): Appearance {
  const [a, setA] = useState<Appearance>(current);
  useEffect(() => {
    listeners.add(setA);
    return () => void listeners.delete(setA);
  }, []);
  return a;
}

/**
 * @param groups - Tool groups with ids.
 * @param a - The look.
 * @returns The groups in the user's order, without hidden ones.
 */
export function orderGroups<T extends { id: string }>(groups: T[], a: Appearance): T[] {
  const order = [...(a.navOrder ?? []), ...APPEARANCE_NAV_GROUPS];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? 99 : i;
  };
  return groups.filter((g) => !a.navHide?.includes(g.id)).sort((x, y) => rank(x.id) - rank(y.id));
}
