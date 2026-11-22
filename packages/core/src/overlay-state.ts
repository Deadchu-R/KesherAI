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
}

/** Initial empty state. */
export const OVERLAY_INITIAL: OverlayState = {
  visible: false,
  cursor: null,
  caption: "",
  takeover: false,
  bubble: null,
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
      };

    case "cursor_move":
      return {
        ...state,
        visible: true,
        cursor: { x: event.x, y: event.y },
      };

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
  return {
    visible: true,
    cursor: x !== undefined && y !== undefined ? { x, y } : null,
    caption,
    takeover: false,
    bubble: null,
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
