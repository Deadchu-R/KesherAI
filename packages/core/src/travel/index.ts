import { join } from "node:path";
import { IlsRates } from "./ils.js";
import { NO_KEY_TEXT, TravelService, type TravelSettings } from "./service.js";
import { TravelWatches, type Watch } from "./watches.js";
import type { FlightQuery, HttpFetch, StayQuery } from "./types.js";

export { travelTools, TRAVEL_NOTE } from "./tools.js";
export { TravelService, type TravelSettings } from "./service.js";
export { TravelWatches, type Watch } from "./watches.js";

/** The real `fetch`, narrowed to what the adapters use. */
export const realFetch: HttpFetch = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });

/**
 * Puts the travel parts together: the search service (with the shekel rates cached in `travel-rates.json`) and the
 * price watches (in `travel-watches.json`), whose price lookup is the cheapest offer of the watch's own search.
 *
 * @param dir - KesherAI's data folder.
 * @param settings - The current settings (read each time).
 * @param notify - Sends a phone notification (title, body).
 * @param http - `fetch` (a fake in tests).
 * @returns The service and the watches.
 */
export function buildTravel(dir: string, settings: () => TravelSettings, notify: (title: string, body: string) => Promise<void>, http: HttpFetch = realFetch): { service: TravelService; watches: TravelWatches } {
  const service = new TravelService(settings, http, new IlsRates(http, join(dir, "travel-rates.json")));
  const watches = new TravelWatches(join(dir, "travel-watches.json"), {
    notify,
    rule: () => {
      const s = settings();
      return { percent: s.dropPercent, shekel: s.dropShekel, everyHours: s.everyHours };
    },
    price: (w: Watch) => cheapest(service, w),
  });
  return { service, watches };
}

/** The cheapest offer of a watch's search, in shekels, or why there is none. */
async function cheapest(service: TravelService, w: Watch): Promise<{ ils: number; who: string } | { error: string }> {
  const r = w.kind === "flight" ? await service.searchFlights(w.query as FlightQuery) : await service.searchStays(w.query as StayQuery);
  if (r.noKey) return { error: NO_KEY_TEXT };
  const best = r.offers.find((o) => o.ils !== undefined);
  if (!best) return { error: r.errors[0] ?? "No price found." };
  const who = "airlineName" in best ? `${best.airlineName} ${best.airline}` : best.name;
  return { ils: best.ils!, who };
}
