/**
 * Opens a web page through a SOCKS5 proxy (Tor's), with no extra library: SOCKS5 CONNECT by host name (so the
 * name is looked up at the far end, past a DNS block), TLS for https, then a plain HTTP/1.1 GET with chunked and
 * gzip/deflate/br bodies and up to 5 redirects. Only what web_fetch needs.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** A page read through the proxy. */
export interface ProxiedPage {
  /** The address after redirects. */
  url: string;
  status: number;
  type: string;
  body: string;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reads exactly `n` bytes (for the SOCKS handshake). The socket is left paused with any extra bytes put back, so
 * nothing is lost before the next reader listens (it resumes it).
 */
function readBytes(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        sock.off("data", onData);
        sock.off("error", reject);
        sock.pause();
        if (buf.length > n) sock.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      }
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.resume();
  });
}

/**
 * A SOCKS5 tunnel to host:port (no authentication).
 *
 * @returns The connected socket, ready for TLS or HTTP.
 */
export async function socksConnect(proxy: { host: string; port: number }, host: string, port: number, signal?: AbortSignal): Promise<Socket> {
  const sock = netConnect(proxy.port, proxy.host);
  const abort = () => sock.destroy(new Error("Stopped."));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    sock.write(Buffer.from([5, 1, 0]));
    const hello = await readBytes(sock, 2);
    if (hello[0] !== 5 || hello[1] !== 0) throw new Error("The proxy refused the connection.");
    const name = Buffer.from(host, "utf8");
    if (name.length > 255) throw new Error("Host name too long.");
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    const head = await readBytes(sock, 4);
    if (head[1] !== 0) throw new Error(`The proxy could not reach ${host} (SOCKS error ${head[1]}).`);
    const rest = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readBytes(sock, 1))[0]!;
    await readBytes(sock, rest + 2);
    return sock;
  } catch (err) {
    sock.destroy();
    throw err;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Splits a raw HTTP/1.1 response into status, headers and body (chunked bodies joined).
 *
 * @param raw - The whole response.
 */
export function parseHttpResponse(raw: Buffer): { status: number; headers: Record<string, string>; body: Buffer } {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("The page sent no headers.");
  const lines = raw.subarray(0, end).toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  let body = raw.subarray(end + 4);
  if (/chunked/i.test(headers["transfer-encoding"] ?? "")) {
    const parts: Buffer[] = [];
    let at = 0;
    while (at < body.length) {
      const nl = body.indexOf("\r\n", at);
      if (nl < 0) break;
      const size = parseInt(body.subarray(at, nl).toString("latin1"), 16);
      if (!size) break;
      parts.push(body.subarray(nl + 2, nl + 2 + size));
      at = nl + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  const enc = (headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "gzip") body = gunzipSync(body);
  else if (enc === "deflate") body = inflateSync(body);
  else if (enc === "br") body = brotliDecompressSync(body);
  return { status, headers, body };
}

/** One GET through the proxy (no redirects). */
async function getOnce(proxy: { host: string; port: number }, url: URL, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const https = url.protocol === "https:";
  const port = Number(url.port) || (https ? 443 : 80);
  const raw = await socksConnect(proxy, url.hostname, port, signal);
  const sock: Socket = https ? tlsConnect({ socket: raw, servername: url.hostname, ALPNProtocols: ["http/1.1"] }) : raw;
  const abort = () => sock.destroy(new Error("Stopped."));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (https) await new Promise<void>((resolve, reject) => {
      sock.once("secureConnect", resolve);
      sock.once("error", reject);
    });
    sock.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: Mozilla/5.0 (KesherAI)\r\nAccept: text/html,application/xhtml+xml,*/*;q=0.8\r\nAccept-Encoding: gzip, deflate, br\r\nConnection: close\r\n\r\n`);
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      sock.on("data", (d: Buffer) => {
        size += d.length;
        if (size > MAX_BYTES) return sock.destroy(new Error("The page is too big."));
        chunks.push(d);
      });
      sock.once("end", resolve);
      sock.once("close", () => resolve());
      sock.once("error", reject);
      sock.resume();
    });
    return parseHttpResponse(Buffer.concat(chunks));
  } finally {
    signal?.removeEventListener("abort", abort);
    sock.destroy();
  }
}

/**
 * Reads a page through a SOCKS5 proxy, following up to 5 redirects.
 *
 * @param proxy - The proxy (Tor: 127.0.0.1 and its SocksPort).
 * @param address - An http(s) address.
 */
export async function fetchViaSocks(proxy: { host: string; port: number }, address: string, signal?: AbortSignal): Promise<ProxiedPage> {
  let url = new URL(address);
  for (let hop = 0; hop < 6; hop++) {
    const r = await getOnce(proxy, url, signal);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The page redirected to a non-web address.");
      continue;
    }
    return { url: url.href, status: r.status, type: r.headers["content-type"] ?? "", body: r.body.toString("utf8") };
  }
  throw new Error("Too many redirects.");
}
