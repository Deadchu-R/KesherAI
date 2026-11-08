import { test } from "node:test";
import assert from "node:assert/strict";
import { figmaTokens, parseFigmaLink } from "./figma.js";

test("Figma links, and tokens from Variables or (without them) from styles", async () => {
  assert.deepEqual(parseFigmaLink("https://www.figma.com/design/AbCdEfGhIjKlMn/My-UI?node-id=12-34&t=x"), { key: "AbCdEfGhIjKlMn", node: "12:34" });
  assert.equal(parseFigmaLink("https://evil.example/design/AbCdEfGhIjKlMn"), undefined);
  assert.equal(parseFigmaLink("http://www.figma.com/design/AbCdEfGhIjKlMn"), undefined);

  const asked: string[] = [];
  const styles = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    asked.push(url);
    assert.equal((init?.headers as Record<string, string>)["x-figma-token"], "tok", "the token goes in a header");
    if (url.includes("?depth=1")) return Response.json({ name: "Shop UI" });
    if (url.includes("/variables/local")) return new Response("{}", { status: 403 });
    if (url.endsWith("/styles")) return Response.json({ meta: { styles: [{ node_id: "1:1", name: "Background", style_type: "FILL" }, { node_id: "1:2", name: "Body", style_type: "TEXT" }] } });
    return Response.json({ nodes: { "1:1": { document: { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0.5 } }] } }, "1:2": { document: { style: { fontFamily: "Inter" } } } } });
  }) as unknown as typeof fetch;
  const r = await figmaTokens("tok", "AbCdEfGhIjKlMn", styles);
  assert.equal(r.from, "styles");
  assert.deepEqual(r.tokens, [{ name: "Background", $value: "#000080" }, { name: "Body font-family", $value: "Inter" }]);
  assert.ok(asked.every((u) => u.startsWith("https://api.figma.com/v1/")) && asked.every((u) => !u.includes("tok")));
});
