import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Movies and series for the user's taste, as a Stremio addon (Roee, 2026-11-16).
 *
 * Taste comes from what the user gives KesherAI: a Letterboxd export (ratings.csv / watched.csv), and ratings made
 * in KesherAI. KesherAI writes the recommendations with the chat model; each title is matched to Stremio's own
 * catalogue (Cinemeta) for its id and poster, and Stremio shows them as a "KesherAI: for you" row once the addon is
 * installed (its address holds one of KesherAI's app keys, revocable in Settings). Nothing is sent anywhere but
 * Cinemeta's search (titles only).
 */

/** A film or series she rated (or only watched). */
export interface Rated {
  title: string;
  year?: number;
  /** 0.5–5 stars. */
  rating?: number;
  kind?: "movie" | "series";
  from: "letterboxd" | "kesher";
}

/** A recommendation, matched on Stremio's catalogue. */
export interface Pick {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  year?: string;
  /** Why it fits her taste, one line. */
  why?: string;
}

interface Store {
  rated: Rated[];
  picks: { movie: Pick[]; series: Pick[]; t?: number };
}

const CINEMETA = "https://v3-cinemeta.strem.io";

/**
 * Reads a Letterboxd export CSV (ratings.csv or watched.csv: Date,Name,Year,Letterboxd URI[,Rating]).
 *
 * @param csv - The file's text.
 * @returns The films in it.
 */
export function parseLetterboxd(csv: string): Rated[] {
  const rows = csvRows(csv);
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const at = (n: string) => head.indexOf(n);
  const [iName, iYear, iRating] = [at("name"), at("year"), at("rating")];
  if (iName < 0) return [];
  return rows
    .map((r): Rated | undefined => {
      const title = (r[iName] ?? "").trim().slice(0, 200);
      if (!title) return undefined;
      const year = Number(r[iYear] ?? "");
      const rating = Number(r[iRating] ?? "");
      return { title, ...(year > 1880 && year < 2100 ? { year } : {}), ...(rating > 0 && rating <= 5 ? { rating } : {}), kind: "movie", from: "letterboxd" };
    })
    .filter((x): x is Rated => !!x)
    .slice(0, 5000);
}

/** CSV rows with quoted fields ("a, b" and "" inside quotes). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/**
 * What the model gets: her best and worst rated, to write recommendations from.
 *
 * @param rated - Her ratings.
 */
export function tasteSummary(rated: Rated[]): string {
  const withRating = rated.filter((r) => r.rating !== undefined).sort((a, b) => b.rating! - a.rating!);
  const loved = withRating.filter((r) => r.rating! >= 4).slice(0, 60);
  const disliked = withRating.filter((r) => r.rating! <= 2).slice(0, 30);
  const seen = rated.slice(0, 300).map((r) => r.title);
  const line = (r: Rated) => `${r.title}${r.year ? ` (${r.year})` : ""}${r.rating ? ` ${r.rating}★` : ""}`;
  return `Loved:\n${loved.map(line).join("\n") || "(none rated)"}\n\nDisliked:\n${disliked.map(line).join("\n") || "(none)"}\n\nAlready seen (do not recommend): ${seen.join("; ")}`;
}

export const RECOMMEND_PROMPT =
  'You recommend films and series to one person from their own ratings. Recommend titles they have not seen, close to what they loved and far from what they disliked; mix well-known and less-known titles. Answer with JSON only: {"movies":[{"title":"exact original title","year":2014,"why":"one short line"}],"series":[{"title":"...","year":2016,"why":"..."}]} with 12 movies and 8 series.';

/** The Stremio addon's manifest. */
export const STREMIO_MANIFEST = {
  id: "ai.kesher.foryou",
  version: "1.0.0",
  name: "KesherAI: for you",
  description: "Films and series picked by KesherAI from your own ratings (Letterboxd and KesherAI).",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "kesher-for-you", name: "KesherAI: for you" },
    { type: "series", id: "kesher-for-you", name: "KesherAI: for you" },
  ],
  idPrefixes: ["tt"],
};

