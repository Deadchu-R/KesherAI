import { airlineName, isIsraeli } from "./carriers.js";
import { arr, isoMinutes, obj, str, TravelError, type FlightOffer, type FlightQuery, type HttpFetch, type Leg, type StayOffer, type TravelProvider } from "./types.js";

/**
 * Duffel (https://duffel.com), search only: the user's own access token (a "test" token gives sample data). KesherAI
 * only creates an offer request and reads the offers; it never creates an order or pays. Duffel Stays needs map
 * coordinates, so stays are not offered through it yet.
 */

/** The API address. */
export const DUFFEL_URL = "https://api.duffel.com";

/**
 * The Duffel adapter.
 *
 * @param o - The token and the fetch to use.
 * @returns A provider; `searchStays` says it is not supported.
 */
export function duffel(o: { token: string; http: HttpFetch }): TravelProvider {
  /** One slice of an offer as a leg. */
  function leg(slice: unknown): Leg {
    const s = obj(slice);
    const segs = arr(s.segments).map(obj);
    const minutes = isoMinutes(s.duration);
    return { departAt: str(segs[0]?.departing_at), arriveAt: str(segs[segs.length - 1]?.arriving_at), stops: Math.max(0, segs.length - 1), ...(minutes !== undefined ? { minutes } : {}) };
  }

  return {
    id: "duffel",
    label: "Duffel",
    async searchFlights(q: FlightQuery, signal?: AbortSignal): Promise<FlightOffer[]> {
      const slices = [{ origin: q.from, destination: q.to, departure_date: q.depart }, ...(q.return ? [{ origin: q.to, destination: q.from, departure_date: q.return }] : [])];
      const body = JSON.stringify({ data: { slices, passengers: Array.from({ length: q.adults }, () => ({ type: "adult" })), cabin_class: q.cabin } });
      const res = await o.http(`${DUFFEL_URL}/air/offer_requests?return_offers=true&supplier_timeout=15000`, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.token}`, "Duffel-Version": "v2", "Content-Type": "application/json", Accept: "application/json" },
        body,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const err = obj(arr(obj(await res.json().catch(() => ({}))).errors)[0]);
        throw new TravelError("http", res.status === 401 ? "Duffel refused the token (check it in Settings › Travel)." : `Duffel: ${str(err.title) || `HTTP ${res.status}`}${str(err.message) ? ` (${str(err.message).slice(0, 160)})` : ""}.`);
      }
      const offers = arr(obj(obj(await res.json()).data).offers);
      const out: FlightOffer[] = [];
      for (const raw of offers) {
        const d = obj(raw);
        const slicesOut = arr(d.slices);
        const price = Number(d.total_amount);
        if (!slicesOut.length || !(price > 0)) continue;
        const owner = obj(d.owner);
        const code = str(owner.iata_code);
        out.push({
          provider: "duffel",
          id: str(d.id),
          airline: code,
          airlineName: airlineName(code, str(owner.name) || undefined),
          israeli: isIsraeli(code),
          price,
          currency: str(d.total_currency) || "USD",
          out: leg(slicesOut[0]),
          ...(slicesOut[1] ? { back: leg(slicesOut[1]) } : {}),
        });
      }
      return out.sort((a, b) => a.price - b.price).slice(0, 20);
    },
    async searchStays(): Promise<StayOffer[]> {
      throw new TravelError("unsupported", "Duffel stays are not supported yet (it needs map coordinates); use Amadeus for hotels.");
    },
  };
}
