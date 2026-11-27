import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amadeus } from "./amadeus.js";
import { duffel } from "./duffel.js";
import { flightsText } from "./format.js";
import { IlsRates, parseBoi } from "./ils.js";
import { buildTravel } from "./index.js";
import { cleanFlightQuery, cleanStayQuery, NO_KEY_TEXT, TravelService, type TravelSettings } from "./service.js";
import { travelTools } from "./tools.js";
import type { HttpFetch, HttpInit } from "./types.js";
import { detectDrop, isDue, MAX_HISTORY, MAX_POLLS_PER_DAY, MAX_WATCHES, TravelWatches, type Watch } from "./watches.js";

/** A fake network: answers by URL fragment, records every call. */
function fakeHttp(routes: Array<[string, (init?: HttpInit) => unknown | { status: number; body: unknown }]>): { http: HttpFetch; calls: Array<{ url: string; init?: HttpInit }> } {
  const calls: Array<{ url: string; init?: HttpInit }> = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes.find(([frag]) => url.includes(frag));
    if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const out = r[1](init) as { status?: number; body?: unknown } | unknown;
    const status = typeof out === "object" && out && "status" in out ? Number((out as { status: number }).status) : 200;
    const body = typeof out === "object" && out && "status" in out ? (out as { body: unknown }).body : out;
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { http, calls };
}

const NOW = Date.parse("2026-11-28T10:00:00");
const BOI = { exchangeRates: [{ key: "USD", currentExchangeRate: 3.6, unit: 1, lastUpdate: "2026-11-27T12:00:00Z" }, { key: "EUR", currentExchangeRate: 3.9, unit: 1, lastUpdate: "2026-11-27T12:00:00Z" }, { key: "JPY", currentExchangeRate: 2.4, unit: 100, lastUpdate: "2026-11-27T12:00:00Z" }] };
const AMADEUS_OFFERS = {
  data: [
    { id: "1", validatingAirlineCodes: ["LY"], price: { currency: "EUR", grandTotal: "400.00" }, itineraries: [{ duration: "PT4H35M", segments: [{ departure: { at: "2027-03-12T06:10:00" }, arrival: { at: "2027-03-12T09:05:00" }, carrierCode: "LY" }] }, { duration: "PT4H50M", segments: [{ departure: { at: "2027-03-19T10:00:00" }, arrival: { at: "2027-03-19T14:50:00" }, carrierCode: "LY" }] }] },
    { id: "2", validatingAirlineCodes: ["AZ"], price: { currency: "EUR", grandTotal: "300.00" }, itineraries: [{ duration: "PT8H", segments: [{ departure: { at: "2027-03-12T05:20:00" }, arrival: { at: "2027-03-12T07:00:00" }, carrierCode: "AZ" }, { departure: { at: "2027-03-12T08:00:00" }, arrival: { at: "2027-03-12T09:40:00" }, carrierCode: "AZ" }] }] },
  ],
  dictionaries: { carriers: { LY: "EL AL ISRAEL AIRLINES", AZ: "ITA AIRWAYS" } },
};
const settings = (over: Partial<TravelSettings> = {}): TravelSettings => ({ amadeusKey: "AK", amadeusSecret: "AS", amadeusHost: "test", origin: "TLV", everyHours: 6, dropPercent: 8, dropShekel: 150, ...over });

