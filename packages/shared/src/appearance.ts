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
  /** Behind everything: plain, a soft gradient of two colours, or a picture from the library (dimmed so text stays readable). */
  background?: { kind: "plain" } | { kind: "gradient"; from: string; to: string; angle?: number } | { kind: "image"; assetId: string; dim?: number };
  /** The menu's groups, top to bottom (missing ones keep their place after these). */
  navOrder?: string[];
  /** Menu groups to hide (their tools stay in All tools). */
  navHide?: string[];
  /** How much moves: none, subtle (default), or lively (a slowly moving background, cards that lift). */
  motion?: "none" | "subtle" | "lively";
  /** Your own icon for a tool (key: its page, e.g. "#/images"): an emoji, or a picture from the library. */
  icons?: Record<string, { emoji: string } | { assetId: string }>;
  /** Your own CSS, cleaned by cleanCss: looks only, nothing from outside, never hiding the safety parts. */
  css?: string;
  /** The look's name (for theme files). */
  name?: string;
  /** The start screen under the message box, top to bottom, and what is hidden. */
  homeOrder?: HomeSection[];
  homeHide?: HomeSection[];
  /** The phone's bottom bar, start to end. */
  tabsOrder?: PhoneTab[];
}

/** What the start screen can show under the message box. */
export const HOME_SECTIONS = ["ideas", "recent", "pins"] as const;
/** One part of the start screen. */
export type HomeSection = (typeof HOME_SECTIONS)[number];
/** The phone's bottom bar. */
export const PHONE_TABS = ["chats", "new", "tools", "settings"] as const;
/** One button of the phone bar. */
export type PhoneTab = (typeof PHONE_TABS)[number];

/** Ready-made looks. Graphite is the default look. */
export const APPEARANCE_PRESETS: Array<{ id: string; title: { en: string; he: string }; look: Appearance }> = [
  { id: "graphite", title: { en: "Graphite (default)", he: "גרפיט (ברירת מחדל)" }, look: {} },
  { id: "midnight", title: { en: "Midnight", he: "חצות" }, look: { colors: { bg: "#0b0d14", panel: "#11141f", "panel-2": "#171b2a", raised: "#202538", text: "#e8ebf4", muted: "#9aa3b8", accent: "#7cc4ff" } } },
  { id: "paper", title: { en: "Paper (light)", he: "נייר (בהיר)" }, look: { colors: { bg: "#f6f5f2", panel: "#ffffff", "panel-2": "#f0efeb", raised: "#e7e5df", text: "#1d1d1f", muted: "#6b6b73", accent: "#4f5bd5" } } },
  { id: "forest", title: { en: "Forest", he: "יער" }, look: { colors: { bg: "#101411", panel: "#151b17", "panel-2": "#1b231e", raised: "#243029", text: "#e9efe9", muted: "#94a398", accent: "#7fd6a0" } } },
  { id: "sunset", title: { en: "Sunset", he: "שקיעה" }, look: { colors: { accent: "#ffa27a" }, background: { kind: "gradient", from: "#1a1214", to: "#121213", angle: 160 } } },
  { id: "fulldark", title: { en: "Full dark (night, OLED, HDR)", he: "חושך מלא (לילה, OLED, HDR)" }, look: { colors: { bg: "#000000", panel: "#050505", "panel-2": "#0b0b0c", raised: "#151517", text: "#d4d4d8", muted: "#6f6f78", accent: "#6f7cff" }, background: { kind: "plain" }, motion: "none" } },
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
    } else if (bg.kind === "image" && typeof bg.assetId === "string" && ASSET_ID.test(bg.assetId)) {
      // Only a picture from the user's own library (an asset id), never an outside address.
      out.background = { kind: "image", assetId: bg.assetId.toLowerCase(), dim: num(bg.dim, 0, 90) ?? 55 };
    }
  }
  const groups = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && (APPEARANCE_NAV_GROUPS as readonly string[]).includes(x)))] : undefined);
  const order = groups(o.navOrder);
  if (order?.length) out.navOrder = order;
  const hide = groups(o.navHide);
  if (hide?.length) out.navHide = hide;
  if (o.motion === "none" || o.motion === "subtle" || o.motion === "lively") out.motion = o.motion;
  if (o.icons && typeof o.icons === "object") {
    const icons: NonNullable<Appearance["icons"]> = {};
    for (const [href, v] of Object.entries(o.icons as Record<string, unknown>).slice(0, 80)) {
      if (!/^#\/[\w/-]{1,60}$/.test(href) || !v || typeof v !== "object") continue;
      const e = (v as { emoji?: unknown }).emoji;
      const a = (v as { assetId?: unknown }).assetId;
      if (typeof e === "string" && e.trim() && [...e.trim()].length <= 4 && !/[<>"'`\\]/.test(e)) icons[href] = { emoji: e.trim() };
      else if (typeof a === "string" && ASSET_ID.test(a)) icons[href] = { assetId: a.toLowerCase() };
    }
    if (Object.keys(icons).length) out.icons = icons;
  }
  if (typeof o.css === "string" && o.css.trim()) {
    const css = cleanCss(o.css);
    if (css) out.css = css;
  }
  const pick = <T extends string>(v: unknown, all: readonly T[]): T[] | undefined => (Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === "string" && (all as readonly string[]).includes(x)))] : undefined);
  const ho = pick(o.homeOrder, HOME_SECTIONS);
  if (ho?.length) out.homeOrder = ho;
  const hh = pick(o.homeHide, HOME_SECTIONS);
  if (hh?.length) out.homeHide = hh;
  const to = pick(o.tabsOrder, PHONE_TABS);
  if (to?.length) out.tabsOrder = [...to, ...PHONE_TABS.filter((t) => !to.includes(t))];
  if (typeof o.name === "string" && o.name.trim()) out.name = o.name.trim().replace(/[<>]/g, "").slice(0, 60);
  return out;
}

