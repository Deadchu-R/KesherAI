/**
 * The phone's choice between the hub and the direct Tailscale path (packages/shared/src/direct-path.ts), bundled into
 * www/vendor/path.js by scripts/vendor.mjs. A classic script: it sets `kesherPath` on the page, so index.html and
 * cloud.html choose exactly like the computer and the hub page.
 */
import { choosePath, cleanTailscaleDirect, directUrls, hubUsable, PATH_LABELS, TAILSCALE_HINT } from "../../packages/shared/src/direct-path.ts";

(globalThis as unknown as { kesherPath: unknown }).kesherPath = { choosePath, cleanTailscaleDirect, directUrls, hubUsable, PATH_LABELS, TAILSCALE_HINT };
