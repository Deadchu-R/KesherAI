/**
 * Pure state for the on-screen overlay shown while the model controls the computer: the frame's visibility, the
 * model-cursor target with a smooth-move plan, the current step caption, and whether the user has taken over (Esc).
 * No window, no DOM — only data and a reducer fed by step events from `control-task.ts`. The desktop overlay window
 * and the phone mirror both read this state; tests cover every event without any UI.
 */

/** A point on screen, in pixels from the top-left of the primary monitor. */
export interface OverlayPoint {
  x: number;
  y: number;
}

/** A planned smooth move of the model cursor from one point to another. */
export interface OverlayCursorMove {
  /** Where the cursor starts (the previous target, or the first target when there is none). */
  start: OverlayPoint;
  /** Where the cursor ends. */
  end: OverlayPoint;
  /** When the move started, as a Unix ms timestamp (`Date.now()`). */
  startedAt: number;
  /** How long the move lasts, in milliseconds. Zero means jump instantly. */
  durationMs: number;
}

/** The model cursor as the overlay renders it. */
export interface OverlayCursor {
  /** The target the model last asked for. */
  target: OverlayPoint;
  /** The active smooth-move plan, or undefined when the cursor sits at the target. */
  move?: OverlayCursorMove;
}

/** The full overlay state. Immutable: the reducer returns a new object on every change. */
export interface OverlayState {
  /** Whether the overlay frame is visible. Off when no task is running or after `done`. */
  frameVisible: boolean;
  /** The model cursor, or undefined when no target has been set yet. */
  cursor?: OverlayCursor;
  /** The caption of the step currently running, or undefined between steps. */
  caption?: string;
  /** True once the user pressed Esc (or otherwise took over); cleared by `release`. */
  takenOver: boolean;
}

/** Event: a new step starts, with a caption and an optional cursor target. */
export interface OverlayStepStart {
  type: "step-start";
  caption: string;
  target?: OverlayPoint;
  /** Smooth-move duration in ms. Defaults to {@link OVERLAY_DEFAULT_MOVE_MS} when a target is given. */
  moveDurationMs?: number;
  /** Timestamp for the move's start; defaults to `Date.now()`. Injected in tests. */
  now?: number;
}

/** Event: the current step ends. Caption is cleared; cursor stays where it was. */
export interface OverlayStepEnd {
  type: "step-end";
}

/** Event: the user took over (Esc). Frame stays visible so they can see what the model was doing. */
export interface OverlayTakeOver {
  type: "take-over";
}

/** Event: the user released control back to the model. Clears `takenOver` only. */
export interface OverlayRelease {
  type: "release";
}

/** Event: the whole task is done. Frame hides, caption and cursor clear, takeover flag clears. */
export interface OverlayDone {
  type: "done";
}

/** Any event the overlay reducer accepts. */
export type OverlayEvent =
  | OverlayStepStart
  | OverlayStepEnd
  | OverlayTakeOver
  | OverlayRelease
  | OverlayDone;

/** Default smooth-move duration, in milliseconds. */
export const OVERLAY_DEFAULT_MOVE_MS = 250;

/** The initial overlay state: frame off, no cursor, no caption, not taken over. */
export const OVERLAY_INITIAL_STATE: OverlayState = Object.freeze({
  frameVisible: false,
  takenOver: false,
}) as OverlayState;

const point = (p: OverlayPoint): OverlayPoint => ({
  x: Number.isFinite(p.x) ? p.x : 0,
  y: Number.isFinite(p.y) ? p.y : 0,
});

/**
 * Applies one overlay event to the current state and returns the next state. Pure: no side effects, no DOM, no
 * timers. Unknown event types return the state unchanged so older clients do not crash on newer events.
 *
 * @param state - The state before the event.
 * @param event - The event to apply.
 * @returns The next state (a new object when anything changed, the same reference otherwise).
 */
export function overlayReduce(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "step-start": {
      const caption = typeof event.caption === "string" ? event.caption.trim() : "";
      const target = event.target ? point(event.target) : state.cursor?.target;
      const cursor: OverlayCursor | undefined = target
        ? {
            target,
            move:
              state.cursor && (state.cursor.target.x !== target.x || state.cursor.target.y !== target.y)
                ? {
                    start: state.cursor.move ? cursorPosAt(state.cursor, event.now ?? Date.now()) : state.cursor.target,
                    end: target,
                    startedAt: event.now ?? Date.now(),
                    durationMs: Math.max(0, event.moveDurationMs ?? OVERLAY_DEFAULT_MOVE_MS),
                  }
                : undefined,
          }
        : state.cursor;
      return { ...state, frameVisible: true, caption: caption || undefined, cursor };
    }
    case "step-end":
      return state.caption === undefined ? state : { ...state, caption: undefined };
    case "take-over":
      return state.takenOver ? state : { ...state, takenOver: true };
    case "release":
      return state.takenOver ? { ...state, takenOver: false } : state;
    case "done":
      if (!state.frameVisible && !state.cursor && !state.caption && !state.takenOver) return state;
      return { ...OVERLAY_INITIAL_STATE };
    default:
      return state;
  }
}

/**
 * Returns the cursor position at a given time along its current move plan, or the target when there is no active
 * move or the move has finished. Useful for rendering between events without re-running the reducer.
 *
 * @param cursor - The cursor to sample.
 * @param now - The current time, as a Unix ms timestamp.
 * @returns The interpolated position, or the target.
 */
export function cursorPosAt(cursor: OverlayCursor, now: number): OverlayPoint {
  if (!cursor.move) return cursor.target;
  const { start, end, startedAt, durationMs } = cursor.move;
  if (durationMs <= 0 || now >= startedAt + durationMs) return end;
  if (now <= startedAt) return start;
  const t = (now - startedAt) / durationMs;
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}