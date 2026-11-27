import { test } from "node:test";
import assert from "node:assert/strict";
import { activeComputer, computerLine, computerWhy, lastSeenText, setActiveComputer, sortComputers, startComputer } from "./active-computer.js";

/** A tiny localStorage for the test (node has none). */
function fakeStorage(): void {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  } as Storage;
}

test("the app-wide computer is remembered once for every chat, and cleared", () => {
  fakeStorage();
  assert.equal(activeComputer(), "");
  setActiveComputer("device-abc123");
  assert.equal(activeComputer(), "device-abc123");
  setActiveComputer("");
  assert.equal(activeComputer(), "");
});

test("a stored value that is not a device id is ignored", () => {
  fakeStorage();
  localStorage.setItem("kesherai-active-computer", "http://evil.example");
  assert.equal(activeComputer(), "");
});

test("a chat starts on its own computer, else the app-wide one if still found, else the connected one", () => {
  assert.equal(startComputer("device-a", "device-b", ["device-a", "device-b"]), "device-a");
  assert.equal(startComputer("", "device-b", ["device-a", "device-b"]), "device-b");
  assert.equal(startComputer("", "device-gone", ["device-a"]), "");
  assert.equal(startComputer("", "", ["device-a"]), "");
});

test("the list puts the computer in use first, then the online ones", () => {
  const rows = [
    { id: "1", name: "Zed", me: false, online: false },
    { id: "2", name: "Home", me: true, online: true },
    { id: "3", name: "Laptop", me: false, online: true, providerId: "device-3" },
  ];
  assert.deepEqual(sortComputers(rows, "").map((r) => r.id), ["2", "3", "1"]);
  assert.deepEqual(sortComputers(rows, "device-3").map((r) => r.id), ["3", "2", "1"]);
});

test("last seen in minutes, hours and days, in both languages", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assert.equal(lastSeenText("2026-11-21T11:30:00Z", now, false), "seen 30 min ago");
  assert.equal(lastSeenText("2026-11-21T09:00:00Z", now, true), "נראה לפני 3 שעות");
  assert.equal(lastSeenText("2026-11-18T12:00:00Z", now, false), "seen 3 days ago");
  assert.equal(lastSeenText(undefined, now, false), "");
});

test("computer line: online, asleep (when and what was running), offline (last seen), version", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const pc = { id: "a", name: "PC", me: false, online: false, version: "0.6.1" };
  assert.equal(computerLine({ ...pc, online: true }, false, now, false), "Online · v0.6.1");
  assert.equal(computerLine({ ...pc, asleepSince: "2026-11-21T11:58:00Z", asleepNote: { downloads: 3 } }, false, now, false), "PC went to sleep · 2 min ago · 3 downloads paused · v0.6.1");
  assert.equal(computerLine({ ...pc, asleepSince: "2026-11-21T11:58:00Z" }, false, now, true), "המחשב נכנס לשינה · לפני 2 דק' · v0.6.1");
  assert.equal(computerLine({ ...pc, lastSeen: "2026-11-21T11:30:00Z" }, true, now, false), "Offline · seen 30 min ago · v0.6.1 · Used for all chats");
});

test("computerWhy: restarting for an update, asleep, offline; nothing for one that is online", () => {
  const base = { id: "d1", name: "PC", me: false, online: false };
  assert.equal(computerWhy({ ...base, online: true }), null);
  assert.equal(computerWhy({ ...base, asleepSince: "2026-11-27T15:50:00Z", asleepNote: { update: "0.6.498" } })?.reason, "pc-restarting");
  assert.equal(computerWhy({ ...base, asleepSince: "2026-11-27T15:50:00Z" })?.reason, "pc-asleep");
  assert.equal(computerWhy(base)?.reason, "pc-offline");
});
