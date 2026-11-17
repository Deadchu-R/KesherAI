import { describe, expect, it } from "vitest";
import { advance, answer, createRoom, getRoom, join, playerView } from "./live-quiz.js";

const qs = [
  { q: "2+2?", options: ["3", "4"], answer: 1, explain: "" },
  { q: "open", options: [], answer: -1, explain: "" },
  { q: "1+1?", options: ["2", "5"], answer: 0, explain: "two" },
];

describe("live quiz", () => {
  it("runs a room: join, answer against the clock, scoreboard", () => {
    const r = createRoom("Physio", qs, 20, 1000);
    expect(r.questions).toHaveLength(2);
    expect(getRoom(r.token, 1000)).toBe(r);
    const a = join(r, " Dana<b> ");
    const b = join(r, "Noa");
    expect(r.players.get(a)!.name).toBe("Danab");
    expect(answer(r, a, 0, 1, 1000)).toBe(false); // still the lobby
    advance(r, 2000);
    expect(playerView(r, a, 2000)).not.toHaveProperty("answer");
    expect(answer(r, a, 0, 1, 2000)).toBe(true);
    expect(answer(r, a, 0, 0, 2100)).toBe(false); // once
    expect(answer(r, b, 0, 1, 12_000)).toBe(true);
    expect(r.players.get(a)!.score).toBe(1000);
    expect(r.players.get(b)!.score).toBe(750);
    advance(r);
    const v = playerView(r, b);
    expect(v.answer).toBe(1);
    expect(v.board![0]!.name).toBe("Danab");
    advance(r, 30_000);
    expect(answer(r, b, 1, 0, 30_000 + 25_000)).toBe(false); // too late
    advance(r);
    advance(r);
    expect(r.stage).toBe("end");
    expect(getRoom(r.token, 1000 + 4 * 3600_000)).toBeUndefined();
    expect(getRoom("../x")).toBeUndefined();
  });
});
