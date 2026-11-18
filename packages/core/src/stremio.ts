import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stremioEmail, stremioLibrary, stremioLogin, stremioLogout, traktApp, traktLibrary, traktPoll, traktStart, type TraktApp, type TraktDevice } from "./stremio-history.js";

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
  from: "letterboxd" | "kesher" | "mal" | "stremio" | "trakt";
  /** An anime (from MyAnimeList): its own row in Stremio. */
  anime?: boolean;
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
  picks: { movie: Pick[]; series: Pick[]; anime?: Pick[]; t?: number };
  /** Her MyAnimeList API client id (to read her public list by name), kept on this computer only. */
  malClientId?: string;
  /** Signed in to Stremio: the session key (never the password), and the last sync. */
  stremio?: { email: string; authKey: string; synced?: number; count?: number };
  /** Trakt: her app's keys, the access token once she approved, a sign-in waiting for approval, and the last sync. */
  trakt?: { app: TraktApp; token?: string; device?: TraktDevice & { at: number }; synced?: number; count?: number };
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

const xmlText = (block: string, tag: string) => {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(block);
  return (m?.[1] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").trim();
};

/**
 * Reads a MyAnimeList export (Profile → Export → the .xml inside the .gz): each anime she watched, dropped or is
 * watching, with her score (out of 10, as 0.5–5 stars). "Plan to watch" is left out (not seen yet).
 *
 * @param xml - The file's text.
 */
export function parseMalXml(xml: string): Rated[] {
  const out: Rated[] = [];
  for (const m of xml.matchAll(/<anime>([\s\S]*?)<\/anime>/g)) {
    const b = m[1]!;
    const title = xmlText(b, "series_title").slice(0, 200);
    const status = xmlText(b, "my_status").toLowerCase();
    if (!title || status.startsWith("plan")) continue;
    const score = Number(xmlText(b, "my_score"));
    out.push({ title, ...(score > 0 && score <= 10 ? { rating: Math.round(score) / 2 } : {}), kind: /movie/i.test(xmlText(b, "series_type")) ? "movie" : "series", from: "mal", anime: true });
    if (out.length >= 5000) break;
  }
  return out;
}

/** One page of MyAnimeList's API list (users/{name}/animelist), as her ratings. */
export function malApiItems(j: unknown): Rated[] {
  const data = (j as { data?: Array<{ node?: { title?: string; media_type?: string; start_season?: { year?: number }; alternative_titles?: { en?: string } }; list_status?: { status?: string; score?: number } }> })?.data ?? [];
  return data.flatMap((d): Rated[] => {
    const n = d.node ?? {};
    const title = String(n.alternative_titles?.en || n.title || "").trim().slice(0, 200);
    if (!title || String(d.list_status?.status ?? "").startsWith("plan")) return [];
    const score = Number(d.list_status?.score ?? 0);
    const year = Number(n.start_season?.year ?? 0);
    return [{ title, ...(year > 1900 && year < 2100 ? { year } : {}), ...(score > 0 && score <= 10 ? { rating: Math.round(score) / 2 } : {}), kind: n.media_type === "movie" ? "movie" : "series", from: "mal", anime: true }];
  });
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
  const line = (r: Rated) => `${r.title}${r.year ? ` (${r.year})` : ""}${r.anime ? " [anime]" : ""}${r.rating ? ` ${r.rating}★` : ""}`;
  return `Loved:\n${loved.map(line).join("\n") || "(none rated)"}\n\nDisliked:\n${disliked.map(line).join("\n") || "(none)"}\n\nAlready seen (do not recommend): ${seen.join("; ")}`;
}

/** Added to the prompt when her taste has anime (MyAnimeList). */
export const ANIME_PROMPT =
  'Also add "anime": 10 anime she has not seen, close to the anime she loved (series or films), each {"title":"its English title as on IMDb","year":2019,"type":"series" or "movie","why":"..."}.';

export const RECOMMEND_PROMPT =
  'You recommend films and series to one person from their own ratings. Recommend titles they have not seen, close to what they loved and far from what they disliked; mix well-known and less-known titles. Answer with JSON only: {"movies":[{"title":"exact original title","year":2014,"why":"one short line"}],"series":[{"title":"...","year":2016,"why":"..."}]} with 12 movies and 8 series.';

/** The Stremio addon's manifest. */
export const STREMIO_MANIFEST = {
  id: "ai.kesher.foryou",
  version: "1.0.0",
  name: "KesherAI: for you",
  description: "Films, series and anime picked by KesherAI from your own ratings (Letterboxd, MyAnimeList and KesherAI).",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "kesher-for-you", name: "KesherAI: for you" },
    { type: "series", id: "kesher-for-you", name: "KesherAI: for you" },
    { type: "series", id: "kesher-anime", name: "KesherAI: anime for you" },
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
      return {
        rated: Array.isArray(j.rated) ? j.rated : [],
        picks: { movie: j.picks?.movie ?? [], series: j.picks?.series ?? [], anime: j.picks?.anime ?? [], ...(j.picks?.t ? { t: j.picks.t } : {}) },
        ...(typeof j.malClientId === "string" ? { malClientId: j.malClientId } : {}),
        ...(j.stremio?.authKey ? { stremio: j.stremio } : {}),
        ...(j.trakt?.app ? { trakt: j.trakt } : {}),
      };
    } catch {
      return { rated: [], picks: { movie: [], series: [] } };
    }
  }

  private async save(s: Store): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(), JSON.stringify(s), { mode: 0o600 });
  }

  /** Adds a Letterboxd export (films already there are updated, not doubled). */
  importLetterboxd(csv: string): Promise<{ added: number; total: number }> {
    return this.add(parseLetterboxd(csv));
  }

  /** Adds a MyAnimeList export (the .xml). */
  importMal(xml: string): Promise<{ added: number; total: number }> {
    const list = parseMalXml(xml);
    if (!list.length) throw Object.assign(new Error("No anime were found in this file (MyAnimeList: Profile → Export → My Anime List, the .xml inside)."), { statusCode: 400 });
    return this.add(list);
  }

  /**
   * Adds her public MyAnimeList list by user name, through MyAnimeList's API with her own client id (made once at
   * myanimelist.net/apiconfig; kept on this computer).
   */
  async importMalUser(user: string, clientId?: string): Promise<{ added: number; total: number }> {
    const name = user.trim();
    if (!/^[\w-]{2,32}$/.test(name)) throw Object.assign(new Error("A MyAnimeList user name has 2–32 letters, digits, _ or -."), { statusCode: 400 });
    const s = await this.load();
    const id = (clientId ?? "").trim() || s.malClientId;
    if (!id || !/^[0-9a-f]{20,64}$/i.test(id)) throw Object.assign(new Error("Add your MyAnimeList client id first (myanimelist.net/apiconfig → Create ID)."), { statusCode: 400 });
    if (clientId && clientId.trim() !== s.malClientId) {
      s.malClientId = clientId.trim();
      await this.save(s);
    }
    const all: Rated[] = [];
    let url: string | undefined = `https://api.myanimelist.net/v2/users/${encodeURIComponent(name)}/animelist?fields=list_status,media_type,start_season,alternative_titles&limit=1000&nsfw=true`;
    for (let page = 0; url && page < 10; page++) {
      const res = await this.fetcher(url, { headers: { "X-MAL-CLIENT-ID": id }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 403 || res.status === 404) throw Object.assign(new Error("MyAnimeList did not show this list: check the name, and that the list is public."), { statusCode: 400 });
      if (!res.ok) throw Object.assign(new Error(`MyAnimeList answered ${res.status}.`), { statusCode: 502 });
      const j = (await res.json()) as { paging?: { next?: string } };
      all.push(...malApiItems(j));
      // Only MyAnimeList's own next page.
      url = typeof j.paging?.next === "string" && j.paging.next.startsWith("https://api.myanimelist.net/v2/") ? j.paging.next : undefined;
    }
    return this.add(all);
  }

  /** Adds ratings (titles already there are updated, not doubled). */
  private async add(list: Rated[]): Promise<{ added: number; total: number }> {
    const s = await this.load();
    const key = (r: Rated) => `${r.title.toLowerCase()}|${r.year ?? ""}`;
    const have = new Map(s.rated.map((r) => [key(r), r]));
    let added = 0;
    const byTitle = new Map(s.rated.map((r) => [r.title.toLowerCase(), r]));
    for (const r of list) {
      // Stremio's library has no years: the same title already there (from Letterboxd, with its year) is the same film.
      const old = have.get(key(r)) ?? (r.year === undefined ? byTitle.get(r.title.toLowerCase()) : undefined);
      if (old) {
        if (r.rating !== undefined) old.rating = r.rating;
      } else {
        have.set(key(r), r);
        byTitle.set(r.title.toLowerCase(), r);
        added++;
      }
    }
    s.rated = [...have.values()];
    await this.save(s);
    return { added, total: s.rated.length };
  }

  /**
   * Signs in to Stremio (the password goes only to Stremio and is not kept) and reads her library once.
   *
   * @param email - Her Stremio email.
   * @param password - Her Stremio password.
   * @returns What was added.
   */
  async stremioConnect(email: string, password: string): Promise<{ added: number; total: number }> {
    const authKey = await stremioLogin(this.fetcher, email, password);
    const s = await this.load();
    s.stremio = { email: email.trim(), authKey };
    await this.save(s);
    return this.stremioSync();
  }

  /**
   * Uses a session key read from Stremio's own sign-in page (she signed in there; KesherAI never saw a password), and
   * reads her library once.
   *
   * @param authKey - The session key from web.stremio.com.
   * @returns What was added.
   */
  async stremioConnectKey(authKey: string): Promise<{ added: number; total: number }> {
    if (!/^[\w-]{10,200}$/.test(authKey)) throw Object.assign(new Error("Stremio gave no session."), { statusCode: 400 });
    const email = await stremioEmail(this.fetcher, authKey);
    const s = await this.load();
    s.stremio = { email, authKey };
    await this.save(s);
    return this.stremioSync();
  }

  /** Reads her Stremio library again (watched films and series). */
  async stremioSync(): Promise<{ added: number; total: number }> {
    const s = await this.load();
    if (!s.stremio) throw Object.assign(new Error("Sign in to Stremio first."), { statusCode: 400 });
    const list = await stremioLibrary(this.fetcher, s.stremio.authKey);
    const r = await this.add(list);
    const after = await this.load();
    if (after.stremio) after.stremio = { ...after.stremio, synced: Date.now(), count: list.length };
    await this.save(after);
    return r;
  }

  /** Signs out of Stremio (at Stremio too) and forgets the session; what was read stays. */
  async stremioDisconnect(): Promise<void> {
    const s = await this.load();
    if (s.stremio) await stremioLogout(this.fetcher, s.stremio.authKey);
    delete s.stremio;
    await this.save(s);
  }

  /**
   * Starts the Trakt sign-in with her app's keys: the code to type at trakt.tv/activate.
   *
   * @param app - The Client ID and Secret as she pasted them (or none: the ones kept).
   * @returns The code and the address.
   */
  async traktBegin(app?: { clientId?: unknown; clientSecret?: unknown }): Promise<{ userCode: string; url: string; expiresIn: number }> {
    const s = await this.load();
    const keys = app && (app.clientId || app.clientSecret) ? traktApp(app) : s.trakt?.app;
    if (!keys) throw Object.assign(new Error("Paste your Trakt app's Client ID and Client Secret first."), { statusCode: 400 });
    const d = await traktStart(this.fetcher, keys);
    s.trakt = { ...s.trakt, app: keys, device: { ...d, at: Date.now() } };
    delete s.trakt.token;
    await this.save(s);
    return { userCode: d.userCode, url: d.url, expiresIn: d.expiresIn };
  }

  /** Asks Trakt once whether she approved; on yes, reads her history and ratings. */
  async traktCheck(): Promise<{ state: "wait" | "gone" | "connected"; added?: number; total?: number }> {
    const s = await this.load();
    const d = s.trakt?.device;
    if (!s.trakt || !d) return { state: s.trakt?.token ? "connected" : "gone" };
    if (Date.now() > d.at + d.expiresIn * 1000) {
      delete s.trakt.device;
      await this.save(s);
      return { state: "gone" };
    }
    const r = await traktPoll(this.fetcher, s.trakt.app, d.deviceCode);
    if (r === "wait") return { state: "wait" };
    delete s.trakt.device;
    if (r === "gone") {
      await this.save(s);
      return { state: "gone" };
    }
    s.trakt.token = r.token;
    await this.save(s);
    return { state: "connected", ...(await this.traktSync()) };
  }

  /** Reads her Trakt history and ratings again. */
  async traktSync(): Promise<{ added: number; total: number }> {
    const s = await this.load();
    if (!s.trakt?.token) throw Object.assign(new Error("Connect Trakt first."), { statusCode: 400 });
    const list = await traktLibrary(this.fetcher, s.trakt.app, s.trakt.token);
    const r = await this.add(list);
    const after = await this.load();
    if (after.trakt) after.trakt = { ...after.trakt, synced: Date.now(), count: list.length };
    await this.save(after);
    return r;
  }

  /** Forgets Trakt (the app keys and the token); what was read stays. */
  async traktDisconnect(): Promise<void> {
    const s = await this.load();
    delete s.trakt;
    await this.save(s);
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
    const anime = s.rated.some((r) => r.anime);
    const raw = await ask(anime ? `${RECOMMEND_PROMPT} ${ANIME_PROMPT}` : RECOMMEND_PROMPT, tasteSummary(s.rated));
    const j = jsonObject(raw) as { movies?: Array<{ title?: string; year?: number; why?: string }>; series?: Array<{ title?: string; year?: number; why?: string }>; anime?: Array<{ title?: string; year?: number; why?: string; type?: string }> } | undefined;
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
    // Anime: each matched as the series or film the model says it is.
    const animeList = j?.anime ?? [];
    const animePicks = anime ? [...(await match("series", animeList.filter((x) => x?.type !== "movie"))), ...(await match("movie", animeList.filter((x) => x?.type === "movie")))] : [];
    s.picks = { movie: await match("movie", j?.movies), series: await match("series", j?.series), anime: animePicks, t: Date.now() };
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
