import type { AgentTool } from "@kesher/agent";
import type { BrowserBridge } from "./browser-bridge.js";

/**
 * Fab from the chat, through KesherAI's own browser pane (Roee, 2026-11-17: "open a channel behind the scenes and mirror
 * its screen"). Fab has no public API; its site searches through its own JSON route, which answers a real browser.
 * The pane is one (a Chromium with the user's Fab sign-in), so the search runs inside a fab.com tab there and the
 * listing opens beside the chat. The user adds an asset to the library with Fab's own button; KesherAI never adds,
 * claims or buys.
 */

/** What fab_search takes. */
export interface FabQuery {
  query?: string;
  free?: boolean;
  /** unreal-engine, unity, uefn, … (Fab's channels). */
  engine?: string;
  /** 3d-model, material, sound, animation, … (Fab's listing types). */
  type?: string;
  sort?: "relevance" | "rating" | "newest" | "price";
  count?: number;
}

const SORT: Record<NonNullable<FabQuery["sort"]>, string> = { relevance: "-relevance", rating: "-ratings.averageRating", newest: "-firstPublishedAt", price: "price" };
const SLUG = /^[a-z0-9-]{1,40}$/;

/**
 * The path of Fab's own search for a query (only these keys; slugs checked).
 *
 * @returns e.g. /i/listings/search?q=rock&is_free=1&sort_by=-relevance&count=12
 */
export function fabSearchPath(q: FabQuery): string {
  const p = new URLSearchParams();
  const text = String(q.query ?? "").trim().slice(0, 120);
  if (text) p.set("q", text);
  if (q.free) p.set("is_free", "1");
  const engine = String(q.engine ?? "").toLowerCase().trim();
  if (SLUG.test(engine)) p.append("channels", engine);
  const type = String(q.type ?? "").toLowerCase().trim();
  if (SLUG.test(type)) p.append("listing_types", type);
  p.set("sort_by", SORT[q.sort ?? "relevance"] ?? SORT.relevance);
  p.set("count", String(Math.min(24, Math.max(1, Math.round(Number(q.count) || 12)))));
  return `/i/listings/search?${p.toString()}`;
}

/** A listing, short. */
export interface FabListing {
  uid: string;
  title: string;
  seller?: string;
  price?: string;
  free: boolean;
  rating?: string;
  type?: string;
  url: string;
}

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Reads Fab's search answer (unknown shape kept defensive: results / items / listings). */
export function fabListings(json: unknown): FabListing[] {
  const root = rec(json);
  const list = (root?.results ?? root?.items ?? root?.listings) as unknown;
  if (!Array.isArray(list)) return [];
  const out: FabListing[] = [];
  for (const item of list) {
    const r = rec(item);
    const uid = str(r?.uid) ?? str(r?.id);
    const title = str(r?.title) ?? str(r?.name);
    if (!r || !uid || !/^[\w-]{4,80}$/.test(uid) || !title) continue;
    const seller = rec(r.user) ?? rec(r.seller);
    const priceRec = rec(r.startingPrice) ?? rec(r.price);
    const amount = typeof priceRec?.price === "number" ? priceRec.price : typeof priceRec?.amount === "number" ? priceRec.amount : undefined;
    const currency = str(priceRec?.currencyCode) ?? "";
    const free = r.isFree === true || amount === 0;
    const ratings = rec(r.ratings) ?? rec(r.rating);
    const avg = typeof ratings?.averageRating === "number" ? ratings.averageRating : undefined;
    const total = typeof ratings?.total === "number" ? ratings.total : undefined;
    out.push({
      uid,
      title: title.slice(0, 160),
      ...(str(seller?.sellerName) ?? str(seller?.name) ? { seller: (str(seller?.sellerName) ?? str(seller?.name))!.slice(0, 80) } : {}),
      ...(!free && amount !== undefined ? { price: `${amount} ${currency}`.trim() } : {}),
      free,
      ...(avg !== undefined ? { rating: `${avg.toFixed(1)}★${total ? ` (${total})` : ""}` } : {}),
      ...(str(r.listingType) ? { type: str(r.listingType)!.slice(0, 40) } : {}),
      url: `https://www.fab.com/listings/${uid}`,
    });
  }
  return out;
}

export const FAB_NOTE =
  "Fab (Epic's asset store): fab_search searches it inside KesherAI's own browser pane, where the user is signed in to Fab; fab_open shows a listing there beside the chat. Compare a few and say why each fits. Never click Add to library, Add to cart, Buy or Checkout and never claim anything: the user clicks Fab's button themselves. Once in their library, Unreal adds it to a project from Window → Fab.";

/**
 * The chat's Fab tools (only when KesherAI's own browser pane is there).
 *
 * @param b - The browser bridge.
 */
export function fabTools(b: BrowserBridge): AgentTool[] {
  return [
    {
      risk: "read",
      spec: {
        name: "fab_search",
        description: `Search Fab (Epic's store of assets for Unreal, Unity, UEFN) in KesherAI's browser pane: titles, sellers, prices, ratings and links. ${FAB_NOTE}`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            free: { type: "boolean", description: "Only free assets." },
            engine: { type: "string", description: "unreal-engine, unity, uefn, blender…" },
            type: { type: "string", description: "3d-model, material, sound, animation, game-template, tool-and-plugin…" },
            sort: { type: "string", enum: ["relevance", "rating", "newest", "price"] },
            count: { type: "number", description: "1–24, default 12." },
          },
          required: ["query"],
        },
      },
      async run(input, ctx) {
        if (!b.status().pane) return { output: "Fab needs KesherAI's own browser pane (the desktop app)." };
        const r = await b.call<{ status: number; json?: unknown }>("fab-search", { path: fabSearchPath(input as FabQuery) }, ctx.signal);
        if (r.status === 403 || r.status === 429) return { output: `Fab did not answer the search (${r.status}). Open the Browser pane beside the chat, load fab.com once (and pass its check if it shows one), then try again.` };
        if (r.status !== 200) return { output: `Fab answered ${r.status}; its search may have changed.` };
        const list = fabListings(r.json);
        if (!list.length) return { output: "Nothing found on Fab for that." };
        return { output: list.map((l) => `${l.title}${l.seller ? ` · ${l.seller}` : ""} · ${l.free ? "free" : l.price ?? "paid"}${l.rating ? ` · ${l.rating}` : ""}${l.type ? ` · ${l.type}` : ""}\n  ${l.url} (uid ${l.uid})`).join("\n") };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "fab_open",
        description: "Show a Fab listing in KesherAI's browser pane beside the chat (by its uid from fab_search). Returns the page's text.",
        inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"] },
      },
      preview: async (input) => `Open the Fab listing ${String(input.uid)} in the browser pane`,
      scopeOf: async () => "site:fab.com",
      async run(input, ctx) {
        const uid = String(input.uid ?? "");
        if (!/^[\w-]{4,80}$/.test(uid)) throw new Error("A uid from fab_search.");
        const page = await b.call<{ title?: string; text?: string }>("open", { url: `https://www.fab.com/listings/${uid}` }, ctx.signal);
        return { output: `${page.title ?? ""}\n\n${String(page.text ?? "").slice(0, 6000)}\n\n(Shown in the Browser pane. The user adds it to the library with Fab's own button.)` };
      },
    },
  ];
}
