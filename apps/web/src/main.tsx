import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getLocale, setLocale } from "./i18n";
import "./styles.css";

setLocale(getLocale());

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
