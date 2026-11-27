import { amadeus } from "./amadeus.js";
import { duffel } from "./duffel.js";
import { IlsRates } from "./ils.js";
import { TravelError, type Cabin, type FlightOffer, type FlightQuery, type HttpFetch, type StayOffer, type StayQuery, type TravelProvider } from "./types.js";

/** The user's travel settings (the `travel` part of the config; keys are sealed on disk, see config.ts). */
export interface TravelSettings {
  amadeusKey?: string | undefined;
  amadeusSecret?: string | undefined;
  amadeusHost: "test" | "production";
  duffelToken?: string | undefined;
  /** Default departure airport. */
  origin: string;
  /** Hours between polls of a price watch. */
  everyHours: number;
  /** A drop of this share (percent) alerts the phone. */
  dropPercent: number;
  /** ...or a drop of this many shekels. */
  dropShekel: number;
}

/** What a search gives. */
export interface SearchResult<T> {
  offers: T[];
  /** Which providers answered. */
  used: string[];
  /** Problems per provider ("Amadeus: …"), safe to show. */
  errors: string[];
  /** No key is set at all. */
  noKey: boolean;
  /** The bank's table day, when a rate was used. */
  rateDate?: string;
  /** The rate came from an older table (the bank was not reachable). */
  rateStale?: boolean;
  /** The test host was used (sample data, not real fares). */
  test: boolean;
}

/** The line shown when no key is set. */
export const NO_KEY_TEXT = "Travel search needs a free key: add one in Settings › Travel (Amadeus Self-Service or Duffel).";

const CABINS: readonly Cabin[] = ["economy", "premium_economy", "business", "first"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @returns Today as "YYYY-MM-DD" (local). */
function today(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Checks and cleans a flight query (airports as IATA codes, real dates in the right order, 1-9 adults).
 *
 * @param raw - What the model or a watch gave.
 * @param origin - The default departure airport.
 * @param now - The time, ms.
 * @returns The query.
 * @throws TravelError "bad-input" with what to fix.
 */
export function cleanFlightQuery(raw: Record<string, unknown>, origin: string, now: number = Date.now()): FlightQuery {
  const code = (v: unknown, name: string, dflt?: string): string => {
    const s = String(v ?? dflt ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) throw new TravelError("bad-input", `${name} must be a 3-letter airport code (e.g. TLV, FCO), got "${s.slice(0, 20)}".`);
    return s;
  };
  const date = (v: unknown, name: string): string => {
    const s = String(v ?? "").trim();
    if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new TravelError("bad-input", `${name} must be a date like 2027-03-12.`);
    return s;
  };
  const from = code(raw.from, "from", origin);
  const to = code(raw.to, "to");
  if (from === to) throw new TravelError("bad-input", "from and to are the same airport.");
  const depart = date(raw.depart, "depart");
  if (depart < today(now)) throw new TravelError("bad-input", "depart is in the past.");
  const ret = raw.return === undefined || raw.return === null || raw.return === "" ? undefined : date(raw.return, "return");
  if (ret && ret < depart) throw new TravelError("bad-input", "return is before depart.");
  const adults = Math.floor(Number(raw.adults ?? 1));
  if (!(adults >= 1 && adults <= 9)) throw new TravelError("bad-input", "adults must be 1 to 9.");
  const cabin = String(raw.cabin ?? "economy").toLowerCase() as Cabin;
  if (!CABINS.includes(cabin)) throw new TravelError("bad-input", `cabin must be one of ${CABINS.join(", ")}.`);
  return { from, to, depart, ...(ret ? { return: ret } : {}), adults, cabin };
}

/**
 * Checks and cleans a stay query.
 *
 * @param raw - What the model or a watch gave.
 * @param now - The time, ms.
 * @returns The query.
 * @throws TravelError "bad-input".
 */
export function cleanStayQuery(raw: Record<string, unknown>, now: number = Date.now()): StayQuery {
  const city = String(raw.city ?? "").trim().slice(0, 60);
  if (!city || /[<>{}]/.test(city)) throw new TravelError("bad-input", "city is missing (a name like Rome or a code like ROM).");
  const date = (v: unknown, name: string): string => {
    const s = String(v ?? "").trim();
    if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new TravelError("bad-input", `${name} must be a date like 2027-03-12.`);
    return s;
  };
  const checkin = date(raw.checkin, "checkin");
  const checkout = date(raw.checkout, "checkout");
  if (checkin < today(now)) throw new TravelError("bad-input", "checkin is in the past.");
  if (checkout <= checkin) throw new TravelError("bad-input", "checkout must be after checkin.");
  const guests = Math.floor(Number(raw.guests ?? 2));
  if (!(guests >= 1 && guests <= 9)) throw new TravelError("bad-input", "guests must be 1 to 9.");
  return { city, checkin, checkout, guests };
}

/** Asks the providers the user has keys for and converts prices to shekels. */
export class TravelService {
  /**
   * @param settings - The current settings (read on every call, so a changed key applies at once).
   * @param http - `fetch` (a fake in tests).
   * @param rates - The shekel rates.
   */
  constructor(
    readonly settings: () => TravelSettings,
    private readonly http: HttpFetch,
    readonly rates: IlsRates,
  ) {}

  /** @returns The providers with a key, in order (Amadeus first). */
  providers(): TravelProvider[] {
    const s = this.settings();
    const out: TravelProvider[] = [];
    if (s.amadeusKey && s.amadeusSecret) out.push(amadeus({ key: s.amadeusKey, secret: s.amadeusSecret, host: s.amadeusHost, http: this.http }));
    if (s.duffelToken) out.push(duffel({ token: s.duffelToken, http: this.http }));
    return out;
  }

  /**
   * Flights from every provider that has a key, cheapest first, with shekel prices.
   *
   * @param q - A checked query.
   * @param signal - To cancel.
   */
  async searchFlights(q: FlightQuery, signal?: AbortSignal): Promise<SearchResult<FlightOffer>> {
    return this.run((p) => p.searchFlights(q, signal));
  }

  /**
   * Stays from every provider that supports them.
   *
   * @param q - A checked query.
   * @param signal - To cancel.
   */
  async searchStays(q: StayQuery, signal?: AbortSignal): Promise<SearchResult<StayOffer>> {
    return this.run((p) => p.searchStays(q, signal));
  }

  private async run<T extends FlightOffer | StayOffer>(ask: (p: TravelProvider) => Promise<T[]>): Promise<SearchResult<T>> {
    const ps = this.providers();
    const res: SearchResult<T> = { offers: [], used: [], errors: [], noKey: ps.length === 0, test: this.settings().amadeusHost === "test" && !!this.settings().amadeusKey };
    const settled = await Promise.allSettled(ps.map(ask));
    settled.forEach((r, i) => {
      const p = ps[i]!;
      if (r.status === "fulfilled") {
        res.used.push(p.label);
        res.offers.push(...r.value);
      } else {
        res.errors.push(r.reason instanceof TravelError ? r.reason.message : `${p.label}: the search failed.`);
      }
    });
    for (const o of res.offers) {
      const c = await this.rates.toIls(o.price, o.currency);
      if (c) {
        o.ils = c.ils;
        if (c.date) res.rateDate = c.date;
        if (c.stale) res.rateStale = true;
      }
    }
    // Cheapest first; an offer without a shekel price (unknown currency) goes last.
    res.offers.sort((a, b) => (a.ils ?? Infinity) - (b.ils ?? Infinity) || a.price - b.price);
    return res;
  }
}
