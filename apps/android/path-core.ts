/**
 * The phone's choice between the hub and the direct Tailscale path (packages/shared/src/direct-path.ts), bundled into
 * www/vendor/path.js by scripts/vendor.mjs. A classic script: it sets `kesherPath` on the page, so index.html and
 * cloud.html choose exactly like the computer and the hub page. With it, the "why does it not connect" reasons and
 * the Tailscale connect call (packages/shared/src/connect-why.ts) as `kesherWhy`.
 */
import { choosePath, cleanTailscaleDirect, directUrls, hubUsable, PATH_LABELS, TAILSCALE_HINT } from "../../packages/shared/src/direct-path.ts";

import { addAttempt, attemptLines, CHECK_LABELS, cleanAttempts, connectChecks, connectTailscale, diagnoseConnection, shouldAutoTailscale } from "../../packages/shared/src/connect-why.ts";

(globalThis as unknown as { kesherPath: unknown }).kesherPath = { choosePath, cleanTailscaleDirect, directUrls, hubUsable, PATH_LABELS, TAILSCALE_HINT };
(globalThis as unknown as { kesherWhy: unknown }).kesherWhy = { addAttempt, attemptLines, CHECK_LABELS, cleanAttempts, connectChecks, connectTailscale, diagnoseConnection, shouldAutoTailscale };
