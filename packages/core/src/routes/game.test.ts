import { test } from "node:test";
import assert from "node:assert/strict";
import { gameName, takeGameShot } from "./game.js";

test("a game's name comes from its window, without the engine's additions", () => {
  assert.equal(gameName("eldenring", "ELDEN RING™"), "ELDEN RING");
  assert.equal(gameName("Cyberpunk2077", "Cyberpunk 2077 (C) 2020 by CD Projekt RED"), "Cyberpunk 2077 (C) 2020 by CD Projekt RED");
  assert.equal(gameName("Hades2", "Hades II - DirectX 12"), "Hades II");
  assert.equal(gameName("StellarBlade-Win64-Shipping", ""), "Stellar Blade");
  assert.equal(takeGameShot("none"), "");
});
