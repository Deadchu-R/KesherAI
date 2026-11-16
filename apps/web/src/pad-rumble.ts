/**
 * A short rumble on the controller (audit C4) when an answer is ready or something waits for you, so a handheld
 * player knows without looking. Only while the controller is in use (the page is in pad mode) and the browser gives
 * the pad's vibration (Chromium's `vibrationActuator`); otherwise nothing.
 */

/** What changed between two activity reads (chat id → running / waiting). */
export function rumbleFor(prev: Record<string, string>, next: Record<string, string>): "done" | "waiting" | undefined {
  if (Object.entries(next).some(([id, st]) => st === "waiting" && prev[id] !== "waiting")) return "waiting";
  if (Object.entries(prev).some(([id, st]) => st === "running" && !next[id])) return "done";
  return undefined;
}

/**
 * Rumbles the connected controller: one short pulse for "done", two for "waiting".
 *
 * @param kind - What happened.
 */
export function padRumble(kind: "done" | "waiting"): void {
  if (typeof navigator === "undefined" || !document.documentElement.classList.contains("pad")) return;
  const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
  const act = (pad as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }) | undefined)?.vibrationActuator;
  if (!act?.playEffect) return;
  const pulse = () => void act.playEffect!("dual-rumble", { duration: 140, strongMagnitude: 0.5, weakMagnitude: 0.8 }).catch(() => undefined);
  pulse();
  if (kind === "waiting") setTimeout(pulse, 260);
}
