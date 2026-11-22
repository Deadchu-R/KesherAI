/**
 * Pure model for the overlay shown on top of the screen while a computer task runs
 * (docs/research/SYNTHESIS-2026-11-22.md CD-1).
 *
 * The overlay has two parts:
 * 1. A **cursor** at the model's target in OS pixels (so the user sees where the next action will land).
 * 2. A **caption** with the step's short text and an optional **bubble** for yes/no confirmation.
 *
 * This file is pure: no Electron, no DOM, no timers.  The window (CD-2) reads this state and paints it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One yes/no bubble the overlay shows while waiting for the user. */
export interface PendingBubble {
  /** Short question shown in the bubble, e.g. "Open this file?". */
  text: string;
  /** Where the bubble sits (OS pixels, top-left of the bubble rect). */
  x: number;
  y: number;
}

/** The complete overlay state.  Reduced from control-task steps. */
export interface OverlayState {
  /** Whether the overlay frame is visible at all. */
  visible: boolean;
  /** The model's cursor target in OS pixels (null when no target). */
  cursor: { x: number; y: number } | null;
  /** Short caption for the current step, e.g. "press Button 'Library'". */
  caption: string;
  /** True when the user took over the keyboard/mouse (overlay stays but does nothing). */
  takeover: boolean;
  /** A pending yes/no bubble (null when none). */
  bubble: PendingBubble | null;
  /** Target cursor position for smooth animation (set by cursor_move). */
  targetCursor: { x: number; y: number } | null;
  /** Display cursor position (interpolated toward targetCursor each tick). */
  displayCursor: { x: number; y: number } | null;
  /** Remaining delay in ms before cursor starts moving (human pacing). */
  paceDelay: number;
}

/** Initial empty state. */
export const OVERLAY_INITIAL: OverlayState = {
  visible: false,
  cursor: null,
  caption: "",
  takeover: false,
  bubble: null,
  targetCursor: null,
  displayCursor: null,
  paceDelay: 0,
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Events fed into the overlay from the control-task pipeline.
 *
 * - `step_start` / `step_end`: a control-task step begins or finishes.
 * - `cursor_move`: the model picked a target pixel for the next action.
 * - `takeover_on` / `takeover_off`: the user grabbed the keyboard/mouse.
 * - `bubble_show` / `bubble_hide`: ask the user yes/no or clear it.
 * - `hide`: turn the overlay off completely.
 */
export type OverlayEvent =
  | { type: "step_start"; caption: string }
  | { type: "step_end" }
  | { type: "cursor_move"; x: number; y: number }
  | { type: "takeover_on" }
  | { type: "takeover_off" }
  | { type: "bubble_show"; text: string; x: number; y: number }
  | { type: "bubble_hide" }
  | { type: "hide" };

/**
 * Reduce one event into a new overlay state (immutable).
 *
 * @param state - The current overlay state.
 * @param event - The event to apply.
 * @returns A new {@link OverlayState}.
 */
export function overlayReducer(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "step_start":
      return {
        ...state,
        visible: true,
        caption: event.caption,
        bubble: null,
      };

    case "step_end":
      return {
        ...state,
        caption: "",
        bubble: null,
        cursor: null,
        targetCursor: null,
        displayCursor: null,
        paceDelay: 0,
      };

    case "cursor_move":
      return overlayCursorMove({ ...state, visible: true }, event.x, event.y);

    case "takeover_on":
      return { ...state, takeover: true };

    case "takeover_off":
      return { ...state, takeover: false };

    case "bubble_show":
      return {
        ...state,
        visible: true,
        bubble: { text: event.text, x: event.x, y: event.y },
      };

    case "bubble_hide":
      return { ...state, bubble: null };

    case "hide":
      return { ...OVERLAY_INITIAL };
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure, for the phone's ControlLive.tsx to share)
// ---------------------------------------------------------------------------

/**
 * Build an overlay state directly from a control-task step (for quick display
 * without running the full reducer).
 *
 * @param caption - The step's action string, e.g. "press Button 'Library'".
 * @param x - Target x in OS pixels (optional).
 * @param y - Target y in OS pixels (optional).
 */
export function overlayFromStep(caption: string, x?: number, y?: number): OverlayState {
  const c = x !== undefined && y !== undefined ? { x, y } : null;
  return {
    visible: true,
    cursor: c,
    caption,
    takeover: false,
    bubble: null,
    targetCursor: c,
    displayCursor: c,
    paceDelay: 0,
  };
}

/**
 * Short caption for the phone's live banner: the step text trimmed to 60 chars.
 *
 * @param state - The overlay state.
 */
export function overlayCaption(state: OverlayState): string {
  return state.caption.length > 60 ? state.caption.slice(0, 59) + "…" : state.caption;
}

// ---------------------------------------------------------------------------
// Animation helpers (pure, tick-driven)
// ---------------------------------------------------------------------------

/** How many ms the overlay waits before starting a move (human pacing). */
const PACE_DELAY_MS = 400;

/** Lerp factor per tick at 60 fps (cursor reaches target in ~200 ms). */
const CURSOR_LERP = 0.15;

/**
 * Advance the overlay state by `dt` milliseconds.
 * Handles the human pacing delay and smooth cursor interpolation.
 *
 * @param state - The current overlay state.
 * @param dt - Delta time in milliseconds since the last tick.
 * @returns A new state with displayCursor and paceDelay updated.
 */
export function overlayTick(state: OverlayState, dt: number): OverlayState {
  if (!state.targetCursor || !state.displayCursor) return state;

  // Still waiting for the pacing delay?
  if (state.paceDelay > 0) {
    return { ...state, paceDelay: Math.max(0, state.paceDelay - dt) };
  }

  // Smooth interpolation toward target
  const dx = state.targetCursor.x - state.displayCursor.x;
  const dy = state.targetCursor.y - state.displayCursor.y;
  const nx = state.displayCursor.x + dx * CURSOR_LERP;
  const ny = state.displayCursor.y + dy * CURSOR_LERP;

  // Snap when close enough
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    return { ...state, displayCursor: { ...state.targetCursor } };
  }

  return {
    ...state,
    displayCursor: { x: nx, y: ny },
  };
}

/**
 * Apply a cursor_move event and set up the smooth animation.
 * Resets the display cursor to the current position and sets a new target
 * with a human pacing delay.
 *
 * @param state - The current overlay state.
 * @param x - Target x in OS pixels.
 * @param y - Target y in OS pixels.
 * @returns A new state ready for overlayTick to animate.
 */
export function overlayCursorMove(state: OverlayState, x: number, y: number): OverlayState {
  const target = { x, y };
  const display = state.displayCursor ?? state.cursor ?? target;

  return {
    ...state,
    cursor: target,
    targetCursor: target,
    displayCursor: display,
    paceDelay: PACE_DELAY_MS,
  };
}
