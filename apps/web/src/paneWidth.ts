/**
 * Widths of the pane column beside a chat (Steps, Files, Context, Coach and the built-in browser): the limits, the
 * default (the browser gets about 45% of a wide window, the rest 360 px), and the "expanded" width that gives the
 * browser most of the window with the chat narrow beside it. Pure, so it is tested.
 */

/** The narrowest a pane column can be dragged to (px). */
export const PANE_MIN = 260;
/** The default width of the ordinary panes (px). */
export const PANE_DEFAULT = 360;
/** Under this window width the panes sit above the chat (styles.css), so there is no column to size. */
export const PANE_STACKED_BELOW = 900;
/** Share of the window the expanded browser takes; the chat keeps the rest. */
export const PANE_EXPANDED_SHARE = 0.78;

/** The widest a dragged column can be: 720 px for the small panes, up to 80% of the window for the browser. */
export function paneMax(viewport: number, browser: boolean): number {
  return browser ? Math.max(PANE_MIN, Math.floor(viewport * 0.8)) : 720;
}

/**
 * Keeps a width inside the limits.
 *
 * @param width - The wanted width in px.
 * @param viewport - The window's width in px.
 * @param browser - Whether the browser is the pane (it may be wider).
 * @returns The width, rounded.
 */
export function clampPaneWidth(width: number, viewport: number, browser: boolean): number {
  return Math.round(Math.min(paneMax(viewport, browser), Math.max(PANE_MIN, width)));
}

/**
 * The width a pane column starts with: the remembered one, or the default (the browser: 45% of a window of 1200 px
 * or more, so a 4K monitor does not get a narrow strip; smaller windows: 400 px).
 *
 * @param stored - The remembered width (from localStorage, any string or number), if any.
 * @param viewport - The window's width in px.
 * @param browser - Whether the browser is the pane.
 */
export function initialPaneWidth(stored: unknown, viewport: number, browser: boolean): number {
  const n = Number(stored);
  if (Number.isFinite(n) && n > 0) return clampPaneWidth(n, viewport, browser);
  if (!browser) return PANE_DEFAULT;
  return clampPaneWidth(viewport >= 1200 ? viewport * 0.45 : 400, viewport, true);
}

/** The width of the expanded browser (most of the window; the chat stays narrow beside it). */
export function expandedPaneWidth(viewport: number): number {
  return clampPaneWidth(viewport * PANE_EXPANDED_SHARE, viewport, true);
}
