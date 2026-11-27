/**
 * Travel search: shared shapes. Search only, KesherAI never books or pays (docs/WORK_LIST.md, "Travel skill").
 * Prices come from the providers in their own currency; `ils` is filled in from the Bank of Israel's daily rate.
 */

/** The cabins a search may ask for. */
export type Cabin = "economy" | "premium_economy" | "business" | "first";

/** A flight search. Airports are 3-letter IATA codes ("TLV", "FCO"); dates are "YYYY-MM-DD". */
export interface FlightQuery {
  from: string;
  to: string;
  depart: string;
  return?: string;
  adults: number;
  cabin: Cabin;
}

/** A stay search. `city` is a name ("Rome") or a 3-letter IATA city code ("ROM"). */
export interface StayQuery {
  city: string;
  checkin: string;
  checkout: string;
  guests: number;
}

/** One direction of a trip. */
export interface Leg {
  /** Local ISO time ("2027-03-12T06:10:00"). */
  departAt: string;
  arriveAt: string;
  /** Connections (0 = direct). */
  stops: number;
  /** Flying time in minutes, when the provider says. */
  minutes?: number;
}

/** A flight offer as a provider gives it, with the price converted to shekels when a rate is known. */
export interface FlightOffer {
  provider: ProviderId;
  id: string;
  /** IATA airline code ("LY"). */
  airline: string;
  airlineName: string;
  /** El Al, Israir or Arkia (flagged ★ in the results). */
  israeli: boolean;
  /** The price in the provider's currency, for all passengers. */
  price: number;
  currency: string;
  /** The same price in shekels (Bank of Israel rate), when known. */
  ils?: number;
  out: Leg;
  back?: Leg;
}

/** A stay offer (one hotel, total price for the whole stay). */
export interface StayOffer {
  provider: ProviderId;
  id: string;
  name: string;
  price: number;
  currency: string;
  ils?: number;
  nights: number;
}

/** The providers KesherAI can ask, each with the user's own key. */
export type ProviderId = "amadeus" | "duffel";

/** The minimal response a fetch gives (what `fetch` returns, narrowed so tests can fake it without a network). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The request options the adapters use. */
export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** `fetch`, or a fake in tests. */
export type HttpFetch = (url: string, init?: HttpInit) => Promise<HttpResponse>;

/** One provider behind the one interface. */
export interface TravelProvider {
  id: ProviderId;
  /** Name for people ("Amadeus"). */
  label: string;
  searchFlights(q: FlightQuery, signal?: AbortSignal): Promise<FlightOffer[]>;
  searchStays(q: StayQuery, signal?: AbortSignal): Promise<StayOffer[]>;
}

/** Why a search could not run or finish. `message` is safe to show: it never holds a key. */
export class TravelError extends Error {
  /**
   * @param code - What kind of problem.
   * @param message - What to tell the user.
   */
  constructor(
    public readonly code: "no-key" | "bad-input" | "unsupported" | "http",
    message: string,
  ) {
    super(message);
    this.name = "TravelError";
  }
}

/** Parses an ISO-8601 duration ("PT5H30M", "P1DT2H") to minutes. @returns Minutes, or undefined when it is not one. */
export function isoMinutes(d: unknown): number | undefined {
  const m = typeof d === "string" ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d) : null;
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** @returns The value as an object, or an empty one (for reading provider JSON without trusting it). */
export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** @returns The value as an array, or an empty one. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** @returns The value as a string, or "". */
export function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** The nights between two "YYYY-MM-DD" dates. */
export function nightsBetween(checkin: string, checkout: string): number {
  return Math.max(1, Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000));
}