test("amadeus: signs in with client credentials on the chosen host and maps flight offers", async () => {
  const { http, calls } = fakeHttp([
    ["/v1/security/oauth2/token", () => ({ access_token: "tok", expires_in: 1799 })],
    ["/v2/shopping/flight-offers", () => AMADEUS_OFFERS],
  ]);
  const p = amadeus({ key: "AK", secret: "AS", host: "test", http, now: () => NOW });
  const offers = await p.searchFlights({ from: "TLV", to: "FCO", depart: "2027-03-12", return: "2027-03-19", adults: 1, cabin: "economy" });
  assert.equal(calls[0]!.url, "https://test.api.amadeus.com/v1/security/oauth2/token");
  assert.match(calls[0]!.init!.body!, /grant_type=client_credentials&client_id=AK&client_secret=AS/);
  assert.match(calls[1]!.url, /^https:\/\/test\.api\.amadeus\.com\/v2\/shopping\/flight-offers\?originLocationCode=TLV&destinationLocationCode=FCO&departureDate=2027-03-12&adults=1&travelClass=ECONOMY&max=20&returnDate=2027-03-19$/);
  assert.equal(calls[1]!.init!.headers!.Authorization, "Bearer tok");
  assert.equal(offers.length, 2);
  assert.deepEqual({ a: offers[0]!.airline, n: offers[0]!.airlineName, il: offers[0]!.israeli, price: offers[0]!.price, cur: offers[0]!.currency, stops: offers[0]!.out.stops, min: offers[0]!.out.minutes }, { a: "LY", n: "El Al", il: true, price: 400, cur: "EUR", stops: 0, min: 275 });
  assert.equal(offers[0]!.back?.departAt, "2027-03-19T10:00:00");
  assert.equal(offers[1]!.out.stops, 1);
  assert.equal(offers[1]!.airlineName, "Ita Airways");
  // The token is reused; production uses the other host.
  await p.searchFlights({ from: "TLV", to: "FCO", depart: "2027-03-12", adults: 1, cabin: "business" });
  assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1);
  assert.match(calls[2]!.url, /travelClass=BUSINESS/);
  const prod = amadeus({ key: "AK", secret: "AS", host: "production", http });
  await prod.searchFlights({ from: "TLV", to: "FCO", depart: "2027-03-12", adults: 1, cabin: "economy" });
  assert.ok(calls.some((c) => c.url.startsWith("https://api.amadeus.com/v1/security")));
});

test("amadeus: a refused key gives a clear error that never holds the key", async () => {
  const { http } = fakeHttp([["/v1/security/oauth2/token", () => ({ status: 401, body: { error: "invalid_client" } })]]);
  await assert.rejects(amadeus({ key: "SECRET-KEY", secret: "SECRET-SEC", host: "test", http }).searchFlights({ from: "TLV", to: "FCO", depart: "2027-03-12", adults: 1, cabin: "economy" }), (e: Error) => /refused the key/.test(e.message) && !/SECRET/.test(e.message));
});

test("amadeus: stays look up the city code, then the hotels' offers", async () => {
  const { http, calls } = fakeHttp([
    ["/v1/security/oauth2/token", () => ({ access_token: "tok", expires_in: 1799 })],
    ["/locations/cities", () => ({ data: [{ iataCode: "ROM" }] })],
    ["/hotels/by-city", () => ({ data: [{ hotelId: "H1" }, { hotelId: "H2" }] })],
    ["/v3/shopping/hotel-offers", () => ({ data: [{ hotel: { hotelId: "H1", name: "HOTEL COLOSSEO" }, offers: [{ id: "o1", price: { currency: "EUR", total: "700.00" } }] }] })],
  ]);
  const stays = await amadeus({ key: "k", secret: "s", host: "test", http }).searchStays({ city: "Rome", checkin: "2027-03-12", checkout: "2027-03-19", guests: 2 });
  assert.match(calls.find((c) => c.url.includes("hotel-offers"))!.url, /hotelIds=H1%2CH2&adults=2&checkInDate=2027-03-12&checkOutDate=2027-03-19/);
  assert.deepEqual(stays.map((s) => [s.name, s.price, s.currency, s.nights]), [["HOTEL COLOSSEO", 700, "EUR", 7]]);
});

test("duffel: one offer request with the token, search only, offers mapped and sorted", async () => {
  const { http, calls } = fakeHttp([["/air/offer_requests", () => ({ data: { offers: [
    { id: "off_2", total_amount: "500.00", total_currency: "USD", owner: { iata_code: "6H", name: "Israir Airlines" }, slices: [{ duration: "PT4H", segments: [{ departing_at: "2027-03-12T06:00:00", arriving_at: "2027-03-12T09:00:00" }] }, { duration: "PT4H", segments: [{ departing_at: "2027-03-19T10:00:00", arriving_at: "2027-03-19T14:00:00" }] }] },
    { id: "off_1", total_amount: "300.00", total_currency: "USD", owner: { iata_code: "W6", name: "Wizz Air" }, slices: [{ duration: "PT5H", segments: [{ departing_at: "2027-03-12T02:00:00", arriving_at: "2027-03-12T05:00:00" }] }] },
  ] } })]]);
  const p = duffel({ token: "duffel_test_x", http });
  const offers = await p.searchFlights({ from: "TLV", to: "FCO", depart: "2027-03-12", return: "2027-03-19", adults: 2, cabin: "premium_economy" });
  const sent = JSON.parse(calls[0]!.init!.body!) as { data: { slices: unknown[]; passengers: unknown[]; cabin_class: string } };
  assert.equal(calls[0]!.init!.headers!.Authorization, "Bearer duffel_test_x");
  assert.equal(calls[0]!.init!.headers!["Duffel-Version"], "v2");
  assert.equal(sent.data.slices.length, 2);
  assert.equal(sent.data.passengers.length, 2);
  assert.equal(sent.data.cabin_class, "premium_economy");
  assert.ok(calls.every((c) => !/\/air\/orders|payments/.test(c.url)), "no order or payment is ever made");
  assert.deepEqual(offers.map((o) => [o.id, o.israeli]), [["off_1", false], ["off_2", true]]);
  await assert.rejects(p.searchStays({ city: "Rome", checkin: "2027-03-12", checkout: "2027-03-19", guests: 2 }), /not supported/);
});

