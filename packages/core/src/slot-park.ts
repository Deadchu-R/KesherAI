/**
 * The chat model's cache around VRAM-heavy ComfyUI jobs (docs/WORK_LIST.md, "Models and agents"): when the graphics
 * card has too little free memory for a flow next to the chat model, the chat's slot is saved to disk and the chat
 * engine stopped; the next chat message loads the model again (the graphics card guard) and the slot is restored
 * (LlamaEngine.parkSlot), so the conversation is not read again from the start. Found on the PC: with both on one
 * 24 GB card, the chat model answered in minutes instead of seconds after a song.
 */

/** Free graphics memory a ComfyUI flow should have beside the chat model (GiB); below it the chat model steps aside. */
export const COMFY_FREE_GIB = 10;

/**
 * Whether the graphics card is too full for a ComfyUI job beside the chat model.
 *
 * @param cards - The cards the guard sees (bytes); none when it cannot read them.
 * @param minFreeGiB - The free memory a flow needs.
 * @returns True when the card with the most free memory has less than that.
 */
export function vramShort(cards: ReadonlyArray<{ memUsed: number; memTotal: number }>, minFreeGiB = COMFY_FREE_GIB): boolean {
  const known = cards.filter((c) => c.memTotal > 0);
  if (!known.length) return false;
  const free = Math.max(...known.map((c) => c.memTotal - c.memUsed));
  return free < minFreeGiB * 1024 ** 3;
}

/** What {@link parkChatFor} needs from the chat engine and the guard. */
export interface ParkDeps {
  /** A chat model is loaded. */
  running: () => boolean;
  /** Other local work runs now (stopping the engine would cut it off). */
  busy: () => boolean;
  /** The card is too full for the job beside the chat model. */
  short: () => boolean;
  /** Saves the main chat's slot to disk. */
  park: () => Promise<boolean>;
  /** Stops the chat engine. */
  stop: (reason: string) => Promise<void>;
}

/**
 * Before a ComfyUI job: frees the card from the chat model when the job needs it, keeping the chat's cache on disk.
 *
 * @param d - The engine and guard.
 * @returns Whether the chat model was stopped (it loads again with the next message, with its cache).
 */
export async function parkChatFor(d: ParkDeps): Promise<boolean> {
  if (!d.running() || d.busy() || !d.short()) return false;
  await d.park().catch(() => false);
  await d.stop("a ComfyUI job needs the graphics card (the chat's cache is saved and comes back with the next message)");
  return true;
}
