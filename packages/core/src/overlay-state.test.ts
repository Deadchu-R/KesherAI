import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERLAY_INITIAL,
  overlayCaption,
  overlayFromStep,
  overlayReducer,
  type OverlayEvent,
  type OverlayState,
} from "./overlay-state.js";

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

test("OVERLAY_INITIAL is invisible and empty", () => {
  assert.equal(OVERLAY_INITIAL.visible, false);
  assert.equal(OVERLAY_INITIAL.cursor, null);
  assert.equal(OVERLAY_INITIAL.caption, "");
  assert.equal(OVERLAY_INITIAL.takeover, false);
  assert.equal(OVERLAY_INITIAL.bubble, null);
});

// ---------------------------------------------------------------------------
// Reducer — step lifecycle
// ---------------------------------------------------------------------------

test("step_start shows overlay with caption, clears bubble", () => {
  const st = overlayReducer(OVERLAY_INITIAL, { type: "step_start", caption: "press Button 'OK'" });
  assert.equal(st.visible, true);
  assert.equal(st.caption, "press Button 'OK'");
  assert.equal(st.bubble, null);
  assert.equal(st.cursor, null);
  assert.equal(st.takeover, false);
});

test("step_end clears caption, cursor and bubble but keeps visible", () => {
  const ev: OverlayEvent[] = [
    { type: "step_start", caption: "click 100,200" },
    { type: "cursor_move", x: 100, y: 200 },
    { type: "step_end" },
  ];
  const st = ev.reduce(overlayReducer, OVERLAY_INITIAL);
  assert.equal(st.caption, "");
  assert.equal(st.cursor, null);
  assert.equal(st.bubble, null);
  assert.equal(st.visible, true);
});

// ---------------------------------------------------------------------------
// Reducer — cursor
// ---------------------------------------------------------------------------

test("cursor_move shows overlay and sets cursor", () => {
  const st = overlayReducer(OVERLAY_INITIAL, { type: "cursor_move", x: 400, y: 300 });
  assert.equal(st.visible, true);
  assert.deepEqual(st.cursor, { x: 400, y: 300 });
});

test("cursor_move updates existing cursor", () => {
  const ev: OverlayEvent[] = [
    { type: "cursor_move", x: 10, y: 20 },
    { type: "cursor_move", x: 99, y: 88 },
  ];
  const st = ev.reduce(overlayReducer, OVERLAY_INITIAL);
  assert.deepEqual(st.cursor, { x: 99, y: 88 });
});

// ---------------------------------------------------------------------------
// Reducer — takeover
// ---------------------------------------------------------------------------

test("takeover_on sets takeover flag", () => {
  const st = overlayReducer({ ...OVERLAY_INITIAL, visible: true }, { type: "takeover_on" });
  assert.equal(st.takeover, true);
});

test("takeover_off clears takeover flag", () => {
  const st = overlayReducer({ ...OVERLAY_INITIAL, visible: true, takeover: true }, { type: "takeover_off" });
  assert.equal(st.takeover, false);
});

// ---------------------------------------------------------------------------
// Reducer — bubble
// ---------------------------------------------------------------------------

test("bubble_show shows overlay and bubble", () => {
  const st = overlayReducer(OVERLAY_INITIAL, {
    type: "bubble_show",
    text: "Open this file?",
    x: 500,
    y: 400,
  });
  assert.equal(st.visible, true);
  assert.deepEqual(st.bubble, { text: "Open this file?", x: 500, y: 400 });
});

test("bubble_hide clears bubble only", () => {
  const ev: OverlayEvent[] = [
    { type: "bubble_show", text: "Yes?", x: 10, y: 10 },
    { type: "bubble_hide" },
  ];
  const st = ev.reduce(overlayReducer, OVERLAY_INITIAL);
  assert.equal(st.bubble, null);
  assert.equal(st.visible, true);
});

// ---------------------------------------------------------------------------
// Reducer — hide
// ---------------------------------------------------------------------------

test("hide resets to initial state", () => {
  const st: OverlayState = {
    visible: true,
    cursor: { x: 1, y: 1 },
    caption: "foo",
    takeover: true,
    bubble: { text: "q", x: 0, y: 0 },
  };
  const next = overlayReducer(st, { type: "hide" });
  assert.deepEqual(next, OVERLAY_INITIAL);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("overlayFromStep builds state from caption", () => {
  const st = overlayFromStep("press Button 'Library'");
  assert.equal(st.visible, true);
  assert.equal(st.caption, "press Button 'Library'");
  assert.equal(st.cursor, null);
  assert.equal(st.bubble, null);
});

test("overlayFromStep with coordinates sets cursor", () => {
  const st = overlayFromStep("click target", 300, 250);
  assert.deepEqual(st.cursor, { x: 300, y: 250 });
});

test("overlayCaption returns short text as-is", () => {
  const st = { ...OVERLAY_INITIAL, caption: "press Button 'OK'" };
  assert.equal(overlayCaption(st), "press Button 'OK'");
});

test("overlayCaption trims long text to 60 chars with ellipsis", () => {
  const long = "a".repeat(80);
  const st = { ...OVERLAY_INITIAL, caption: long };
  const cap = overlayCaption(st);
  assert.equal(cap.length, 60);
  assert.equal(cap.slice(-1), "…");
});

// ---------------------------------------------------------------------------
// Integration: phone's ControlLive.tsx reads the same caption string
// ---------------------------------------------------------------------------

test("caption from reducer matches overlayCaption for phone display", () => {
  const st = overlayReducer(OVERLAY_INITIAL, {
    type: "step_start",
    caption: "press Button 'Library'",
  });
  assert.equal(overlayCaption(st), st.caption);
});

test("full step lifecycle: start → cursor → step_end → hide", () => {
  const ev: OverlayEvent[] = [
    { type: "step_start", caption: "press Button 'Library'" },
    { type: "cursor_move", x: 120, y: 80 },
    { type: "step_end" },
    { type: "hide" },
  ];
  const st = ev.reduce(overlayReducer, OVERLAY_INITIAL);
  assert.deepEqual(st, OVERLAY_INITIAL);
});
