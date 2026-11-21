/**
 * Renders the design doc's boards from tools/design/scenarios (see packages/core/src/design-render.ts):
 *   node --conditions=source --import tsx tools/design/render.ts [BoardId ...]
 * DESIGN_OUT=<folder> writes there instead of tools/design/out/kesher. Needs a build (pnpm build). Writes tools/design/out/kesher/; Claude publishes its publish.json (docs/HANDOFF.md).
 */
import { resolve } from "node:path";
import { renderDesign } from "../../packages/core/src/design-render.js";

const repo = resolve(import.meta.dirname, "../..");
const only = process.argv.slice(2);
const r = await renderDesign({ repo, ...(process.env.DESIGN_OUT ? { out: resolve(process.env.DESIGN_OUT) } : {}), ...(only.length ? { only } : {}), log: (l) => console.log(l) });
console.log(JSON.stringify({ added: r.diff.added, changed: r.diff.changed, same: r.diff.same.length, errors: r.errors }, null, 1));
if (r.errors.length) process.exitCode = 1;
