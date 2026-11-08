import { useEffect, useState } from "react";
import { APPEARANCE_FONTS, APPEARANCE_NAV_GROUPS, cleanAppearance, isLight, resolveAppearance, type Appearance } from "@kesher/shared";
import { api, withToken } from "./api";

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

/**
 * The safety guard: in the first cascade layer, so its !important rules beat
 * every look's (looks are in the later "kesher-look" layer and cleaned by
 * cleanCss). Approvals keep the default colours and can never be hidden,
 * faded, moved, covered or relabelled by a look.
 */
const GUARD = `@layer kesher-guard, kesher-look;
@layer kesher-guard {
  [data-guard] {
    --bg: #121213; --panel: #18181a; --panel-2: #1f1f22; --raised: #29292d; --text: #ededee; --text-2: #c6c6cb; --muted: #94949c;
    --accent: #98a3ff; --accent-ink: #121213; --accent-soft: rgb(152 163 255 / 0.13); --border: rgb(255 255 255 / 0.07); --border-strong: rgb(255 255 255 / 0.12);
    visibility: visible !important; opacity: 1 !important; filter: none !important; clip-path: none !important; mask: none !important;
    pointer-events: auto !important; color: #ededee !important; font-size: 15px !important; z-index: 100000 !important;
  }
  .approval[data-guard] { display: flex !important; flex-direction: column !important; position: relative !important; transform: none !important; background: #1f1b15 !important; max-height: none !important; overflow: visible !important; }
  [data-guard] * { visibility: visible !important; opacity: 1 !important; filter: none !important; clip-path: none !important; mask: none !important; transform: none !important; order: 0 !important; text-indent: 0 !important; letter-spacing: normal !important; font-size: clamp(11px, 1em, 32px) !important; }
  [data-guard] .row { flex-direction: row !important; }
  [data-guard]::before, [data-guard]::after, [data-guard] *::before, [data-guard] *::after { content: none !important; }
  [data-guard] button { color: #ededee !important; background: #29292d !important; }
  [data-guard] button.primary { color: #121213 !important; background: #98a3ff !important; }
}`;

function setStyle(id: string, css: string): void {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}
let current: Appearance = {};
const listeners = new Set<(a: Appearance) => void>();

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

/** @param saved - The look as saved (before its preset is applied). */
export function applyAppearance(input: Appearance): void {
  // Checked again here: this browser's copy could have been changed by hand.
  const saved = cleanAppearance(input);
  current = saved;
  const a = resolveAppearance(saved);
  const root = document.documentElement;
  const st = root.style;
  for (const p of [...st]) if (p.startsWith("--") || p === "font-family" || p === "font-size" || p === "color-scheme" || p === "dynamic-range-limit") st.removeProperty(p);
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
  // Full dark: true black for OLED and night. On an HDR screen the accent uses the wider (P3) colours,
  // and bright HDR pictures are held near normal white so they do not glare out of the black.
  root.dataset.preset = a.preset ?? "";
  if (a.preset === "fulldark") {
    st.setProperty("color-scheme", "dark");
    st.setProperty("--border", "rgb(255 255 255 / 0.06)");
    st.setProperty("--border-strong", "rgb(255 255 255 / 0.11)");
    st.setProperty("--shadow-1", "none");
    st.setProperty("--shadow-2", "0 0 0 1px rgb(255 255 255 / 0.08)");
    st.setProperty("dynamic-range-limit", "constrained");
    if (!saved.colors?.accent && matchMedia("(dynamic-range: high)").matches) st.setProperty("--accent", "color(display-p3 0.43 0.48 1)");
  }
  const font = APPEARANCE_FONTS.find((f) => f.id === a.font);
  if (font && font.id !== "rubik") {
    void FONT_FILES[font.id]?.().catch(() => undefined);
    st.setProperty("font-family", font.stack);
  }
  if (a.fontSize) st.setProperty("font-size", `${a.fontSize}px`);
  if (a.radius !== undefined) st.setProperty("--r-scale", String(a.radius / 16));
  root.dataset.density = a.density && a.density !== "normal" ? a.density : "";
  root.dataset.motion = a.motion ?? "subtle";
  // The look's own CSS (already cleaned on the computer), below the safety guard.
  setStyle("kesher-guard", GUARD);
  setStyle("kesher-look", a.css ? `@layer kesher-look {\n${a.css}\n}` : "");
  const back = a.background;
  const veil = (dim: number) => `color-mix(in srgb, var(--bg) ${dim}%, transparent)`;
  document.body.style.background =
    back?.kind === "gradient"
      ? `linear-gradient(${back.angle ?? 160}deg, ${back.from}, ${back.to}) fixed`
      : back?.kind === "image"
        ? `linear-gradient(${veil(back.dim ?? 55)}, ${veil(back.dim ?? 55)}), url("${withToken(`/api/assets/${back.assetId}`)}") center / cover fixed`
        : "";
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
