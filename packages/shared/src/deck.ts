/**
 * KesherAI's own slide decks (design DeckEditor; RESEARCH_LOG "Canvas documents, part 1"): slides as data, edited by
 * her on the canvas and by the model through a tool, presented in KesherAI and exported to PDF (PPTX optional).
 */

/** A slide's layout. */
export type SlideLayout = "title" | "bullets" | "two" | "quote" | "picture";
export const SLIDE_LAYOUTS: SlideLayout[] = ["title", "bullets", "two", "quote", "picture"];

/** One slide. */
export interface Slide {
  id: string;
  layout: SlideLayout;
  title: string;
  /** Bullets (bullets, and the first column of "two"). */
  bullets: string[];
  /** The second column ("two"), or the quote's source ("quote"), or the picture's caption. */
  more?: string[];
  /** A picture's address (https or a data: URL), for "picture". */
  image?: string;
  notes?: string;
}

/** A deck's colors. */
export type DeckTheme = "night" | "paper" | "ocean" | "sunset" | "forest";
export const DECK_THEMES: Record<DeckTheme, { bg: string; fg: string; accent: string; muted: string; he: string; en: string }> = {
  night: { bg: "#1b2140", fg: "#ffffff", accent: "#a5b4ff", muted: "#c9cdf0", he: "לילה", en: "Night" },
  paper: { bg: "#fbfaf7", fg: "#1d1d22", accent: "#3d5afe", muted: "#5b5e6b", he: "נייר", en: "Paper" },
  ocean: { bg: "#0f3b4a", fg: "#ffffff", accent: "#7fd8e8", muted: "#bfe6ee", he: "ים", en: "Ocean" },
  sunset: { bg: "#3b1d3f", fg: "#fff6ee", accent: "#ffb27a", muted: "#f1cfd6", he: "שקיעה", en: "Sunset" },
  forest: { bg: "#17301f", fg: "#f2f7ef", accent: "#9fe0a8", muted: "#c7dcc8", he: "יער", en: "Forest" },
};

/** A deck. */
export interface Deck {
  id: string;
  title: string;
  theme: DeckTheme;
  slides: Slide[];
  /** The chat it belongs to, if any. */
  convId?: string;
  /** Each save adds one; the editor sends the one it started from. */
  rev: number;
  updatedAt: string;
  /** Earlier versions (the last 20), newest last. */
  versions?: Array<{ rev: number; at: string; slides: Slide[]; theme: DeckTheme; title: string }>;
}

const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, n) : "");

/**
 * A slide from the editor or the model, checked: a known layout, text trimmed, at most 12 bullets, a picture only
 * from https or a data: image URL.
 *
 * @param raw - The slide.
 * @param id - An id when it has none.
 */
export function cleanSlide(raw: unknown, id: string): Slide {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const layout = SLIDE_LAYOUTS.includes(o.layout as SlideLayout) ? (o.layout as SlideLayout) : "bullets";
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => s(x, 400)).filter(Boolean).slice(0, 12) : []);
  const image = s(o.image, 3_000_000);
  return {
    id: typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : id,
    layout,
    title: s(o.title, 200),
    bullets: list(o.bullets),
    ...(list(o.more).length ? { more: list(o.more) } : {}),
    ...(/^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/.test(image) ? { image } : {}),
    ...(s(o.notes, 4000) ? { notes: s(o.notes, 4000) } : {}),
  };
}

/** A deck as text for the model: each slide's number, id, layout, title and points. */
export function describeDeck(d: Pick<Deck, "title" | "theme" | "slides">): string {
  return [`Deck "${d.title}" (theme ${d.theme}), ${d.slides.length} slides:`, ...d.slides.map((x, i) => `${i + 1}. [${x.id}] ${x.layout}: ${x.title}${x.bullets.length ? `\n   - ${x.bullets.join("\n   - ")}` : ""}${x.more?.length ? `\n   (more) ${x.more.join(" | ")}` : ""}${x.notes ? `\n   notes: ${x.notes.slice(0, 200)}` : ""}`)].join("\n");
}
