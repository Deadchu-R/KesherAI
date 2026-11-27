import type { SearchResult } from "./service.js";
import { NO_KEY_TEXT } from "./service.js";
import type { FlightOffer, FlightQuery, Leg, StayOffer, StayQuery } from "./types.js";

/**
 * The result of a search as text: a short header and a compact Markdown table the model reads and the chat shows as a
 * table card (apps/web `travelTable`). Prices in shekels with the provider's currency in brackets; ★ marks El Al,
 * Israir and Arkia.
 */

/** Rows shown (the rest is "N more"). */
export const MAX_ROWS = 8;

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1,380". */
const num = (n: number): string => Math.round(n).toLocaleString("en-US");

/** @returns "₪1,380 ($382)", or just "€385" when no shekel price is known. */
export function priceText(price: number, currency: string, ils?: number): string {
  const src = `${SYMBOL[currency] ?? `${currency} `}${num(price)}`;
  if (currency === "ILS") return `₪${num(price)}`;
  return ils === undefined ? src : `₪${num(ils)} (${src})`;
}

/** @returns "12 Mar 06:10 → 09:05" (a "+1" when it lands the next day). */
export function legText(l: Leg): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(l.departAt);
  const a = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(l.arriveAt);
  if (!d || !a) return "?";
  const next = a[1]! + a[2]! + a[3]! !== d[1]! + d[2]! + d[3]! ? "+1" : "";
  return `${Number(d[3])} ${MONTHS[Number(d[2]) - 1] ?? ""} ${d[4]} → ${a[4]}${next}`;
}

/** The lines every result ends with when something went wrong or is only a sample. */
function notes(r: SearchResult<unknown>): string[] {
  const out: string[] = [];
  if (r.test) out.push("Amadeus is on its test host: these are sample fares, not real ones (switch to production in Settings › Travel).");
  if (r.rateDate) out.push(`Prices in ₪ at the Bank of Israel rate of ${r.rateDate}${r.rateStale ? " (older table: the bank could not be reached)" : ""}; the airline's currency is in brackets.`);
  else if (r.offers.length) out.push("No shekel rate could be read from the Bank of Israel, so prices are in their own currency.");
  for (const e of r.errors) out.push(e);
  return out;
}

/**
 * A flight search as text.
 *
 * @param q - The query.
 * @param r - The result.
 * @returns The header, the table and the notes; the "add a key" line when there is no key.
 */
export function flightsText(q: FlightQuery, r: SearchResult<FlightOffer>): string {
  if (r.noKey) return NO_KEY_TEXT;
  const head = `Flights ${q.from} -> ${q.to} · ${q.depart}${q.return ? ` to ${q.return}` : " one way"} · ${q.adults} adult${q.adults === 1 ? "" : "s"} · ${q.cabin.replace("_", " ")} · ${r.used.join(" + ") || "no provider answered"}`;
  if (!r.offers.length) return [head, "No flights found.", ...notes(r)].join("\n");
  const rows = r.offers.slice(0, MAX_ROWS).map((o, i) => `| ${i + 1} | ${o.airlineName} ${o.airline}${o.israeli ? " ★" : ""} | ${legText(o.out)} | ${o.back ? legText(o.back) : "-"} | ${o.out.stops} | ${priceText(o.price, o.currency, o.ils)} |`);
  const first = r.offers[0]!;
  return [
    head,
    "| # | Airline | Out | Back | Stops | Price |",
    "| - | - | - | - | - | - |",
    ...rows,
    r.offers.length > MAX_ROWS ? `(${r.offers.length - MAX_ROWS} more not shown)` : "",
    `Cheapest: ${priceText(first.price, first.currency, first.ils)} (${first.airlineName}). Prices are for all passengers, bags not included unless the airline says so. Search only: KesherAI does not book or pay.`,
    ...notes(r),
  ].filter(Boolean).join("\n");
}

/**
 * A stay search as text.
 *
 * @param q - The query.
 * @param r - The result.
 * @returns The header, the table and the notes.
 */
export function staysText(q: StayQuery, r: SearchResult<StayOffer>): string {
  if (r.noKey) return NO_KEY_TEXT;
  const head = `Stays in ${q.city} · ${q.checkin} to ${q.checkout} · ${q.guests} guest${q.guests === 1 ? "" : "s"} · ${r.used.join(" + ") || "no provider answered"}`;
  if (!r.offers.length) return [head, "No stays found.", ...notes(r)].join("\n");
  const rows = r.offers.slice(0, MAX_ROWS).map((o, i) => `| ${i + 1} | ${o.name} | ${o.nights} | ${priceText(o.price, o.currency, o.ils)} | ${o.ils !== undefined ? `₪${num(o.ils / o.nights)}` : "-"} |`);
  return [head, "| # | Stay | Nights | Total | Per night |", "| - | - | - | - | - |", ...rows, r.offers.length > MAX_ROWS ? `(${r.offers.length - MAX_ROWS} more not shown)` : "", "Search only: KesherAI does not book or pay.", ...notes(r)].filter(Boolean).join("\n");
}
