import { APPEARANCE_FONTS, cleanColor, type Appearance, type AppearanceColor } from "@kesher/shared";
import { api, withToken } from "./api";

/**
 * Theme files, Figma tokens and colours from a picture — all turned into a
 * plain look (data only; the computer checks it again with cleanAppearance).
 */

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every library picture a look uses (background, icons, CSS). */
function picturesOf(a: Appearance): string[] {
  const ids = new Set<string>();
  if (a.background?.kind === "image") ids.add(a.background.assetId);
  for (const v of Object.values(a.icons ?? {})) if ("assetId" in v) ids.add(v.assetId);
  for (const m of a.css?.match(ID) ?? []) ids.add(m.toLowerCase());
  return [...ids];
}

const toBase64 = async (blob: Blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * @param a - The look.
 * @returns A theme file to share, with its pictures inside.
 */
export async function exportTheme(a: Appearance): Promise<Blob> {
  const pictures: Record<string, { mimeType: string; data: string }> = {};
  for (const id of picturesOf(a)) {
    const r = await fetch(withToken(`/api/assets/${id}`));
    if (!r.ok) continue;
    const blob = await r.blob();
    pictures[id] = { mimeType: blob.type || "image/png", data: await toBase64(blob) };
  }
  return new Blob([JSON.stringify({ kesherTheme: 1, look: a, pictures }, null, 1)], { type: "application/json" });
}

/**
 * Reads a theme file: its pictures go into this library under new ids.
 *
 * @param file - A .kesher-theme.json file.
 * @returns The look (to be saved, and checked again by the computer).
 */
export async function importTheme(file: File): Promise<Appearance> {
  if (file.size > 25 * 1024 * 1024) throw new Error("That theme file is too big (over 25 MB).");
  const j = JSON.parse(await file.text()) as { kesherTheme?: number; look?: Appearance; pictures?: Record<string, { mimeType?: string; data?: string }> };
  if (j.kesherTheme !== 1 || !j.look || typeof j.look !== "object") throw new Error("That is not a KesherAI theme file.");
  let text = JSON.stringify(j.look);
  for (const [oldId, p] of Object.entries(j.pictures ?? {})) {
    if (!/^[0-9a-f-]{36}$/i.test(oldId) || typeof p?.data !== "string" || !/^image\/(png|jpeg|webp)$/.test(p.mimeType ?? "")) continue;
    const { assetId } = await api<{ assetId: string }>("/api/appearance/background", { method: "POST", body: { data: p.data, mimeType: p.mimeType } });
    text = text.split(oldId).join(assetId);
  }
  return JSON.parse(text) as Appearance;
}

/** Which of our colours a token name means (Figma, Tokens Studio, W3C design tokens). */
const NAMES: Array<[AppearanceColor, RegExp]> = [
  ["muted", /muted|secondary.?text|text.?secondary|subtle|placeholder|on.?surface.?variant/i],
  ["text", /(^|[/._-])(text|foreground|fg|on.?(background|surface)|content)([/._-]|$)/i],
  ["accent", /primary|accent|brand|highlight|interactive|link/i],
  ["panel-2", /surface.?(2|variant|container.?high)|input|field|elevated|menu/i],
  ["raised", /hover|raised|surface.?3|overlay/i],
  ["panel", /surface|card|panel|container/i],
  ["bg", /background|(^|[/._-])bg([/._-]|$)|canvas|base|page/i],
];

/**
 * Reads a Figma variables export or a design-tokens JSON (Tokens Studio, W3C)
 * and maps what it can: colours by their names, a font, corner radius.
 *
 * @param text - The JSON text.
 * @returns The look, and what was found.
 */
export function lookFromTokens(text: string): { look: Appearance; found: string[] } {
  const data = JSON.parse(text) as unknown;
  const colors: Partial<Record<AppearanceColor, string>> = {};
  const found: string[] = [];
  let font: string | undefined;
  let radius: number | undefined;
  const walk = (v: unknown, path: string) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    // A token: { $value | value, $type | type }; Figma's export: { name, resolvedValuesByMode | valuesByMode }.
    const raw = o.$value ?? o.value ?? (o.resolvedValuesByMode ? Object.values(o.resolvedValuesByMode as object)[0] : undefined) ?? (o.valuesByMode ? Object.values(o.valuesByMode as object)[0] : undefined);
    const name = `${path}/${typeof o.name === "string" ? o.name : ""}`;
    if (raw !== undefined && typeof raw !== "object") {
      const value = String(raw);
      const color = cleanColor(value.length === 9 && value.startsWith("#") ? value.slice(0, 7) : value);
      if (color) {
        const slot = NAMES.find(([, re]) => re.test(name))?.[0];
        if (slot && !colors[slot]) {
          colors[slot] = color;
          found.push(`${slot} ← ${name.replace(/^\/+/, "")}`);
        }
      } else if (/font.?family|typeface/i.test(name) || o.$type === "fontFamily") {
        font ??= APPEARANCE_FONTS.find((f) => value.toLowerCase().includes(f.title.toLowerCase()))?.id;
      } else if (/radius|corner/i.test(name) && radius === undefined) {
        const n = parseFloat(value);
        if (Number.isFinite(n)) radius = n;
      }
    } else if (raw && typeof raw === "object" && "r" in (raw as object)) {
      // Figma colour objects: { r, g, b, a } from 0 to 1.
      const c = raw as { r: number; g: number; b: number };
      const hex = `#${[c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
      const slot = NAMES.find(([, re]) => re.test(name))?.[0];
      if (slot && !colors[slot]) {
        colors[slot] = hex;
        found.push(`${slot} ← ${name.replace(/^\/+/, "")}`);
      }
    }
    for (const [k, child] of Object.entries(o)) if (child && typeof child === "object" && !k.startsWith("$")) walk(child, `${path}/${k}`);
  };
  walk(data, "");
  const look: Appearance = {};
  if (Object.keys(colors).length) look.colors = colors;
  if (font) {
    look.font = font;
    found.push(`font ← ${font}`);
  }
  if (radius !== undefined) {
    look.radius = Math.max(0, Math.min(28, Math.round(radius)));
    found.push(`radius ← ${radius}`);
  }
  return { look, found };
}

const lum = ([r, g, b]: number[]) => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
const sat = ([r, g, b]: number[]) => {
  const mx = Math.max(r!, g!, b!);
  const mn = Math.min(r!, g!, b!);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const hex = (c: number[]) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t);

/**
 * The main colours of a picture (a screenshot of a design, a poster): the
 * most common becomes the page, the most vivid the accent, and text the one
 * that reads best on the page.
 *
 * @param file - A picture.
 * @returns Colours for a look.
 */
export async function lookFromPicture(file: File): Promise<Appearance> {
  const bmp = await createImageBitmap(file);
  const w = 96;
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  // Colours in buckets of 16 levels, counted.
  const buckets = new Map<number, { n: number; sum: number[] }>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 128) continue;
    const key = ((px[i]! >> 4) << 8) | ((px[i + 1]! >> 4) << 4) | (px[i + 2]! >> 4);
    const b = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] };
    b.n++;
    b.sum[0]! += px[i]!;
    b.sum[1]! += px[i + 1]!;
    b.sum[2]! += px[i + 2]!;
    buckets.set(key, b);
  }
  const colors = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 24).map((b) => ({ c: b.sum.map((x) => x / b.n), n: b.n }));
  if (!colors.length) throw new Error("No colours found in that picture.");
  const bg = colors[0]!.c;
  const light = lum(bg) > 0.55;
  const accent = [...colors].filter((x) => sat(x.c) > 0.35 && Math.abs(lum(x.c) - lum(bg)) > 0.18).sort((a, b) => sat(b.c) * Math.sqrt(b.n) - sat(a.c) * Math.sqrt(a.n))[0]?.c ?? (light ? [79, 91, 213] : [152, 163, 255]);
  const text = [...colors].sort((a, b) => Math.abs(lum(b.c) - lum(bg)) - Math.abs(lum(a.c) - lum(bg)))[0]!.c;
  const textC = Math.abs(lum(text) - lum(bg)) > 0.5 ? text : light ? [29, 29, 31] : [237, 237, 238];
  const toward = light ? [0, 0, 0] : [255, 255, 255];
  const look: Appearance = {
    colors: {
      bg: hex(bg),
      panel: light ? hex(mix(bg, [255, 255, 255], 0.6)) : hex(mix(bg, toward, 0.04)),
      "panel-2": hex(mix(bg, toward, 0.07)),
      raised: hex(mix(bg, toward, 0.13)),
      text: hex(textC),
      muted: hex(mix(textC, bg, 0.4)),
      accent: hex(accent),
    },
  };
  return look;
}
