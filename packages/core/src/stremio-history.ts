/**
 * What she watched, for the Stremio taste (Roee chose both ways, 2026-11-18; Stremio gives addons no access to it):
 *
 * - **Stremio itself**: she signs in to Stremio inside KesherAI; the password goes only to Stremio's own API
 *   (api.strem.io, the one Stremio's apps use; unofficial) and is never kept. KesherAI keeps the session key it gets
 *   back, and reads her library (watched films and series, how many times, when). Signing out ends the session at
 *   Stremio and removes the key.
 * - **Trakt**: Stremio's official Trakt integration sends what she watches there; KesherAI signs in to Trakt with
 *   the device code (she approves on trakt.tv; no password here) and reads her watched films and shows and her
 *   ratings through Trakt's official API, with a Trakt app she makes once (client id and secret, kept here).
 */
import type { Rated } from "./stremio.js";

const STREMIO_API = "https://api.strem.io/api/";
const TRAKT_API = "https://api.trakt.tv";

/** A failure with the HTTP status the route should answer. */
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** One Stremio library item, as datastoreGet returns it (only what is read). */
interface StremioItem {
  name?: unknown;
  type?: unknown;
  removed?: unknown;
  temp?: unknown;
  state?: { timesWatched?: unknown; flaggedWatched?: unknown; overallTimeWatched?: unknown; timeWatched?: unknown; duration?: unknown; lastWatched?: unknown };
}

async function stremioCall<T>(fetcher: typeof fetch, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetcher(STREMIO_API + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw fail(`Stremio answered ${res.status}.`, 502);
  const j = (await res.json()) as { result?: T; error?: { message?: unknown } };
  if (j.error) throw fail(typeof j.error.message === "string" ? `Stremio: ${j.error.message.slice(0, 200)}` : "Stremio refused.", 400);
  if (j.result === undefined) throw fail("Stremio gave no answer.", 502);
  return j.result;
}

/**
 * Signs in to Stremio and returns the session key (the password is not kept).
 *
 * @param fetcher - fetch.
 * @param email - Her Stremio email.
 * @param password - Her Stremio password (sent only to Stremio).
 * @returns The session key.
 */
export async function stremioLogin(fetcher: typeof fetch, email: string, password: string): Promise<string> {
  const e = email.trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(e) || !password || password.length > 512) throw fail("Enter your Stremio email and password.", 400);
  const r = await stremioCall<{ authKey?: unknown }>(fetcher, "login", { type: "Login", email: e, password, facebook: false });
  if (typeof r.authKey !== "string" || !/^[\w-]{10,200}$/.test(r.authKey)) throw fail("Stremio gave no session.", 502);
  return r.authKey;
}

/**
 * The email of a Stremio session (to show which account is connected), or "Stremio" when it cannot be read.
 *
 * @param fetcher - fetch.
 * @param authKey - The session key.
 * @returns The account's email.
 */
export async function stremioEmail(fetcher: typeof fetch, authKey: string): Promise<string> {
  const r = await stremioCall<{ email?: unknown }>(fetcher, "getUser", { type: "GetUser", authKey }).catch(() => undefined);
  return typeof r?.email === "string" && r.email.length <= 254 ? r.email : "Stremio";
}

/**
 * Ends the Stremio session (best effort).
 *
 * @param fetcher - fetch.
 * @param authKey - The session key.
 */
export async function stremioLogout(fetcher: typeof fetch, authKey: string): Promise<void> {
  await stremioCall(fetcher, "logout", { type: "Logout", authKey }).catch(() => undefined);
}

/**
 * The watched films and series in a Stremio library: a film counts when marked watched, watched to the end once, or
 * mostly played; a series when any of it was played. Removed and temporary items are left out.
 *
 * @param items - datastoreGet's result.
 * @returns Them as "seen" entries (no rating: Stremio has none).
 */
export function stremioWatched(items: unknown): Rated[] {
  if (!Array.isArray(items)) return [];
  const out: Rated[] = [];
  for (const raw of items.slice(0, 20_000) as StremioItem[]) {
    if (!raw || typeof raw !== "object" || raw.removed === true || raw.temp === true) continue;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 200) : "";
    const kind = raw.type === "movie" ? "movie" : raw.type === "series" ? "series" : undefined;
    if (!name || !kind) continue;
    const st = raw.state ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const played = num(st.overallTimeWatched) || num(st.timeWatched);
    const watched = num(st.flaggedWatched) > 0 || num(st.timesWatched) > 0 || (kind === "movie" ? num(st.duration) > 0 && played / num(st.duration) >= 0.7 : played > 10 * 60_000);
    if (watched) out.push({ title: name, kind, from: "stremio" });
  }
  return out;
}

/**
 * Her Stremio library's watched items.
 *
 * @param fetcher - fetch.
 * @param authKey - The session key.
 * @returns The watched films and series.
 */
export async function stremioLibrary(fetcher: typeof fetch, authKey: string): Promise<Rated[]> {
  return stremioWatched(await stremioCall<unknown>(fetcher, "datastoreGet", { type: "DatastoreGet", authKey, collection: "libraryItem", ids: [], all: true }));
}

/** A Trakt app's keys (made once at trakt.tv/oauth/applications), kept on this computer. */
export interface TraktApp {
  clientId: string;
  clientSecret: string;
}

/** The device sign-in: the code she types at the address, and how to wait for it. */
export interface TraktDevice {
  deviceCode: string;
  userCode: string;
  url: string;
  interval: number;
  expiresIn: number;
}

const traktKey = /^[0-9a-f]{64}$/i;

