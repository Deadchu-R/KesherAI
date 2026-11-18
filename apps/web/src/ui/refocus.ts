import { desktop } from "../library";

/**
 * In the desktop app, after every `confirm()` and `alert()`, gives the keyboard back to the page. Electron on Windows
 * leaves the page without keyboard focus once a system dialog closes, so the chat box (and every other field) took no
 * typing until the window was switched away and back (found by Roee's brother: delete a chat, then New chat). One
 * place for the app's dozens of confirms; a browser or the phone app is left as it is.
 */
export function refocusAfterDialogs(): void {
  const refocus = desktop()?.refocus;
  if (!refocus) return;
  const wrap = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    try {
      return fn(...args);
    } finally {
      refocus();
    }
  };
  window.confirm = wrap(window.confirm.bind(window));
  window.alert = wrap(window.alert.bind(window));
}