const ASSET_ID = /^[0-9a-f-]{36}$/i;
/** The only at-rules a look may use; everything else (@import, @font-face, @layer…) is dropped. */
const AT_KEEP = /^@(media|supports)\b/i;
const AT_FRAMES = /^@(-webkit-)?keyframes\b/i;
/** Values that could run code or reach outside. */
const BAD_VALUE = /:\/\/|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|image-set\s*\(|src\s*\(/i;
/** Properties a look may not set: the safety guard's own variables. */
const BAD_PROP = /^--guard/i;
const MAX_CSS = 30_000;

function cleanUrl(value: string): string | undefined {
  let ok = true;
  const out = value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q, u: string) => {
    const url = u.trim();
    // Pictures from the user's own library, or small inline pictures; never an outside address.
    if (/^\/api\/assets\/[0-9a-f-]{36}$/i.test(url) || /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(url)) return `url("${url}")`;
    ok = false;
    return "none";
  });
  // A url( that the pattern did not read (odd quoting) is not let through either.
  const leftover = out.replace(/url\("[^"]*"\)/g, "");
  return ok && !/url\s*\(/i.test(leftover) ? out : undefined;
}

/** Splits at a character outside quotes and brackets. */
function splitOutside(text: string, ch: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ch && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function cleanDecls(body: string, important: boolean, pseudo: boolean): string {
  const decls: string[] = [];
  for (const raw of splitOutside(body, ";")) {
    const i = raw.indexOf(":");
    if (i < 0) continue;
    const prop = raw.slice(0, i).trim().toLowerCase();
    let value = raw.slice(i + 1).trim().replace(/!\s*important\s*$/i, "").trim();
    if (!/^-?-?[a-z][a-z0-9-]*$/.test(prop) || BAD_PROP.test(prop) || !value || BAD_VALUE.test(value)) continue;
    const v = cleanUrl(value);
    if (v === undefined) continue;
    value = v;
    // Nothing a look draws may sit above the safety parts: no fixed layers, z-index at most 1000,
    // and what ::before / ::after add stays in its place (it cannot be moved over buttons).
    if (prop === "position" && /fixed/i.test(value)) continue;
    if (pseudo && /^(position|inset|top|left|right|bottom|transform|translate|margin.*|z-index|inset-.*)$/.test(prop)) continue;
    if (prop === "z-index" && !(Number(value) <= 1000)) value = "1000";
    decls.push(`${prop}: ${value}${important ? " !important" : ""}`);
  }
  // What a look adds with ::before / ::after is only paint: it never catches clicks.
  if (pseudo && decls.length && !decls.some((d) => d.startsWith("pointer-events:"))) decls.push(`pointer-events: none${important ? " !important" : ""}`);
  return decls.join("; ");
}

/** Reads one block's rules; returns them cleaned. */
function cleanRules(text: string, inFrames: boolean): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    const semi = text.indexOf(";", i);
    if (open < 0) break;
    // An at-rule without a block (@import …;, @charset …;): dropped.
    if (semi >= 0 && semi < open && text.slice(i, semi).trim().startsWith("@")) {
      i = semi + 1;
      continue;
    }
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    let quote = "";
    for (; j < text.length && depth > 0; j++) {
      const c = text[j]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith("@")) {
      if (inFrames) continue;
      if (AT_KEEP.test(prelude) && !/[;{}]/.test(prelude) && !BAD_VALUE.test(prelude)) {
        const inner = cleanRules(body, false);
        if (inner) out.push(`${prelude} { ${inner} }`);
      } else if (AT_FRAMES.test(prelude) && /^@(-webkit-)?keyframes\s+[\w-]+$/i.test(prelude)) {
        const inner = cleanRules(body, true);
        if (inner) out.push(`${prelude} { ${inner} }`);
      }
      continue;
    }
    if (!prelude || /[;@]/.test(prelude) || prelude.length > 500) continue;
    const decls = cleanDecls(body, !inFrames, /::?(before|after|backdrop)/i.test(prelude));
    if (decls) out.push(`${prelude} { ${decls} }`);
  }
  return out.join("\n");
}

/**
 * Cleans a look's own CSS: only rules, @media, @supports and @keyframes;
 * no @import, @font-face or @layer, no outside addresses (only the user's
 * library pictures), nothing that runs code, no backslash escapes (they hide
 * the rest), z-index at most 1000, and ::before / ::after never catch clicks.
 * Every declaration gets !important, and the page adds it in a cascade layer
 * below the safety guard (see the web app's appearance.ts), so a look can
 * restyle everything but never hide or cover approvals.
 *
 * @param css - The CSS as written.
 * @returns The cleaned CSS ("" when nothing was left).
 */
export function cleanCss(css: string): string {
  const text = css
    .slice(0, MAX_CSS)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<\/?\w[^>]*>/g, "");
  if (/\\/.test(text)) return cleanCss(text.replace(/\\/g, ""));
  return cleanRules(text, false);
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
