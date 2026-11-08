/**
 * How KesherAI looks, as the user (or the local AI, through the chat's
 * change_look tool) set it: colours, font, sizes, corners, background,
 * spacing and the order of the menu's groups. Everything is optional; what
 * is not set keeps the default look (styles.css). Values are checked here,
 * so nothing a model writes can break the page or load anything from outside.
 */

/** The colours that can be changed (CSS variables of the same names). */
export const APPEARANCE_COLORS = ["bg", "panel", "panel-2", "raised", "text", "muted", "accent"] as const;
/** One of APPEARANCE_COLORS. */
export type AppearanceColor = (typeof APPEARANCE_COLORS)[number];

/** Fonts that ship with KesherAI (no download, work offline). The first is the default. */
export const APPEARANCE_FONTS: Array<{ id: string; title: string; stack: string; hebrew: boolean }> = [
  { id: "rubik", title: "Rubik", stack: "Rubik, system-ui, sans-serif", hebrew: true },
  { id: "heebo", title: "Heebo", stack: "Heebo, Rubik, system-ui, sans-serif", hebrew: true },
  { id: "assistant", title: "Assistant", stack: "Assistant, Rubik, system-ui, sans-serif", hebrew: true },
  { id: "varela-round", title: "Varela Round", stack: "'Varela Round', Rubik, system-ui, sans-serif", hebrew: true },
  { id: "secular-one", title: "Secular One", stack: "'Secular One', Rubik, system-ui, sans-serif", hebrew: true },
  { id: "inter", title: "Inter", stack: "Inter, Rubik, system-ui, sans-serif", hebrew: false },
  { id: "system", title: "System", stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", hebrew: true },
];

/** The tool groups (All tools, the app bar), in their default order. */
export const APPEARANCE_NAV_GROUPS = ["create", "work", "assistant", "system"] as const;

/** A look: everything optional, what is missing keeps the default. */
export interface Appearance {
  /** A ready-made look the rest is applied on top of. */
  preset?: string;
  colors?: Partial<Record<AppearanceColor, string>>;
  /** An id from APPEARANCE_FONTS. */
  font?: string;
  /** Text size in px, 12–20 (default 15). */
  fontSize?: number;
  /** Corner roundness of cards in px, 0–28 (default 16). */
  radius?: number;
  /** Space between things. */
  density?: "compact" | "normal" | "roomy";
  /** Behind everything: plain, or a soft gradient of two colours. */
  background?: { kind: "plain" } | { kind: "gradient"; from: string; to: string; angle?: number };
  /** The menu's groups, top to bottom (missing ones keep their place after these). */
  navOrder?: string[];
  /** Menu groups to hide (their tools stay in All tools). */
  navHide?: string[];
}

/** Ready-made looks. Graphite is the default look. */
export const APPEARANCE_PRESETS: Array<{ id: string; title: { en: string; he: string }; look: Appearance }> = [
  { id: "graphite", title: { en: "Graphite (default)", he: "גרפיט (ברירת מחדל)" }, look: {} },
  { id: "midnight", title: { en: "Midnight", he: "חצות" }, look: { colors: { bg: "#0b0d14", panel: "#11141f", "panel-2": "#171b2a", raised: "#202538", text: "#e8ebf4", muted: "#9aa3b8", accent: "#7cc4ff" } } },
  { id: "paper", title: { en: "Paper (light)", he: "נייר (בהיר)" }, look: { colors: { bg: "#f6f5f2", panel: "#ffffff", "panel-2": "#f0efeb", raised: "#e7e5df", text: "#1d1d1f", muted: "#6b6b73", accent: "#4f5bd5" } } },
  { id: "forest", title: { en: "Forest", he: "יער" }, look: { colors: { bg: "#101411", panel: "#151b17", "panel-2": "#1b231e", raised: "#243029", text: "#e9efe9", muted: "#94a398", accent: "#7fd6a0" } } },
  { id: "sunset", title: { en: "Sunset", he: "שקיעה" }, look: { colors: { accent: "#ffa27a" }, background: { kind: "gradient", from: "#1a1214", to: "#121213", angle: 160 } } },
  { id: "contrast", title: { en: "High contrast", he: "ניגודיות גבוהה" }, look: { colors: { bg: "#000000", panel: "#0d0d0d", "panel-2": "#161616", raised: "#222222", text: "#ffffff", muted: "#c8c8c8", accent: "#ffd34d" }, fontSize: 16 } },
];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#e5484d", orange: "#f2994a", yellow: "#f5d90a", green: "#46a758", teal: "#12a594", blue: "#3e63dd", purple: "#8e4ec6", pink: "#d6409f", gray: "#8b8d98", grey: "#8b8d98" };

/** @returns The colour as #rrggbb, or undefined when it is not a colour. */
export function cleanColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  if (!HEX.test(s)) return undefined;
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
}

const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : undefined;
};

/**
 * @param input - Anything (a saved file, a request body, a model's tool call).
 * @returns Only the valid parts of it.
 */
export function cleanAppearance(input: unknown): Appearance {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Appearance = {};
  if (typeof o.preset === "string" && APPEARANCE_PRESETS.some((p) => p.id === o.preset)) out.preset = o.preset;
  if (o.colors && typeof o.colors === "object") {
    const colors: Partial<Record<AppearanceColor, string>> = {};
    for (const k of APPEARANCE_COLORS) {
      const c = cleanColor((o.colors as Record<string, unknown>)[k] ?? (k === "panel-2" ? (o.colors as Record<string, unknown>).panel2 : undefined));
      if (c) colors[k] = c;
    }
    if (Object.keys(colors).length) out.colors = colors;
  }
  if (typeof o.font === "string") {
    const f = APPEARANCE_FONTS.find((x) => x.id === o.font || x.title.toLowerCase() === String(o.font).toLowerCase());
    if (f) out.font = f.id;
  }
  const fs = num(o.fontSize, 12, 20);
  if (fs !== undefined) out.fontSize = fs;
  const r = num(o.radius, 0, 28);
  if (r !== undefined) out.radius = r;
  if (o.density === "compact" || o.density === "normal" || o.density === "roomy") out.density = o.density;
  const bg = o.background as Record<string, unknown> | undefined;
  if (bg && typeof bg === "object") {
    if (bg.kind === "plain") out.background = { kind: "plain" };
    else if (bg.kind === "gradient") {
      const from = cleanColor(bg.from);
      const to = cleanColor(bg.to);
      if (from && to) out.background = { kind: "gradient", from, to, angle: num(bg.angle, 0, 360) ?? 160 };
    }
  }
  const groups = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && (APPEARANCE_NAV_GROUPS as readonly string[]).includes(x)))] : undefined);
  const order = groups(o.navOrder);
  if (order?.length) out.navOrder = order;
  const hide = groups(o.navHide);
  if (hide?.length) out.navHide = hide;
  return out;
}

/**
 * @param a - A saved look.
 * @returns The look with its preset's values under the user's own.
 */
export function resolveAppearance(a: Appearance): Appearance {
  const base = APPEARANCE_PRESETS.find((p) => p.id === a.preset)?.look ?? {};
  return { ...base, ...a, colors: { ...base.colors, ...a.colors } };
}

/** @returns Whether a colour is light (for the light colour scheme and for text on the accent). */
export function isLight(hex: string): boolean {
  const c = cleanColor(hex);
  if (!c) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}
