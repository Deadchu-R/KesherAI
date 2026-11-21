import { test } from "node:test";
import assert from "node:assert/strict";
import { currentGame, gameName, takeGameShot } from "./game.js";

test("a game's name comes from its window, without the engine's additions", () => {
  assert.equal(gameName("eldenring", "ELDEN RING™"), "ELDEN RING");
  assert.equal(gameName("Cyberpunk2077", "Cyberpunk 2077 (C) 2020 by CD Projekt RED"), "Cyberpunk 2077 (C) 2020 by CD Projekt RED");
  assert.equal(gameName("Hades2", "Hades II - DirectX 12"), "Hades II");
  assert.equal(gameName("StellarBlade-Win64-Shipping", ""), "Stellar Blade");
  assert.equal(takeGameShot("none"), "");
});

test("currentGame: the game in front, else the last one seen in the past hours", () => {
  const t = 1_000_000_000_000;
  assert.equal(currentGame("Hades II", t), "Hades II");
  // KesherAI's console is in front now: still the game being played.
  assert.equal(currentGame("", t + 3600_000), "Hades II");
  assert.equal(currentGame("", t + 7 * 3600_000), "");
  assert.equal(currentGame("Celeste", t + 8 * 3600_000), "Celeste");
});
