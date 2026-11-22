import { test } from "node:test";
import assert from "node:assert/strict";
import { countUse, FREE_ALLOWANCE, monthOf, nearLimit, RelayRouter, useThisMonth, type RelayChoice } from "./relay-failover.js";

/** A clock the test moves by hand. */
function clock(start = Date.UTC(2026, 10, 22, 12)) {
  let t = start;
  return { now: () => t, add: (ms: number) => void (t += ms) };
}

const both: RelayChoice[] = [
  { kind: "ably", healthy: true },
  { kind: "supabase", healthy: true },
];

test("the hub first while it answers; a short gap uses a relay without failing over", () => {
  const c = clock();
  const r = new RelayRouter(c.now);
  r.hubOpen();
  assert.equal(r.pick(both, undefined), "hub");
  c.add(30_000);
  r.hubHeard();
  r.hubClosed();
  assert.equal(r.pick(both, undefined), "ably", "no socket: nothing goes into a dead link");
  c.add(5000);
  r.hubOpen();
  assert.equal(r.pick(both, undefined), "hub", "back within 20 s: no failover, the hub at once");
});

test("failover order: no socket for 20 s, then Ably, then Supabase, the hub last", () => {
  const c = clock();
  const r = new RelayRouter(c.now);
  r.hubOpen();
  r.hubClosed();
  c.add(20_000);
  assert.equal(r.hubDown(), true);
  assert.deepEqual(r.order(both, undefined), ["ably", "supabase", "hub"]);
  assert.deepEqual(r.order([{ kind: "ably", healthy: false }, { kind: "supabase", healthy: true }], undefined), ["supabase", "hub"]);
  assert.deepEqual(r.order([{ kind: "ably", healthy: false }], undefined), ["hub"], "nothing healthy: the hub anyway");
});

test("a 503 storage limit or a 1101 fails over at once; a silent socket (no pong for 60 s) too", () => {
  const c = clock();
  const r = new RelayRouter(c.now);
  r.hubOpen();
  r.hubFailed();
  assert.equal(r.pick(both, undefined), "ably");
  const s = new RelayRouter(c.now);
  s.hubOpen();
  c.add(60_001);
  assert.equal(s.pick(both, undefined), "ably", "open but silent");
});

test("back to the hub only after it has answered for 2 minutes in a row", () => {
  const c = clock();
  const r = new RelayRouter(c.now);
  r.hubOpen();
  r.hubClosed();
  c.add(25_000);
  assert.equal(r.pick(both, undefined), "ably");
  r.hubOpen();
  for (let i = 0; i < 3; i++) {
    c.add(30_000);
    r.hubHeard();
    assert.equal(r.pick(both, undefined), "ably", "not yet 2 minutes");
  }
  c.add(30_000);
  r.hubHeard();
  assert.equal(r.pick(both, undefined), "hub");
  // A silence resets the 2 minutes.
  c.add(61_000);
  assert.equal(r.pick(both, undefined), "ably");
  r.hubHeard();
  c.add(60_000);
  r.hubHeard();
  assert.equal(r.pick(both, undefined), "ably");
  c.add(60_000);
  r.hubHeard();
  assert.equal(r.pick(both, undefined), "hub");
});

test("the 80% rule: a relay past 80% of its free allowance is the last fallback", () => {
  const c = clock();
  const r = new RelayRouter(c.now);
  c.add(20_000);
  const month = monthOf(c.now());
  const ablyTired = { month, ably: FREE_ALLOWANCE.ably * 0.8, supabase: 10 };
  assert.equal(nearLimit(ablyTired, "ably", c.now()), true);
  assert.equal(nearLimit(ablyTired, "supabase", c.now()), false);
  assert.deepEqual(r.order(both, ablyTired), ["supabase", "ably", "hub"]);
  assert.deepEqual(r.order([{ kind: "ably", healthy: true }, { kind: "supabase", healthy: false }], ablyTired), ["ably", "hub"], "still used when it is the only one");
  r.hubOpen();
  for (let i = 0; i < 4; i++) {
    c.add(30_000);
    r.hubHeard();
  }
  assert.deepEqual(r.order(both, ablyTired), ["hub", "supabase", "ably"]);
});

test("use is counted per UTC month and starts again in a new month", () => {
  const nov = Date.UTC(2026, 10, 30, 23, 59);
  let u = countUse(undefined, "ably", 2, nov);
  u = countUse(u, "ably", 1, nov);
  assert.deepEqual(u, { month: "2026-11", ably: 3, supabase: 0 });
  assert.deepEqual(useThisMonth(u, Date.UTC(2026, 11, 1)), { month: "2026-12", ably: 0, supabase: 0 });
  assert.deepEqual(useThisMonth({ month: "2026-11", ably: -5, supabase: Number.NaN }, nov), { month: "2026-11", ably: 0, supabase: 0 });
});