/**
 * Checks a Trakt app's keys.
 *
 * @param app - The client id and secret as she pasted them.
 * @returns The trimmed keys.
 */
export function traktApp(app: { clientId?: unknown; clientSecret?: unknown }): TraktApp {
  const clientId = String(app.clientId ?? "").trim();
  const clientSecret = String(app.clientSecret ?? "").trim();
  if (!traktKey.test(clientId) || !traktKey.test(clientSecret)) throw fail("Paste the Trakt app's Client ID and Client Secret (64 letters and digits each).", 400);
  return { clientId, clientSecret };
}

async function traktPost<T>(fetcher: typeof fetch, path: string, body: Record<string, unknown>): Promise<{ status: number; json?: T }> {
  const res = await fetcher(TRAKT_API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20_000) });
  return { status: res.status, ...(res.ok ? { json: (await res.json()) as T } : {}) };
}

/**
 * Starts the device sign-in.
 *
 * @param fetcher - fetch.
 * @param app - The Trakt app.
 * @returns The code to show and the address (trakt.tv's own).
 */
export async function traktStart(fetcher: typeof fetch, app: TraktApp): Promise<TraktDevice> {
  const r = await traktPost<{ device_code?: string; user_code?: string; verification_url?: string; interval?: number; expires_in?: number }>(fetcher, "/oauth/device/code", { client_id: app.clientId });
  const j = r.json;
  if (!j?.device_code || !j.user_code) throw fail(r.status === 401 || r.status === 403 ? "Trakt did not accept this Client ID." : `Trakt answered ${r.status}.`, 400);
  const url = typeof j.verification_url === "string" && /^https:\/\/trakt\.tv\//.test(j.verification_url) ? j.verification_url : "https://trakt.tv/activate";
  return { deviceCode: j.device_code, userCode: String(j.user_code).slice(0, 16), url, interval: Math.min(30, Math.max(5, Number(j.interval) || 5)), expiresIn: Math.min(1800, Number(j.expires_in) || 600) };
}

/**
 * Asks once whether she approved the code.
 *
 * @param fetcher - fetch.
 * @param app - The Trakt app.
 * @param deviceCode - From {@link traktStart}.
 * @returns The access token, "wait" while she has not approved yet, or "gone" when the code ended or was denied.
 */
export async function traktPoll(fetcher: typeof fetch, app: TraktApp, deviceCode: string): Promise<{ token: string } | "wait" | "gone"> {
  const r = await traktPost<{ access_token?: string }>(fetcher, "/oauth/device/token", { code: deviceCode, client_id: app.clientId, client_secret: app.clientSecret });
  if (r.json?.access_token && /^[\w.-]{10,400}$/.test(r.json.access_token)) return { token: r.json.access_token };
  return r.status === 400 || r.status === 429 ? "wait" : "gone";
}

interface TraktItem {
  movie?: { title?: unknown; year?: unknown };
  show?: { title?: unknown; year?: unknown };
  rating?: unknown;
  type?: unknown;
}

/**
 * Trakt's watched films and shows and her ratings (1–10 → 0.5–5 stars) as "seen" and rated entries.
 *
 * @param watched - /sync/watched/movies and /sync/watched/shows together.
 * @param ratings - /sync/ratings.
 * @returns The entries.
 */
export function traktEntries(watched: unknown, ratings: unknown): Rated[] {
  const out = new Map<string, Rated>();
  const put = (x: TraktItem, rating?: number) => {
    const m = x.movie ?? x.show;
    const title = typeof m?.title === "string" ? m.title.trim().slice(0, 200) : "";
    if (!title) return;
    const year = typeof m?.year === "number" && m.year > 1870 && m.year < 2200 ? m.year : undefined;
    const kind = x.movie ? "movie" : "series";
    const k = `${title.toLowerCase()}|${year ?? ""}`;
    const r: Rated = { title, kind, from: "trakt", ...(year ? { year } : {}), ...(rating ? { rating } : {}) };
    out.set(k, { ...out.get(k), ...r });
  };
  for (const x of (Array.isArray(watched) ? watched : []).slice(0, 20_000) as TraktItem[]) if (x && typeof x === "object") put(x);
  for (const x of (Array.isArray(ratings) ? ratings : []).slice(0, 20_000) as TraktItem[]) {
    if (!x || typeof x !== "object" || (x.type !== "movie" && x.type !== "show")) continue;
    const n = typeof x.rating === "number" && x.rating >= 1 && x.rating <= 10 ? Math.round(x.rating) / 2 : undefined;
    put(x, n);
  }
  return [...out.values()];
}

/**
 * Reads her Trakt history and ratings.
 *
 * @param fetcher - fetch.
 * @param app - The Trakt app.
 * @param token - Her access token.
 * @returns The entries.
 */
export async function traktLibrary(fetcher: typeof fetch, app: TraktApp, token: string): Promise<Rated[]> {
  const get = async (path: string) => {
    const res = await fetcher(TRAKT_API + path, { headers: { "content-type": "application/json", "trakt-api-version": "2", "trakt-api-key": app.clientId, authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) throw fail("Trakt signed you out. Connect it again.", 401);
    if (!res.ok) throw fail(`Trakt answered ${res.status}.`, 502);
    return res.json() as Promise<unknown>;
  };
  const [movies, shows, ratings] = await Promise.all([get("/sync/watched/movies"), get("/sync/watched/shows?extended=noseasons"), get("/sync/ratings")]);
  return traktEntries([...(Array.isArray(movies) ? movies : []), ...(Array.isArray(shows) ? shows : [])], ratings);
}
