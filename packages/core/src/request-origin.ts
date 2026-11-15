/**
 * Where a request comes from: this computer (not through a tunnel) or a paired device.
 * Kept apart from auth.ts so routes can ask without pulling in the auth hook.
 */
import { hostname } from "node:os";
import type { FastifyRequest } from "fastify";

/**
 * Whether a request comes from this computer.
 *
 * @param ip - `request.ip`.
 * @returns `true` for IPv4/IPv6 loopback addresses.
 */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Headers a tunnel or proxy adds. A request carrying one came from outside, even if it reached us over 127.0.0.1. */
const FORWARDED = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-proto", "tailscale-user-login", "tailscale-headers-info", "tailscale-funnel-request"];

/**
 * Whether a request really comes from this computer: from a loopback
 * address and not forwarded by a tunnel (Cloudflare connects over
 * 127.0.0.1, so the address alone is not enough).
 *
 * @param request - The request.
 * @returns `true` only for requests made on this computer.
 */
export function isLocalRequest(request: Pick<FastifyRequest, "ip" | "headers">): boolean {
  return isLoopback(request.ip) && !FORWARDED.some((h) => request.headers[h] !== undefined) && localHost(request.headers.host);
}

/**
 * Whether the address the browser used is this computer's own name. A page
 * on another site can make its name point at 127.0.0.1 (DNS rebinding); its
 * requests then come from this computer but carry that site's name, so they
 * are not trusted as local.
 *
 * @param host - The Host header.
 * @returns Whether it names this computer.
 */
export function localHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "::1" || name === hostname().toLowerCase() || name === `${hostname().toLowerCase()}.local`;
}

/** The paired device a request came in with (its own key), if any. */
const pairedDevice = new WeakMap<object, string>();

/** @returns The name of the paired device that sent this request (with its own key), or undefined. */
export function pairedDeviceOf(request: Pick<FastifyRequest, "raw">): string | undefined {
  return pairedDevice.get(request.raw);
}

const pairedDeviceId = new WeakMap<object, string>();

/** @returns The id of the paired device that sent this request (with its own key), or undefined. */
export function pairedDeviceIdOf(request: Pick<FastifyRequest, "raw">): string | undefined {
  return pairedDeviceId.get(request.raw);
}

/**
 * Remembers which paired device sent a request (called by the auth check once its key matched).
 *
 * @param raw - The request's raw Node request.
 * @param name - The device's name.
 * @param id - The device's id, when it has one.
 */
export function markPairedDevice(raw: object, name: string, id?: string): void {
  pairedDevice.set(raw, name);
  if (id) pairedDeviceId.set(raw, id);
}
