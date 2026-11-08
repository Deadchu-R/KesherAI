/**
 * Connecting this desktop app to another computer that runs KesherAI (a
 * laptop opening the home PC): the other computer opens in a window of its
 * own, apart from this one's.
 *
 * Safety:
 * - That window has no bridge to this computer (no preload): the other
 *   computer's page cannot pick files, run programs or reach anything here.
 * - It has its own storage (partition), stays on that computer's address
 *   (other links open in the browser) and is refused every permission but
 *   the microphone and copying to the clipboard.
 * - Only https addresses, or http on a home network / Tailscale address.
 * - The shared token is traded for a key of this device's own when the
 *   other computer allows it, and keys are saved encrypted by the system
 *   (Windows DPAPI, macOS Keychain) when it can.
 */
import { app, BrowserWindow, safeStorage, session, shell } from "electron";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export interface SavedComputer {
  name: string;
  origin: string;
  /** The key, encrypted when the system can ("enc:" + base64). */
  key: string;
}

const file = () => join(app.getPath("userData"), "computers.json");

async function load(): Promise<SavedComputer[]> {
  try {
    const list = JSON.parse(await readFile(file(), "utf8")) as SavedComputer[];
    return Array.isArray(list) ? list.filter((c) => typeof c?.origin === "string" && typeof c.key === "string") : [];
  } catch {
    return [];
  }
}
const save = (list: SavedComputer[]) => writeFile(file(), JSON.stringify(list, null, 2), { mode: 0o600 });

const seal = (key: string) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(key).toString("base64")}` : key);
const unseal = (key: string) => (key.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(key.slice(4), "base64")) : key);

/** Whether an address is on a home network, Tailscale or this computer (http is allowed only there). */
export function privateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".ts.net")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Reads a link to another computer ("https://x.trycloudflare.com/?token=…").
 *
 * @returns The address and the key, or an error in words.
 */
export function parseLink(raw: string): { origin: string; key: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "That is not a link. Copy the whole link, starting with https://." };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && privateHost(u.hostname))) return { error: "Only https links (or a home-network address) can be opened." };
  if (u.username || u.password) return { error: "That link has a user name in it; use the link KesherAI gave." };
  const key = u.searchParams.get("token") ?? "";
  if (!/^[\w.~-]{16,200}$/.test(key)) return { error: "The link has no key. On the other computer (or the phone connected to it): Settings → Phone → \"Link for another device\"." };
  return { origin: u.origin, key };
}

/** Checks the link with the other computer and trades the shared token for this device's own key. */
async function check(origin: string, key: string): Promise<{ name: string; key: string }> {
  const auth = { authorization: `Bearer ${key}` };
  const health = await fetch(`${origin}/api/health`, { headers: auth, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!health) throw new Error("The other computer did not answer. Is it on, with KesherAI running?");
  if (health.status === 401 || health.status === 403) throw new Error("The other computer refused the key. Make a new link there.");
  if (!health.ok) throw new Error(`The other computer answered ${health.status}. It may be starting; try again in a minute.`);
  const hello = (await fetch(`${origin}/api/hello`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json(), () => ({}))) as { product?: string; name?: string };
  if (hello.product !== "KesherAI") throw new Error("That address is not KesherAI.");
  // A shared token becomes a key of this device's own (a key that is already one is refused: kept as it is).
  const own = (await fetch(`${origin}/api/remote/devices/exchange`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ device: `${hostname()} (KesherAI app)` }), signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ token?: string }>) : {}), () => ({}))) as { token?: string };
  return { name: String(hello.name ?? new URL(origin).hostname).slice(0, 60), key: own.token ?? key };
}

const windows = new Map<string, BrowserWindow>();
const partitionOf = (origin: string) => `persist:computer-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`;

/** Opens a saved computer in its own window (or brings that window forward). */
async function show(c: SavedComputer, icon?: string): Promise<void> {
  const open = windows.get(c.origin);
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    return;
  }
  const partition = partitionOf(c.origin);
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: `${c.name} — KesherAI`,
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  windows.set(c.origin, win);
  win.on("closed", () => windows.delete(c.origin));
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, done, details) => {
    const fromIt = (details.requestingUrl ?? "").startsWith(`${c.origin}/`);
    const audioOnly = permission === "media" && !(details as { mediaTypes?: string[] }).mediaTypes?.includes("video");
    done(fromIt && (audioOnly || permission === "clipboard-sanitized-write"));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => origin === c.origin && (permission === "media" || permission === "clipboard-sanitized-write"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(`${c.origin}/`)) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });
  // A redirect from that computer to somewhere else is stopped too.
  win.webContents.on("will-redirect", (event, target) => {
    if (!target.startsWith(`${c.origin}/`)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(`${c.name} — KesherAI`);
  });
  await win.loadURL(`${c.origin}/?token=${encodeURIComponent(unseal(c.key))}`);
}

/** The saved computers, without their keys. */
export async function listComputers(): Promise<Array<{ name: string; origin: string }>> {
  return (await load()).map(({ name, origin }) => ({ name, origin }));
}

/**
 * Connects to another computer from a link, saves it and opens it.
 *
 * @returns The computer's name, or an error in words.
 */
export async function connectComputer(link: string, icon?: string): Promise<{ name?: string; error?: string }> {
  const parsed = parseLink(link);
  if ("error" in parsed) return { error: parsed.error };
  try {
    const ok = await check(parsed.origin, parsed.key);
    const list = (await load()).filter((c) => c.origin !== parsed.origin);
    const saved: SavedComputer = { name: ok.name, origin: parsed.origin, key: seal(ok.key) };
    await save([...list, saved]);
    await show(saved, icon);
    return { name: ok.name };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Opens a saved computer by its address. */
export async function openComputer(origin: string, icon?: string): Promise<{ error?: string }> {
  const c = (await load()).find((x) => x.origin === origin);
  if (!c) return { error: "That computer is not saved here." };
  try {
    await show(c, icon);
    return {};
  } catch (err) {
    return { error: `Could not open it: ${(err as Error).message}` };
  }
}

/** Forgets a computer: closes its window, deletes its key and its window's storage. */
export async function forgetComputer(origin: string): Promise<void> {
  const win = windows.get(origin);
  if (win && !win.isDestroyed()) win.destroy();
  await session.fromPartition(partitionOf(origin)).clearStorageData().catch(() => undefined);
  await save((await load()).filter((c) => c.origin !== origin));
}
