#!/usr/bin/env node
/**
 * Command-line entry: `kesher-core [--port 7420] [--web ./apps/web/dist] [--plugins ./plugins]`.
 *
 * The desktop app does not use this file; it imports `createKesherServer`
 * directly. This entry is for development (`pnpm dev`), headless machines
 * and running Kesher on a home server.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { branding } from "@kesher/shared";
import { createKesherServer } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    web: { type: "string" },
    plugins: { type: "string", multiple: true },
    "data-dir": { type: "string" },
    "no-autodetect": { type: "boolean" },
    verbose: { type: "boolean" },
  },
});

const server = await createKesherServer({
  ...(values.port ? { port: Number(values.port) } : {}),
  ...(values.web ? { webDir: resolve(values.web) } : {}),
  ...(values["data-dir"] ? { dataDir: resolve(values["data-dir"]) } : {}),
  pluginRoots: (values.plugins ?? [resolve(import.meta.dirname, "../../../plugins")]).map((p) => resolve(p)),
  ...(values["no-autodetect"] ? { autodetect: false } : {}),
  logger: !!values.verbose,
});

const url = await server.listen();
const { services } = server;
console.log(`${branding.productName} core listening on ${url}`);
console.log(`  data folder: ${services.paths.root}`);
console.log(`  providers:   ${services.registry.list().map((p) => p.config.id).join(", ") || "(none yet)"}`);
console.log(`  plugins:     ${services.plugins.list().map((p) => `${p.manifest.id} (${p.status})`).join(", ") || "(none)"}`);
if (services.config.remote.enabled) console.log("  remote access is ON — other devices need the token from /api/remote");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
