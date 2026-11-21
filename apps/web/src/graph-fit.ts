/**
 * What a node graph's view does when its frame changes size (BlueprintCanvas: Unreal Blueprints and Unity Script
 * Graphs). Kept apart so it can be tested without a browser.
 */

/** How long after the graph is fitted on opening the frame may still settle (and the graph is fitted again). */
export const SETTLE_MS = 1500;

/**
 * Decides the view's change for one frame resize.
 * - The frame has no size (a hidden tab): nothing.
 * - It had no size before, or the graph was fitted less than {@link SETTLE_MS} ago and not touched since: fit again,
 *   so a frame that settles after opening still shows the whole graph in its middle.
 * - Otherwise: keep the zoom and the point in the middle (as in Unreal), moving by half the size change.
 *
 * @param was - The frame's size before.
 * @param now - Its size now.
 * @param sinceFit - Milliseconds since the opening fit (a large number once the user touched the graph).
 * @returns "fit", the shift to add to the view, or null for nothing.
 */
export function resizeAction(was: { width: number; height: number }, now: { width: number; height: number }, sinceFit: number): "fit" | { dx: number; dy: number } | null {
  if (now.width < 2 || now.height < 2) return null;
  if (was.width < 2 || was.height < 2 || sinceFit < SETTLE_MS) return "fit";
  const dx = (now.width - was.width) / 2;
  const dy = (now.height - was.height) / 2;
  return dx || dy ? { dx, dy } : null;
}
