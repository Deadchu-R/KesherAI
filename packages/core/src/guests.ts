import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Working together on one project (docs/COLLABORATION.md, approved by Roee 2026-11-18), stage 1: a one-time invite
 * link for one project, read or edit, that ends after 1 hour to 7 days. The first person to open it writes their name
 * and gets a device key whose scope is that project only (`project:<id>:read|edit`); the auth hook lets such a key
 * reach `/api/guest/*` and nothing else. Only a hash of each invite token is kept here.
 */

/** What a guest may do in the project. */
export type GuestRole = "read" | "edit";

/** One invite, as kept in guest-invites.json. */
export interface GuestInvite {
  id: string;
  /** SHA-256 of the token (the token itself is shown once, in the link). */
  hash: string;
  projectId: string;
  role: GuestRole;
  createdAt: string;
  expiresAt: string;
  /** When it was used, and the name the guest gave. */
  usedAt?: string;
  usedBy?: string;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const SCOPE = /^project:([\w-]{1,80}):(read|edit)$/;

/**
 * The project and role of a guest key's scope.
 *
 * @param scope - A device key's scope.
 * @returns The project and role, or undefined for any other scope.
 */
export function guestOf(scope: string | undefined): { projectId: string; role: GuestRole } | undefined {
  const m = scope ? SCOPE.exec(scope) : null;
  return m ? { projectId: m[1]!, role: m[2] as GuestRole } : undefined;
}

/**
 * A guest key's scope.
 *
 * @param projectId - The project.
 * @param role - Read or edit.
 * @returns `project:<id>:<role>`.
 */
export const guestScope = (projectId: string, role: GuestRole): `project:${string}:${GuestRole}` => `project:${projectId}:${role}`;

/** A guest's name: letters, digits, spaces and a few marks, at most 40. */
export const guestName = (name: string): string => name.replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);

/** The invites, in one JSON file. */
export class GuestInvites {
  /** @param file - guest-invites.json in KesherAI's data folder. */
  constructor(private readonly file: string) {}

  private async read(): Promise<GuestInvite[]> {
    try {
      const v = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      return Array.isArray(v) ? (v as GuestInvite[]) : [];
    } catch {
      return [];
    }
  }