test("shekels: Bank of Israel table parsed (per unit), cached 24 h, stale kept when the bank fails", async () => {
  const t = parseBoi(BOI, NOW)!;
  assert.equal(t.date, "2026-11-27");
  assert.ok(Math.abs(t.rates.JPY! - 0.024) < 1e-9);
  let clock = NOW;
  let fail = false;
  const { http, calls } = fakeHttp([["boi.org.il/PublicApi/GetExchangeRates", () => (fail ? { status: 503, body: {} } : BOI)]]);
  const dir = await mkdtemp(join(tmpdir(), "kesher-ils-"));
  const rates = new IlsRates(http, join(dir, "r.json"), () => clock);
  assert.deepEqual(await rates.toIls(100, "EUR"), { ils: 390, date: "2026-11-27", stale: false });
  assert.equal((await rates.toIls(10, "ils"))?.ils, 10);
  clock += 23 * 3600_000;
  await rates.toIls(1, "USD");
  assert.equal(calls.length, 1, "fresh for 24 h: one request");
  // A new run reads the file instead of asking.
  await new IlsRates(http, join(dir, "r.json"), () => clock).toIls(1, "USD");
  assert.equal(calls.length, 1);
  clock += 2 * 3600_000;
  fail = true;
  const old = await rates.toIls(100, "USD");
  assert.deepEqual(old, { ils: 360, date: "2026-11-27", stale: true });
  assert.equal(calls.length, 2);
  assert.equal(await rates.toIls(1, "XYZ"), undefined);
  assert.equal(await new IlsRates(http, undefined, () => clock).toIls(1, "USD"), undefined, "no table at all: no shekel price");
});

test("service: no key says where to add one; Israeli airlines flagged; sorted by shekels; one provider failing does not hide the other", async () => {
  const none = new TravelService(() => settings({ amadeusKey: undefined, amadeusSecret: undefined }), fakeHttp([]).http, new IlsRates(fakeHttp([]).http, undefined, () => NOW));
  const q = cleanFlightQuery({ to: "FCO", depart: "2027-03-12" }, "TLV", NOW);
  assert.equal(q.from, "TLV", "TLV is the default origin");
  const r0 = await none.searchFlights(q);
  assert.ok(r0.noKey);
  assert.equal(flightsText(q, r0), NO_KEY_TEXT);
  assert.match(NO_KEY_TEXT, /Settings › Travel/);

  const { http } = fakeHttp([
    ["oauth2/token", () => ({ access_token: "t", expires_in: 1799 })],
    ["flight-offers", () => AMADEUS_OFFERS],
    ["offer_requests", () => ({ status: 500, body: { errors: [{ title: "Boom" }] } })],
    ["GetExchangeRates", () => BOI],
  ]);
  const svc = new TravelService(() => settings({ duffelToken: "d" }), http, new IlsRates(http, undefined, () => NOW));
  const r = await svc.searchFlights({ ...q, return: "2027-03-19" });
  assert.deepEqual(r.offers.map((o) => [o.airline, o.ils]), [["AZ", 1170], ["LY", 1560]]);
  assert.deepEqual(r.used, ["Amadeus"]);
  assert.match(r.errors[0]!, /Duffel: Boom/);
  const text = flightsText(q, r);
  assert.match(text, /\| 2 \| El Al LY ★ \| 12 Mar 06:10 → 09:05 \| 19 Mar 10:00 → 14:50 \| 0 \| ₪1,560 \(€400\) \|/);
  assert.match(text, /\| 1 \| Ita Airways AZ \| .* \| 1 \| ₪1,170 \(€300\) \|/);
  assert.match(text, /sample fares/);
  assert.match(text, /Bank of Israel rate of 2026-11-27/);
  assert.match(text, /does not book or pay/);
});

