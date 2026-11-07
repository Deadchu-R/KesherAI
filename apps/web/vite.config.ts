import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";

// In development the UI runs on Vite (port 5173) and talks to the core
// server (port 7420) through this proxy. In production the core server
// serves the built UI itself, so the same relative URLs work.
export default defineConfig({
  plugins: [react()],
  // "source" makes workspace packages resolve to their TypeScript sources,
  // so editing @kesher/shared reloads the UI without a build step.
  resolve: { conditions: ["source", ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7420",
      "/v1": "http://127.0.0.1:7420",
    },
  },
  base: "./",
});
