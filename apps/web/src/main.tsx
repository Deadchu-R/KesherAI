import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getLocale, setLocale } from "./i18n";
import "@fontsource/rubik/400.css";
import "@fontsource/rubik/500.css";
import "@fontsource/rubik/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import { startPhoneShare } from "./phone";
import { installSlideMenus } from "./slideMenus";
import { loadAppearance } from "./appearance";

setLocale(getLocale());
// Pages refresh themselves every few seconds; in a hidden tab (or the phone app in the background)
// those refreshes wait until it shows again, which saves battery and the computer's work.
// Short timers (one second, like a recording's clock) keep running.
{
  const every = window.setInterval.bind(window);
  window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    typeof fn === "function" && (ms ?? 0) >= 1500 ? every(() => !document.hidden && (fn as (...a: unknown[]) => void)(...args), ms) : every(fn, ms, ...args)) as typeof window.setInterval;
}
// The look the user picked (Settings → Appearance, or "make it light" in a chat).
loadAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable on phones: register the service worker (not during development,
// where it would fight Vite's hot reload).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => void navigator.serviceWorker.register("./sw.js").catch(() => undefined));
}

// Inside the Android app: things shared from other apps, and the home-screen widget.
startPhoneShare();
// Press a menu button, slide to an item, let go to choose it.
installSlideMenus();

// Inside the Android app: scanning another computer's QR code while connected
// (kesherai://connect?server=…) switches to that computer.
type DeepLinkApp = { addListener(event: "appUrlOpen", cb: (e: { url: string }) => void): unknown };
const androidApp = (window as unknown as { Capacitor?: { Plugins?: { App?: DeepLinkApp } } }).Capacitor?.Plugins?.App;
androidApp?.addListener("appUrlOpen", ({ url }) => {
  try {
    const server = new URL(url).searchParams.get("server");
    if (server && /^https?:\/\//.test(server)) {
      try {
        localStorage.setItem("kesherai-server", server);
      } catch {
        // the saved link is only a convenience
      }
      location.href = server;
    }
  } catch {
    // not a KesherAI link
  }
});