test("queries: codes, dates and counts are checked", () => {
  assert.throws(() => cleanFlightQuery({ to: "Rome", depart: "2027-03-12" }, "TLV", NOW), /3-letter airport code/);
  assert.throws(() => cleanFlightQuery({ to: "FCO", depart: "2026-11-01" }, "TLV", NOW), /in the past/);
  assert.throws(() => cleanFlightQuery({ to: "FCO", depart: "2027-03-12", return: "2027-03-01" }, "TLV", NOW), /before depart/);
  assert.throws(() => cleanFlightQuery({ to: "TLV", depart: "2027-03-12" }, "TLV", NOW), /same airport/);
  assert.throws(() => cleanFlightQuery({ to: "FCO", depart: "2027-03-12", adults: 12 }, "TLV", NOW), /adults/);
  assert.equal(cleanFlightQuery({ from: "tlv", to: "fco", depart: "2027-03-12", cabin: "Business" }, "TLV", NOW).cabin, "business");
  assert.throws(() => cleanStayQuery({ city: "Rome", checkin: "2027-03-12", checkout: "2027-03-12" }, NOW), /after checkin/);
  assert.equal(cleanStayQuery({ city: "Rome", checkin: "2027-03-12", checkout: "2027-03-14" }, NOW).guests, 2);
});

/** A watch with a history, for the drop rules. */
const watch = (over: Partial<Watch> = {}): Watch => ({ id: "w", kind: "flight", query: { from: "TLV", to: "FCO", depart: "2027-03-12", adults: 1, cabin: "economy" }, paused: false, createdAt: NOW, pollsToday: 0, history: [{ at: NOW - 6 * 3600_000, ils: 2000 }], ...over });

test("watch budget: every N hours, at most 4 a day, not paused or over", () => {
  const w = watch({ lastPollAt: NOW - 5 * 3600_000 });
  assert.equal(isDue(w, NOW, 6), false);
  assert.equal(isDue(w, NOW, 4), true);
  assert.equal(isDue(watch({ lastPollAt: NOW - 7 * 3600_000 }), NOW, 6), true);
  assert.equal(isDue(watch({ lastPollAt: NOW - 7 * 3600_000, paused: true }), NOW, 6), false);
  assert.equal(isDue(watch({ lastPollAt: NOW - 3600_000 * 7, pollDay: "2026-11-28", pollsToday: MAX_POLLS_PER_DAY }), NOW, 1), false, "the daily budget is the cap even at 1 h");
  assert.equal(isDue(watch({ lastPollAt: NOW - 3600_000 * 7, pollDay: "2026-11-27", pollsToday: 4 }), NOW, 6), true, "a new day starts again");
  assert.equal(isDue(watch({ query: { from: "TLV", to: "FCO", depart: "2026-11-01", adults: 1, cabin: "economy" } }), NOW, 6), false, "the trip is over");
});

test("drop detection: 8 % or 150 shekels, not for a rise, under the limit counts, once a day", () => {
  const rule = { percent: 8, shekel: 150 };
  assert.equal(detectDrop(watch(), 1900, rule, NOW), undefined, "5 % and 100 shekels: no");
  assert.equal(detectDrop(watch(), 1840, rule, NOW)?.reason, "drop", "160 shekels");
  assert.equal(detectDrop(watch({ history: [{ at: 1, ils: 1000 }] }), 915, rule, NOW)?.reason, "drop", "8.5 %");
  assert.equal(detectDrop(watch({ history: [{ at: 1, ils: 1000 }] }), 930, rule, NOW), undefined, "7 %, 70 shekels");
  assert.equal(detectDrop(watch(), 2100, rule, NOW), undefined, "a rise");
  assert.equal(detectDrop(watch({ history: [] }), 100, rule, NOW), undefined, "nothing to compare with");
  assert.equal(detectDrop(watch({ history: [{ at: 1, ils: 1500 }], maxIls: 1450 }), 1440, rule, NOW)?.reason, "target", "went under the limit");
  assert.equal(detectDrop(watch({ lastAlertDay: "2026-11-28" }), 1000, rule, NOW), undefined, "already told today");
  assert.equal(detectDrop(watch({ lastAlertDay: "2026-11-27" }), 1000, rule, NOW)?.reason, "drop", "yesterday's alert does not block");
});