  private async write(list: GuestInvite[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // Invites that ended over a week ago are dropped.
    const keep = list.filter((i) => Date.parse(i.expiresAt) > Date.now() - 7 * 86_400_000 || i.usedAt);
    await writeFile(tmp, JSON.stringify(keep, null, 1), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /**
   * Makes an invite.
   *
   * @param projectId - The project shared.
   * @param role - Read or edit.
   * @param hours - How long the link works: 1 to 168.
   * @returns The token (for the link; only its hash is kept) and the invite.
   */
  async create(projectId: string, role: GuestRole, hours: number): Promise<{ token: string; invite: GuestInvite }> {
    if (!/^[\w-]{1,80}$/.test(projectId)) throw new Error("No such project.");
    if (role !== "read" && role !== "edit") throw new Error("Role: read or edit.");
    const h = Math.round(hours);
    if (!(h >= 1 && h <= 168)) throw new Error("The link can work 1 hour to 7 days.");
    const token = randomBytes(32).toString("base64url");
    const invite: GuestInvite = { id: randomUUID(), hash: hashOf(token), projectId, role, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + h * 3_600_000).toISOString() };
    const list = await this.read();
    list.push(invite);
    await this.write(list);
    return { token, invite };
  }

  /**
   * An invite that can still be used.
   *
   * @param token - From the link.
   * @returns The invite, or undefined when it is unknown, used or ended.
   */
  async open(token: string): Promise<GuestInvite | undefined> {
    if (!TOKEN.test(token)) return undefined;
    const h = hashOf(token);
    const i = (await this.read()).find((x) => x.hash === h);
    return i && !i.usedAt && Date.parse(i.expiresAt) > Date.now() ? i : undefined;
  }

  /**
   * Uses an invite (once): it stops working.
   *
   * @param token - From the link.
   * @param name - The guest's name.
   * @returns The invite, or undefined when it cannot be used.
   */
  async use(token: string, name: string): Promise<GuestInvite | undefined> {
    if (!TOKEN.test(token)) return undefined;
    const h = hashOf(token);
    const list = await this.read();
    const i = list.find((x) => x.hash === h);
    if (!i || i.usedAt || Date.parse(i.expiresAt) <= Date.now()) return undefined;
    i.usedAt = new Date().toISOString();
    i.usedBy = guestName(name) || "Guest";
    await this.write(list);
    return i;
  }

  /**
   * The project's invites, newest first (no hashes).
   *
   * @param projectId - The project.
   */
  async list(projectId: string): Promise<Array<Omit<GuestInvite, "hash">>> {
    return (await this.read())
      .filter((i) => i.projectId === projectId)
      .map(({ hash: _h, ...i }) => i)
      .reverse();
  }

  /**
   * Cancels an unused invite.
   *
   * @param id - The invite.
   * @returns Whether one was cancelled.
   */
  async cancel(id: string): Promise<boolean> {
    const list = await this.read();
    const n = list.length;
    const left = list.filter((i) => i.id !== id || i.usedAt);
    if (left.length === n) return false;
    await this.write(left);
    return true;
  }
}

/** Counts each guest's answers per day (the owner's computer answers them), kept in memory. */
export class GuestQuota {
  private used = new Map<string, { day: string; n: number }>();

  /**
   * Takes one answer from a guest's daily allowance.
   *
   * @param id - The guest's device id.
   * @param limit - Answers a day.
   * @returns What is left after this one, or -1 when none was left.
   */
  take(id: string, limit: number): number {
    const day = new Date().toISOString().slice(0, 10);
    const u = this.used.get(id);
    const n = u && u.day === day ? u.n : 0;
    if (n >= limit) return -1;
    this.used.set(id, { day, n: n + 1 });
    return limit - n - 1;
  }

  /**
   * What is left today.
   *
   * @param id - The guest's device id.
   * @param limit - Answers a day.
   */
  left(id: string, limit: number): number {
    const u = this.used.get(id);
    return Math.max(0, limit - (u && u.day === new Date().toISOString().slice(0, 10) ? u.n : 0));
  }
}

/** What the owner is told about a guest (stage 2 of docs/COLLABORATION.md). */
export type GuestAlert = "outside" | "new-address" | "busy" | "night";

/**
 * Watches guests' requests for what the owner should hear about: a try to reach outside the shared project, a new
 * network address, or very many requests in a minute. Each kind is said at most once in 10 minutes per guest; the
 * first address a guest comes from is learnt quietly.
 */
export class GuestWatch {
  private addresses = new Map<string, Set<string>>();
  private recent = new Map<string, number[]>();
  private said = new Map<string, number>();

  /**
   * One request by a guest.
   *
   * @param guest - The guest's device id.
   * @param address - Where it came from.
   * @param status - The answer's status (403: outside the project).
   * @param now - The time (for tests).
   * @param night - Whether to say so when it is 23:00–07:00 here (the owner's "quiet hours" switch).
   * @returns What to tell the owner, if anything.
   */
  see(guest: string, address: string, status: number, now = Date.now(), night = false): GuestAlert[] {
    const out: GuestAlert[] = [];
    const once = (kind: GuestAlert) => {
      const key = `${guest}|${kind}`;
      if (now - (this.said.get(key) ?? -Infinity) < 600_000) return;
      this.said.set(key, now);
      out.push(kind);
    };
    if (status === 403) once("outside");
    const known = this.addresses.get(guest);
    if (!known) this.addresses.set(guest, new Set([address]));
    else if (!known.has(address)) {
      if (known.size < 20) known.add(address);
      once("new-address");
    }
    const times = (this.recent.get(guest) ?? []).filter((t) => now - t < 60_000);
    times.push(now);
    this.recent.set(guest, times);
    if (times.length > 120) once("busy");
    const hour = new Date(now).getHours();
    if (night && (hour >= 23 || hour < 7)) once("night");
    return out;
  }
}

/**
 * Files a guest never sees in a shared project's folder: environment files, keys and certificates, credentials,
 * and anything under .git or .ssh.
 */
export const GUEST_SECRET = /(^|[\\/])(\.env(\.[\w.-]*)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?(\.[\w-]+)?\.(json|ya?ml|toml|env)|\.git([\\/].*)?|\.ssh([\\/].*)?)$/i;

/**
 * A guest's tools in a shared project (stage 3, read only): list, read and search the project's files, with secret
 * files left out of every answer and refused when asked for by name. Nothing writes, runs or reaches the network.
 *
 * @param tools - KesherAI's code tools (the ones named list_files, read_file and search are taken).
 * @returns The guest's tools.
 */
export function guestFileTools<T extends { spec: { name: string }; run(input: Record<string, unknown>, ctx: never): Promise<unknown> }>(tools: readonly T[]): T[] {
  const pathOf = (line: string) => line.split(/:\d+[:-]/)[0]!.trim();
  const clean = (out: unknown) => (typeof out === "string" ? out.split("\n").filter((l) => !GUEST_SECRET.test(pathOf(l))).join("\n") : out);
  return tools
    .filter((t) => t.spec.name === "list_files" || t.spec.name === "read_file" || t.spec.name === "search")
    .map((t) => ({
      ...t,
      async run(input: Record<string, unknown>, ctx: never) {
        if (t.spec.name === "read_file" && GUEST_SECRET.test(String(input.path ?? "").trim())) return "This file is private to the project's owner.";
        return clean(await t.run(input, ctx));
      },
    }));
}
