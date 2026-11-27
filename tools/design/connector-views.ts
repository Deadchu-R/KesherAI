/**
 * Renders the Claude connector's MCP App views (apps/hub/src/connector-views.ts) with sample data into
 * tools/design/out/connector/<view>-<width>.png, so the design doc can show them:
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --conditions=source --import tsx tools/design/connector-views.ts [approvals]
 * The page runs as a top-level page, so it is its own "host": the sample tool result is posted to it as the host would.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { VIEWS, VIEW_URIS } from "../../apps/hub/src/connector-views.js";

const out = resolve(import.meta.dirname, "out/connector");
mkdirSync(out, { recursive: true });

const SAMPLES: Record<string, { name: string; data: unknown }> = {
  approvals: {
    name: VIEW_URIS.approvals,
    data: {
      pc: "Desk",
      canAnswer: true,
      approvals: [
        { conversationId: "c-1", requestId: "q-1", title: "Fix the hub page", tool: "run_command", who: "", reason: "Runs a command in the project folder.", preview: "pnpm -s typecheck && pnpm -s lint", forWhile: true, at: "2026-11-27T09:41:00.000Z" },
        { conversationId: "c-1", requestId: "q-2", title: "Fix the hub page", tool: "edit_file", who: "Port the plugin (sub-agent)", reason: "Changes a file.", preview: "--- apps/hub/src/mcp.ts\n+++ apps/hub/src/mcp.ts\n@@ -41,3 +41,4 @@\n const READ_ONLY = { readOnlyHint: true };\n+const NO_INPUT = { type: \"object\" };", forWhile: true, at: "2026-11-27T09:43:00.000Z" },
        { conversationId: "c-2", requestId: "q-3", title: "Clean the build folder", tool: "run_command", reason: "This command deletes files, so it always needs your approval.", preview: "rm -rf dist build", locked: true, at: "2026-11-27T09:44:00.000Z" },
      ],
    },
  },
};

const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [key, sample] of Object.entries(SAMPLES)) {
  if (only.length && !only.includes(key)) continue;
  const view = VIEWS.find((v) => v.uri === sample.name)!;
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
    await page.setContent(view.html);
    // A string, not a function: the TypeScript loader adds helpers a page does not have.
    await page.evaluate(`(function(data){
      function send(m){window.dispatchEvent(new MessageEvent("message",{data:m,source:window}))}
      send({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params:{locale:"en",theme:"dark"}});
      send({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:data}});
    })(${JSON.stringify(sample.data)})`);
    await page.screenshot({ path: resolve(out, `${key}-${width}.png`), fullPage: true });
    console.log(`${key}-${width}.png`, await page.evaluate(() => `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`));
    await page.close();
  }
}
await browser.close();
