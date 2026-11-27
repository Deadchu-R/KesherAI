import type { AgentTool } from "@kesher/agent";
import { flightsText, staysText } from "./format.js";
import { cleanFlightQuery, cleanStayQuery, NO_KEY_TEXT, type TravelService } from "./service.js";
import { TravelError, type FlightQuery, type StayQuery } from "./types.js";
import { MAX_POLLS_PER_DAY, MAX_WATCHES, watchLabel, type TravelWatches, type Watch } from "./watches.js";

/**
 * The chat's travel tools. Search only: no booking, no payment, ever. `travel_search_flights` and
 * `travel_search_stays` ask the providers the user has keys for (Settings › Travel); `travel_watch` and
 * `travel_watches` keep an eye on a price and tell the phone when it drops.
 */

/** The one line the model gets when these tools are offered (the group's words decide when that is). */
export const TRAVEL_NOTE =
  "Travel: for flights or hotels use travel_search_flights / travel_search_stays (prices come back in shekels with the original currency; ★ marks El Al, Israir, Arkia); offer travel_watch for a price alert. You only search: never book, pay or enter card details, and say so if asked to.";

/** What the tools need. */
export interface TravelToolDeps {
  service: TravelService;
  watches: TravelWatches;
}

/** @returns A model-facing error line for a thrown error. */
function failure(e: unknown): { output: string } {
  if (e instanceof TravelError) return { output: e.code === "no-key" ? NO_KEY_TEXT : `Error: ${e.message}` };
  return { output: "Error: the travel search failed." };
}

/** One line of a watch for the model and the user. */
function watchLine(w: Watch): string {
  const last = w.history[w.history.length - 1];
  return `${w.id} · ${w.kind} · ${watchLabel(w)}${w.maxIls ? ` · under ₪${w.maxIls}` : ""} · ${last ? `now ₪${last.ils}` : "not looked at yet"}${w.paused ? " · paused" : ""}${w.expired ? " · trip over" : ""}${w.lastError ? ` · last problem: ${w.lastError}` : ""}`;
}

/**
 * The travel tools.
 *
 * @param d - The search service and the watches.
 * @returns The four tools.
 */
export function travelTools(d: TravelToolDeps): AgentTool[] {
  const origin = () => d.service.settings().origin;
  const flightProps = {
    from: { type: "string", description: "Departure airport, 3-letter IATA code. Default: the user's home airport (TLV)." },
    to: { type: "string", description: "Arrival airport, 3-letter IATA code (e.g. FCO for Rome)." },
    depart: { type: "string", description: "Departure date, YYYY-MM-DD." },
    return: { type: "string", description: "Return date, YYYY-MM-DD; leave out for one way." },
    adults: { type: "integer", description: "Passengers, 1-9 (default 1)." },
    cabin: { type: "string", enum: ["economy", "premium_economy", "business", "first"], description: "Default economy." },
  };
  const stayProps = {
    city: { type: "string", description: "City name or 3-letter IATA city code (ROM)." },
    checkin: { type: "string", description: "YYYY-MM-DD." },
    checkout: { type: "string", description: "YYYY-MM-DD." },
    guests: { type: "integer", description: "Guests, 1-9 (default 2)." },
  };
  return [
    {
      risk: "read",
      spec: {
        name: "travel_search_flights",
        description: "Search flights (search only, no booking). Returns a table with the price in shekels (Bank of Israel rate) and the airline's currency; Israeli airlines (El Al, Israir, Arkia) are marked ★. Needs the user's free key in Settings › Travel; without it the result says so. Use real dates (today's date is in the conversation).",
        inputSchema: { type: "object", properties: flightProps, required: ["to", "depart"] },
      },
      async run(input, ctx) {
        try {
          const q = cleanFlightQuery(input, origin());
          return { output: flightsText(q, await d.service.searchFlights(q, ctx.signal)) };
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      risk: "read",
      spec: {
        name: "travel_search_stays",
        description: "Search hotels for a stay (search only, no booking). Returns a table with the total and per-night price in shekels. Needs the user's Amadeus key in Settings › Travel.",
        inputSchema: { type: "object", properties: stayProps, required: ["city", "checkin", "checkout"] },
      },
      async run(input, ctx) {
        try {
          const q = cleanStayQuery(input);
          return { output: staysText(q, await d.service.searchStays(q, ctx.signal)) };
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      risk: "read",
      spec: {
        name: "travel_watch",
        description: `Watch a price and tell the user's phone when it drops (default 8 % or ₪150, at most once a day per watch). kind "flight" takes the flight fields, kind "stay" the stay fields. max_price_ils: also tell me when it is at or under this many shekels. Looked at every few hours (at most ${MAX_POLLS_PER_DAY} times a day, ${MAX_WATCHES} watches). The user sees, pauses and deletes watches in Settings › Travel.`,
        inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["flight", "stay"] }, ...flightProps, ...stayProps, max_price_ils: { type: "integer", description: "Optional highest price in shekels." } }, required: ["kind"] },
      },
      async run(input) {
        try {
          if (!d.service.providers().length) return { output: NO_KEY_TEXT };
          const kind = input.kind === "stay" ? "stay" : "flight";
          const q: FlightQuery | StayQuery = kind === "stay" ? cleanStayQuery(input) : cleanFlightQuery(input, origin());
          const w = await d.watches.add(kind, q, Number(input.max_price_ils) || undefined);
          if (typeof w === "string") return { output: `Error: ${w}` };
          // The first look happens now (counts toward the budget), so the history starts.
          void d.watches.pollDue().catch(() => undefined);
          return { output: `Watching ${watchLine(w)}. Looked at about every ${d.service.settings().everyHours} h; the phone is told on a drop. Manage it in Settings › Travel.` };
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      risk: "read",
      spec: {
        name: "travel_watches",
        description: "List the user's price watches (id, route, limit, last price), or pause / resume / delete one by id.",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "pause", "resume", "delete"] }, id: { type: "string" } } },
      },
      async run(input) {
        const action = String(input.action ?? "list");
        if (action === "list") {
          const all = await d.watches.all();
          return { output: all.length ? all.map(watchLine).join("\n") : "No price watches yet." };
        }
        const id = String(input.id ?? "");
        const ok = action === "delete" ? await d.watches.remove(id) : action === "pause" || action === "resume" ? await d.watches.setPaused(id, action === "pause") : undefined;
        if (ok === undefined) return { output: "Error: action must be list, pause, resume or delete." };
        return { output: ok ? `Done: ${action} ${id}.` : `Error: no watch with id "${id}".` };
      },
    },
  ];
}
