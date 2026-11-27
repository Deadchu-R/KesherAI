import { airlineName, isIsraeli } from "./carriers.js";
import { arr, isoMinutes, nightsBetween, obj, str, TravelError, type FlightOffer, type FlightQuery, type HttpFetch, type Leg, type StayOffer, type StayQuery, type TravelProvider } from "./types.js";

/**
 * Amadeus Self-Service (https://developers.amadeus.com): the user's own free key. OAuth2 client credentials; the test
 * host gives sample data, the production host real fares. The key and secret are only sent to the Amadeus host and
 * never written to a log or an error message.
 */

/** The two hosts the user picks between in Settings › Travel. */
export const AMADEUS_HOSTS = { test: "https://test.api.amadeus.com", production: "https://api.amadeus.com" } as const;

/** What the adapter needs. */
export interface AmadeusOptions {
  key: string;
  secret: string;
  host: keyof typeof AMADEUS_HOSTS;
  http: HttpFetch;
  now?: () => number;
}

/** Amadeus's cabin names. */
const CABIN: Record<string, string> = { economy: "ECONOMY", premium_economy: "PREMIUM_ECONOMY", business: "BUSINESS", first: "FIRST" };

/**
 * The Amadeus adapter.
 *
 * @param o - Credentials, host and the fetch to use.
 * @returns A provider with `searchFlights` and `searchStays`.
 */
export function amadeus(o: AmadeusOptions): TravelProvider {
  const base = AMADEUS_HOSTS[o.host];
  const now = o.now ?? Date.now;
  let token: { value: string; until: number } | undefined;

  /** The bearer token, fetched with client credentials and kept until a minute before it ends. */
  async function bearer(signal?: AbortSignal): Promise<string> {
    if (token && token.until > now()) return token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: o.key, client_secret: o.secret }).toString();
    const res = await o.http(`${base}/v1/security/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, ...(signal ? { signal } : {}) });
    if (!res.ok) throw new TravelError("http", res.status === 401 ? "Amadeus refused the key or secret (check them in Settings › Travel, and that the host matches: test or production)." : `Amadeus sign-in failed (HTTP ${res.status}).`);
    const j = obj(await res.json());
    const value = str(j.access_token);
    if (!value) throw new TravelError("http", "Amadeus sign-in gave no token.");
    token = { value, until: now() + Math.max(60, Number(j.expires_in) || 1799) * 1000 - 60_000 };
    return value;
  }

  /** One authorised GET; the error carries Amadeus's own title, never the key. */
  async function get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    const res = await o.http(url, { headers: { Authorization: `Bearer ${await bearer(signal)}`, Accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (res.status === 401) token = undefined;
    if (!res.ok) {
      const err = obj(arr(obj(await res.json().catch(() => ({}))).errors)[0]);
      throw new TravelError("http", `Amadeus: ${str(err.title) || `HTTP ${res.status}`}${str(err.detail) ? ` (${str(err.detail).slice(0, 160)})` : ""}.`);
    }
    return obj(await res.json());
  }

  /** An IATA city code for a name ("Rome" -> "ROM"); a 3-letter input is used as it is. */
  async function cityCode(city: string, signal?: AbortSignal): Promise<string> {
    if (/^[A-Za-z]{3}$/.test(city.trim())) return city.trim().toUpperCase();
    const j = await get("/v1/reference-data/locations/cities", { keyword: city.trim().slice(0, 40), max: "1" }, signal);
    const code = str(obj(arr(j.data)[0]).iataCode);
    if (!code) throw new TravelError("bad-input", `Amadeus does not know a city called "${city}". Use its 3-letter code (e.g. ROM).`);
    return code;
  }

  /** One itinerary of an offer as a leg. */
  function leg(itin: unknown): Leg {
    const segs = arr(obj(itin).segments).map(obj);
    const first = obj(segs[0]?.departure);
    const last = obj(segs[segs.length - 1]?.arrival);
    const minutes = isoMinutes(obj(itin).duration);
    return { departAt: str(first.at), arriveAt: str(last.at), stops: Math.max(0, segs.length - 1), ...(minutes !== undefined ? { minutes } : {}) };
  }

  return {
    id: "amadeus",
    label: "Amadeus",
    async searchFlights(q: FlightQuery, signal?: AbortSignal): Promise<FlightOffer[]> {
      const params: Record<string, string> = { originLocationCode: q.from, destinationLocationCode: q.to, departureDate: q.depart, adults: String(q.adults), travelClass: CABIN[q.cabin] ?? "ECONOMY", max: "20" };
      if (q.return) params.returnDate = q.return;
      const j = await get("/v2/shopping/flight-offers", params, signal);
      const names = obj(obj(j.dictionaries).carriers);
      const out: FlightOffer[] = [];
      for (const raw of arr(j.data)) {
        const d = obj(raw);
        const itins = arr(d.itineraries);
        const price = Number(obj(d.price).grandTotal ?? obj(d.price).total);
        if (!itins.length || !(price > 0)) continue;
        const code = str(arr(d.validatingAirlineCodes)[0]) || str(obj(arr(obj(itins[0]).segments)[0]).carrierCode);
        out.push({
          provider: "amadeus",
          id: str(d.id),
          airline: code,
          airlineName: airlineName(code, str(names[code]) || undefined),
          israeli: isIsraeli(code),
          price,
          currency: str(obj(d.price).currency) || "EUR",
          out: leg(itins[0]),
          ...(itins[1] ? { back: leg(itins[1]) } : {}),
        });
      }
      return out;
    },
    async searchStays(q: StayQuery, signal?: AbortSignal): Promise<StayOffer[]> {
      const city = await cityCode(q.city, signal);
      const hotels = await get("/v1/reference-data/locations/hotels/by-city", { cityCode: city }, signal);
      const ids = arr(hotels.data).map((h) => str(obj(h).hotelId)).filter(Boolean).slice(0, 20);
      if (!ids.length) return [];
      const j = await get("/v3/shopping/hotel-offers", { hotelIds: ids.join(","), adults: String(q.guests), checkInDate: q.checkin, checkOutDate: q.checkout }, signal);
      const nights = nightsBetween(q.checkin, q.checkout);
      const out: StayOffer[] = [];
      for (const raw of arr(j.data)) {
        const d = obj(raw);
        const offer = obj(arr(d.offers)[0]);
        const price = Number(obj(offer.price).total);
        if (!(price > 0)) continue;
        out.push({ provider: "amadeus", id: str(obj(d.hotel).hotelId) || str(offer.id), name: str(obj(d.hotel).name) || str(obj(d.hotel).hotelId), price, currency: str(obj(offer.price).currency) || "EUR", nights });
      }
      return out;
    },
  };
}
