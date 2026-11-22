/**
 * Small HTTP helpers for the hub: JSON answers with the security headers, a capped body reader, cookies.
 */
import { HUB_LIMITS } from "../../../packages/shared/src/hub.js";

/** The session cookie's name (`__Host-`: Secure, Path=/, no Domain). */
export const SESSION_COOKIE = "__Host-kh_s";

/** Headers every answer carries (strict CSP, no framing, no sniffing, no referrer). */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/ https://www.googleapis.com https://rest.ably.io wss://realtime.ably.io https://*.supabase.co wss://*.supabase.co; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * A JSON answer.
 *
 * @param body - What to send.
 * @param status - The status.
 * @param extra - More headers (e.g. Set-Cookie).
 * @returns The response.
 */
export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
}

/**
 * Reads a JSON body of at most 16 KB.
 *
 * @param req - The request.
 * @returns The object, or undefined when it is missing, too big or not JSON.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(req.headers.get("content-length") ?? 0) > HUB_LIMITS.frameChars) return undefined;
  const text = await req.text();
  if (text.length > HUB_LIMITS.frameChars) return undefined;
  try {
    const x = JSON.parse(text || "{}") as unknown;
    return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One cookie's value.
 *
 * @param req - The request.
 * @param name - The cookie.
 * @returns Its value, if sent.
 */
export function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/**
 * The Set-Cookie value for a session (HttpOnly, Secure, SameSite=Strict, 30 days at most), or one that clears it.
 *
 * @param value - The session id, or undefined to clear.
 * @returns The header value.
 */
export function sessionCookie(value: string | undefined): string {
  return value ? `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 3600}` : `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * The bearer token of a request.
 *
 * @param req - The request.
 * @returns The token, if any.
 */
export function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/**
 * Whether a state-changing browser request comes from the hub's own page (CSRF guard next to SameSite=Strict).
 *
 * @param req - The request.
 * @returns True when `Origin` equals the hub's origin.
 */
export function sameOrigin(req: Request): boolean {
  return req.headers.get("origin") === new URL(req.url).origin;
}
