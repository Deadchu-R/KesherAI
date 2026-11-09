/**
 * Figma → KesherAI's look, with the user's own personal access token:
 *
 * - the file's Variables (colours, radii, fonts), or — when the plan does
 *   not allow the Variables API — its colour and text styles, become
 *   design tokens that the Appearance screen maps to the app's colours;
 * - a frame becomes a picture (the background).
 *
 * Safe by design: only api.figma.com is asked, with the token in a header
 * (never in an address or a log); a frame's picture is downloaded only over
 * HTTPS from Figma's image hosts, at most 12 MB, and must really be a PNG.
 * The token is kept in KesherAI's settings on this computer and never sent
 * to a page.
 */

const API = "https://api.figma.com/v1";
const MAX_IMAGE = 12 * 1024 * 1024;

/** The file key and (optional) node from a Figma link (design/, file/ or proto/). */
export function parseFigmaLink(link: string): { key: string; node?: string } | undefined {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || !/(^|\.)figma\.com$/.test(u.hostname)) return undefined;
  const m = /^\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,64})(?:\/branch\/([A-Za-z0-9]{10,64}))?/.exec(u.pathname);
  if (!m) return undefined;
  const node = u.searchParams.get("node-id")?.replace(/-/g, ":");
  return { key: m[2] ?? m[1]!, ...(node && /^[\w:;]{1,80}$/.test(node) ? { node } : {}) };
}

/** One design token, in the shape the Appearance screen reads. */
export interface FigmaToken {
  name: string;
  $value: string;
}

const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("")}`;

async function get<T>(path: string, token: string, f: typeof fetch): Promise<{ status: number; body?: T }> {
  const res = await f(`${API}${path}`, { headers: { "x-figma-token": token }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 403 && /invalid token|Invalid token/i.test(await res.clone().text().catch(() => ""))) throw new Error("Figma refused the token: make a new personal access token (Figma → Settings → Security).");
  if (res.status === 429) throw new Error("Figma says too many requests: wait a minute and try again.");
  return { status: res.status, ...(res.ok ? { body: (await res.json()) as T } : {}) };
}

/**
 * A file's design tokens: its Variables when Figma allows it, else its colour and text styles.
 *
 * @returns The tokens, the file's name, and where they came from.
 */
export async function figmaTokens(token: string, key: string, f: typeof fetch = fetch): Promise<{ name: string; from: "variables" | "styles"; tokens: FigmaToken[] }> {
  const meta = await get<{ name?: string }>(`/files/${key}?depth=1`, token, f);
  if (meta.status === 404) throw new Error("Figma has no such file, or this token cannot open it.");
  if (!meta.body) throw new Error(`Figma answered ${meta.status}.`);
  const name = String(meta.body.name ?? "Figma file");
  // Variables (Figma's design tokens).
  const vars = await get<{ meta?: { variables?: Record<string, { name: string; resolvedType: string; valuesByMode: Record<string, unknown> }> } }>(`/files/${key}/variables/local`, token, f).catch(() => ({ status: 0 }) as { status: number; body?: undefined });
  const fromVars: FigmaToken[] = [];
  for (const v of Object.values(vars.body?.meta?.variables ?? {})) {
    const value = Object.values(v.valuesByMode ?? {})[0];
    if (v.resolvedType === "COLOR" && value && typeof value === "object" && "r" in value) fromVars.push({ name: v.name, $value: hex(value as { r: number; g: number; b: number }) });
    else if ((v.resolvedType === "FLOAT" || v.resolvedType === "STRING") && (typeof value === "number" || typeof value === "string")) fromVars.push({ name: v.name, $value: String(value) });
  }
  if (fromVars.length) return { name, from: "variables", tokens: fromVars.slice(0, 400) };
  // Styles (every plan): the colour of each fill style and the font of each text style.
  const styles = await get<{ meta?: { styles?: Array<{ node_id: string; name: string; style_type: string }> } }>(`/files/${key}/styles`, token, f);
  const list = (styles.body?.meta?.styles ?? []).filter((s) => s.style_type === "FILL" || s.style_type === "TEXT").slice(0, 200);
  if (!list.length) return { name, from: "styles", tokens: [] };
  const ids = list.map((s) => s.node_id).join(",");
  const nodes = await get<{ nodes?: Record<string, { document?: { fills?: Array<{ type: string; color?: { r: number; g: number; b: number } }>; style?: { fontFamily?: string } } }> }>(`/files/${key}/nodes?ids=${encodeURIComponent(ids)}`, token, f);
  const out: FigmaToken[] = [];
  for (const s of list) {
    const d = nodes.body?.nodes?.[s.node_id]?.document;
    const solid = d?.fills?.find((x) => x.type === "SOLID" && x.color);
    if (s.style_type === "FILL" && solid?.color) out.push({ name: s.name, $value: hex(solid.color) });
    if (s.style_type === "TEXT" && d?.style?.fontFamily) out.push({ name: `${s.name} font-family`, $value: d.style.fontFamily });
  }
  return { name, from: "styles", tokens: out };
}

/**
 * A frame (or any node) of a file as a PNG picture.
 *
 * @returns The picture's bytes.
 */
export async function figmaFrame(token: string, key: string, node: string, f: typeof fetch = fetch): Promise<Uint8Array> {
  const r = await get<{ err?: string | null; images?: Record<string, string | null> }>(`/images/${key}?ids=${encodeURIComponent(node)}&format=png&scale=2`, token, f);
  const url = r.body?.images?.[node];
  if (!url) throw new Error(r.body?.err ?? "Figma could not make a picture of that frame. Copy the link of a frame (right-click → Copy link to selection).");
  const u = new URL(url);
  if (u.protocol !== "https:" || !/(\.amazonaws\.com|\.figma\.com)$/.test(u.hostname)) throw new Error("Figma gave an unexpected picture address.");
  const res = await f(u, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`The picture answered ${res.status}.`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE) throw new Error("The frame's picture is too big (over 12 MB): pick a smaller frame.");
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_IMAGE) throw new Error("The frame's picture is too big (over 12 MB): pick a smaller frame.");
  if (!(data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)) throw new Error("Figma's answer was not a picture.");
  return data;
}

/**
 * One node of a Figma file with everything inside it (for Figma → Unreal widgets).
 *
 * @returns The node's document JSON (figma-umg.ts reads it).
 */
export async function figmaNodeTree(token: string, key: string, node: string, f: typeof fetch = fetch): Promise<unknown> {
  const r = await get<{ nodes?: Record<string, { document?: unknown } | null> }>(`/files/${key}/nodes?ids=${encodeURIComponent(node)}`, token, f);
  if (r.status === 404) throw new Error("Figma has no such file, or this token cannot open it.");
  const doc = r.body?.nodes?.[node]?.document;
  if (!doc) throw new Error("That frame was not found: in Figma right-click the frame → Copy link to selection, and paste that link.");
  return doc;
}
