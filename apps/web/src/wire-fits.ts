import { unrealPinsFit } from "@kesher/shared";

/**
 * Whether a wire from one pin type fits another, as Unreal tells it while dragging (shared/unreal-bp.ts: exec only to
 * exec, numbers and strings convert, structs by name, objects into their class or a parent, wildcards take the type).
 *
 * @param from - The output pin's type.
 * @param to - The input pin's type.
 * @param parents - Blueprint classes' parents (BP_Enemy → Character), for Blueprint object pins.
 * @returns ok, and in short why.
 */
export function wireFits(from: string, to: string, parents?: Record<string, string>): { ok: boolean; why: string } {
  return unrealPinsFit(from, to, parents);
}