test("watches on disk: limits, history of 60, one phone alert a day, errors kept, pause/delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-watch-"));
  const file = join(dir, "w.json");
  let clock = NOW;
  let price: { ils: number; who: string } | { error: string } = { ils: 2000, who: "El Al LY" };
  const sent: string[] = [];
  const store = new TravelWatches(file, { now: () => clock, price: async () => price, notify: async (t, b) => void sent.push(`${t} | ${b}`), rule: () => ({ percent: 8, shekel: 150, everyHours: 6 }) });
  const q = { from: "TLV", to: "FCO", depart: "2027-03-12", adults: 1, cabin: "economy" as const };
  const w = (await store.add("flight", q, 1500)) as Watch;
  assert.equal(await store.pollDue(), 1);
  assert.equal(await store.pollDue(), 0, "the wait is not over");
  clock += 6 * 3600_000;
  price = { ils: 1700, who: "Israir 6H" };
  await store.pollDue();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /TLV → FCO · 2027-03-12: ₪1,700 \| Down ₪300 \(was ₪2,000\) · Israir 6H/);
  clock += 6 * 3600_000;
  price = { ils: 1400, who: "Israir 6H" };
  await store.pollDue();
  assert.equal(sent.length, 1, "no second alert on the same day");
  clock += 24 * 3600_000;
  price = { error: "Amadeus: HTTP 500" };
  await store.pollDue();
  assert.equal((await store.all())[0]!.lastError, "Amadeus: HTTP 500");
  assert.equal((await store.all())[0]!.history.length, 3, "a failed look adds no price");
  // The history keeps the last 60.
  price = { ils: 1400, who: "x" };
  for (let i = 0; i < 70; i++) {
    clock += 7 * 3600_000;
    await store.pollDue();
  }
  const kept = (await store.all())[0]!;
  assert.equal(kept.history.length, MAX_HISTORY);
  assert.ok(kept.pollsToday <= MAX_POLLS_PER_DAY);
  // It survives a restart; pause and delete work.
  const again = new TravelWatches(file, { price: async () => price, notify: async () => undefined, rule: () => ({ percent: 8, shekel: 150, everyHours: 6 }) });
  assert.equal((await again.all()).length, 1);
  assert.ok(await again.setPaused(w.id, true));
  assert.equal(((await again.all())[0] as Watch).paused, true);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(file, "utf8"))).includes("secret"));
  assert.ok(await again.remove(w.id));
  assert.equal(await again.remove(w.id), false);
  // At most 10 at once.
  for (let i = 0; i < MAX_WATCHES; i++) assert.equal(typeof (await again.add("flight", q)), "object");
  assert.match((await again.add("flight", q)) as string, /Up to 10/);
});

test("tools: search and watch end to end with a fake network; no key says where to add one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-tools-"));
  const { http } = fakeHttp([["oauth2/token", () => ({ access_token: "t", expires_in: 1799 })], ["flight-offers", () => AMADEUS_OFFERS], ["GetExchangeRates", () => BOI]]);
  const sent: string[] = [];
  let s = settings();
  const t = buildTravel(dir, () => s, async (title) => void sent.push(title), http);
  const tools = travelTools(t);
  assert.deepEqual(tools.map((x) => x.spec.name), ["travel_search_flights", "travel_search_stays", "travel_watch", "travel_watches"]);
  const run = (name: string, input: Record<string, unknown>) => tools.find((x) => x.spec.name === name)!.run(input, { signal: new AbortController().signal } as never);
  const future = `${new Date().getFullYear() + 1}-03-12`;
  const out = (await run("travel_search_flights", { to: "FCO", depart: future })).output;
  assert.match(out, /^Flights TLV -> FCO/);
  assert.match(out, /El Al LY ★/);
  assert.match((await run("travel_search_flights", { to: "Rome", depart: future })).output, /^Error: to must be a 3-letter/);
  const w = (await run("travel_watch", { kind: "flight", to: "FCO", depart: future, max_price_ils: 1200 })).output;
  assert.match(w, /^Watching .* · flight · TLV → FCO/);
  assert.match((await run("travel_watches", {})).output, /under ₪1200/);
  s = settings({ amadeusKey: undefined, amadeusSecret: undefined });
  assert.equal((await run("travel_search_flights", { to: "FCO", depart: future })).output, NO_KEY_TEXT);
  assert.equal((await run("travel_watch", { kind: "flight", to: "FCO", depart: future })).output, NO_KEY_TEXT);
});