/** The user's taste and the latest picks, kept in KesherAI's data folder. */
export class StremioTaste {
  /**
   * @param dir - KesherAI's folder for it.
   * @param fetcher - fetch (replaceable in tests).
   */
  constructor(
    private readonly dir: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private file() {
    return join(this.dir, "stremio.json");
  }

  /** @returns Her ratings and the latest picks. */
  async load(): Promise<Store> {
    try {
      const j = JSON.parse(await readFile(this.file(), "utf8")) as Partial<Store>;
      return { rated: Array.isArray(j.rated) ? j.rated : [], picks: { movie: j.picks?.movie ?? [], series: j.picks?.series ?? [], ...(j.picks?.t ? { t: j.picks.t } : {}) } };
    } catch {
      return { rated: [], picks: { movie: [], series: [] } };
    }
  }

  private async save(s: Store): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(), JSON.stringify(s));
  }

  /** Adds a Letterboxd export (films already there are updated, not doubled). */
  async importLetterboxd(csv: string): Promise<{ added: number; total: number }> {
    const s = await this.load();
    const key = (r: Rated) => `${r.title.toLowerCase()}|${r.year ?? ""}`;
    const have = new Map(s.rated.map((r) => [key(r), r]));
    let added = 0;
    for (const r of parseLetterboxd(csv)) {
      const old = have.get(key(r));
      if (old) {
        if (r.rating !== undefined) old.rating = r.rating;
      } else {
        have.set(key(r), r);
        added++;
      }
    }
    s.rated = [...have.values()];
    await this.save(s);
    return { added, total: s.rated.length };
  }

  /** A rating made in KesherAI (0 removes it). */
  async rate(title: string, rating: number, kind: "movie" | "series" = "movie", year?: number): Promise<Rated[]> {
    const s = await this.load();
    const t = title.trim().slice(0, 200);
    if (!t) throw Object.assign(new Error("Which title?"), { statusCode: 400 });
    s.rated = s.rated.filter((r) => !(r.title.toLowerCase() === t.toLowerCase() && (year === undefined || r.year === year)));
    if (rating > 0) s.rated.unshift({ title: t, rating: Math.min(5, Math.max(0.5, Math.round(rating * 2) / 2)), kind, ...(year ? { year } : {}), from: "kesher" });
    await this.save(s);
    return s.rated;
  }

  /**
   * New recommendations: the model writes titles from her taste; each is matched on Cinemeta (Stremio's catalogue).
   *
   * @param ask - Asks the chat model (system, user) and returns its answer.
   */
  async refresh(ask: (system: string, user: string) => Promise<string>): Promise<Store["picks"]> {
    const s = await this.load();
    if (!s.rated.length) throw Object.assign(new Error("Add your Letterboxd export or rate a few titles first."), { statusCode: 400 });
    const raw = await ask(RECOMMEND_PROMPT, tasteSummary(s.rated));
    const j = jsonObject(raw) as { movies?: Array<{ title?: string; year?: number; why?: string }>; series?: Array<{ title?: string; year?: number; why?: string }> } | undefined;
    const seen = new Set(s.rated.map((r) => r.title.toLowerCase()));
    const match = async (type: "movie" | "series", list: Array<{ title?: string; year?: number; why?: string }> = []) => {
      const out: Pick[] = [];
      for (const x of list.slice(0, 15)) {
        const title = String(x?.title ?? "").trim();
        if (!title || seen.has(title.toLowerCase())) continue;
        const hit = await this.find(type, title, x.year).catch(() => undefined);
        // The reason as plain text (models write *titles* in markdown).
        const why = String(x.why ?? "").replace(/[*_`#]/g, "").trim().slice(0, 200);
        if (hit && !out.some((o) => o.id === hit.id)) out.push({ ...hit, ...(why ? { why } : {}) });
      }
      return out;
    };
    s.picks = { movie: await match("movie", j?.movies), series: await match("series", j?.series), t: Date.now() };
    await this.save(s);
    return s.picks;
  }

  /** Finds a title on Cinemeta: its IMDb id, poster and year (the closest year when one is given). */
  private async find(type: "movie" | "series", title: string, year?: number): Promise<Pick | undefined> {
    const res = await this.fetcher(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const metas = ((await res.json()) as { metas?: Array<{ id?: string; name?: string; poster?: string; releaseInfo?: string; year?: string }> }).metas ?? [];
    const ok = metas.filter((m) => typeof m.id === "string" && /^tt\d{5,10}$/.test(m.id) && m.name);
    const y = (m: { releaseInfo?: string; year?: string }) => Number(String(m.releaseInfo ?? m.year ?? "").slice(0, 4));
    const best = (year ? ok.sort((a, b) => Math.abs(y(a) - year) - Math.abs(y(b) - year)) : ok)[0];
    if (!best) return undefined;
    const poster = typeof best.poster === "string" && /^https:\/\//.test(best.poster) ? best.poster : undefined;
    return { id: best.id!, type, name: String(best.name).slice(0, 200), ...(poster ? { poster } : {}), ...(best.releaseInfo ? { year: String(best.releaseInfo).slice(0, 12) } : {}) };
  }
}

/** The first {...} object in a model's answer. */
function jsonObject(text: string): unknown {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return undefined;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return undefined;
  }
}
