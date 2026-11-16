/** MCP Apps: the page a tool's view runs in (no browser parts, so it is tested in node). */

/**
 * The page a view runs in: its HTML with a Content-Security-Policy put first in `<head>` (MCP Apps' default: nothing
 * from outside except the domains the server named for loading and connecting).
 *
 * @param html - The view, as the server sent it.
 * @param csp - Domains the server asked for.
 */
export function appDocument(html: string, csp: { connect: string[]; resource: string[] }): string {
  const res = csp.resource.join(" ");
  const policy = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${res}`.trim(),
    `style-src 'self' 'unsafe-inline' ${res}`.trim(),
    `connect-src 'self' ${csp.connect.join(" ")}`.trim(),
    `img-src 'self' data: ${res}`.trim(),
    `font-src 'self' ${res}`.trim(),
    `media-src 'self' data: ${res}`.trim(),
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}
