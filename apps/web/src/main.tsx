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
