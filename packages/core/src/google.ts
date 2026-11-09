import { createHash, randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Google sign-in and Drive sync for projects and conversations.
 *
 * Sign-in uses OAuth 2.0 for desktop apps: the browser opens Google's
 * consent page, Google redirects to KesherAI's own server on 127.0.0.1, and
 * the code is exchanged with PKCE. The only scope is `drive.file`, which
 * lets KesherAI see and change only the files it created itself — never the
 * rest of the user's Drive.
 *
 * Every app that signs in to Google needs an OAuth client id from Google
 * Cloud. docs/GOOGLE_DRIVE.md explains how the project owner (or a fork)
 * creates one in a few minutes.
 */

/** Google settings stored in config.json. */
export interface GoogleConfig {
  clientId?: string;
  /** Desktop clients have a secret that Google requires but that is not secret in practice. */
  clientSecret?: string;
  refreshToken?: string;
  email?: string;
  name?: string;
  picture?: string;
  folderId?: string;
  lastSync?: string;
  lastError?: string;
  /** Extra services the user connected on top of Drive (granted scopes). */
  services?: GoogleService[];
}

/** Google services besides Drive that KesherAI can connect. */
export type GoogleService = "gmail" | "calendar" | "drive";

/**
 * The permissions each service asks for. Gmail can read and write drafts,
 * never send; Calendar reads and adds events.
 */
export const SERVICE_SCOPES: Record<GoogleService, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
  // Read every file in the user's Drive (search and read); new documents are created with drive.file.
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
};

/** Endpoints, overridable for tests. */
export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  api: string;
  upload: string;
  /** Gmail and Calendar APIs (default to Google's). */
  gmail?: string;
  calendar?: string;
}

/** The real Google endpoints. */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
  gmail: "https://gmail.googleapis.com/gmail/v1",
  calendar: "https://www.googleapis.com/calendar/v3",
};

const SCOPES = "https://www.googleapis.com/auth/drive.file openid email profile";
const FOLDER_NAME = "KesherAI";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A file KesherAI keeps in its Drive folder. */
export interface RemoteItem {
  fileId: string;
  kind: "projects" | "conversations";
  id: string;
  updatedAt: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Talks to Google: sign-in, tokens, and the KesherAI folder in Drive.
 * Holds no state besides the config object it was given, which it updates.
 */
export class GoogleDrive {
  private pending = new Map<string, { verifier: string; redirectUri: string; at: number; services: GoogleService[] }>();
  private access?: { token: string; expires: number };
  private fileIds = new Map<string, string>();

  /**
   * @param config - The `google` section of the app config (mutated on sign-in).
   * @param save - Persists the config.
   * @param endpoints - Google URLs (tests pass a fake server).
   * @param defaults - The project's own OAuth client (from branding), used when the user set none.
   */
  constructor(
    private readonly config: GoogleConfig,
    private readonly save: () => Promise<void>,
    private readonly endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
    private readonly defaults: { clientId?: string; clientSecret?: string } = {},
  ) {}

  private get clientId(): string | undefined {
    return this.config.clientId || this.defaults.clientId || undefined;
  }

  private get clientSecret(): string | undefined {
    return this.config.clientId ? this.config.clientSecret : this.defaults.clientSecret || undefined;
  }

  /** @returns Whether an OAuth client id is set (by the user or the project). */
  get configured(): boolean {
    return !!this.clientId;
  }

  /** @returns Whether the user signed in. */
  get connected(): boolean {
    return !!this.config.refreshToken;
  }

  /**
   * Starts sign-in.
   *
   * @param redirectUri - KesherAI's callback, e.g. `http://127.0.0.1:7420/api/google/callback`.
   * @param services - Extra services to connect (Gmail, Calendar); Drive is always included.
   * @returns The Google consent URL to open in the browser.
   * @throws Error if no client id is configured.
   */
  authUrl(redirectUri: string, services: GoogleService[] = []): string {
    const clientId = this.clientId;
    if (!clientId) throw new Error("This copy of KesherAI has no Google sign-in built in — it was run from the source code. Install KesherAI from the release (github.com/Deadchu-R/KesherAI/releases), or put google-client.json in the KesherAI data folder (see docs/GOOGLE_DRIVE.md).");
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const wanted = [...new Set([...(this.config.services ?? []), ...services])].filter((x): x is GoogleService => x in SERVICE_SCOPES);
    this.pending.set(state, { verifier, redirectUri, at: Date.now(), services: wanted });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [SCOPES, ...wanted.flatMap((x) => SERVICE_SCOPES[x])].join(" "),
      include_granted_scopes: "true",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    return `${this.endpoints.auth}?${params}`;
  }

  /**
   * Finishes sign-in with the code Google sent back.
   *
   * @param code - From the callback URL.
   * @param state - From the callback URL; must match {@link authUrl}'s.
   * @returns The signed-in email, if Google shared it.
   * @throws Error on a state mismatch or a failed exchange.
   */
  async finish(code: string, state: string): Promise<string | undefined> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > 10 * 60_000) throw new Error("This sign-in link expired. Start again from Settings.");
    const json = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    });
    if (!json.refresh_token) throw new Error("Google did not return a refresh token. Remove KesherAI's access in your Google account and connect again.");
    this.config.refreshToken = json.refresh_token;
    // Keep the services whose permissions the user actually ticked on the consent page.
    const granted = (json.scope ?? "").split(" ");
    const got = p.services.filter((x) => SERVICE_SCOPES[x].every((sc) => granted.includes(sc)));
    if (got.length) this.config.services = got;
    else delete this.config.services;
    this.access = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
    if (json.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(json.id_token.split(".")[1] ?? "", "base64url").toString()) as { email?: string; name?: string; picture?: string };
        if (payload.email) this.config.email = payload.email;
        if (payload.name) this.config.name = payload.name;
        if (payload.picture && /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(payload.picture)) this.config.picture = payload.picture;
      } catch {
        // the email is only for display
      }
    }
    delete this.config.lastError;
    await this.save();
    return this.config.email;
  }

  /** Signs out: revokes the token at Google and forgets it. */
  async disconnect(): Promise<void> {
    const token = this.config.refreshToken;
    delete this.config.refreshToken;
    delete this.config.email;
    delete this.config.name;
    delete this.config.picture;
    delete this.config.folderId;
    delete this.config.lastSync;
    delete this.config.services;
    this.access = undefined;
    this.fileIds.clear();
    await this.save();
    if (token) await fetch(`${this.endpoints.revoke}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
  }

  private async tokenRequest(body: Record<string, string>): Promise<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
  }> {
    const res = await fetch(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId ?? "",
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
        ...body,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string } & Record<string, unknown>;
    if (!res.ok) throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
    return json as never;
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.access.expires) return this.access.token;
    if (!this.config.refreshToken) throw new Error("Not connected to Google Drive.");
    const json = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.config.refreshToken });
    this.access = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
    return json.access_token;
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${await this.token()}`, ...(init.headers as Record<string, string>) } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google answered ${res.status}: ${text.slice(0, 200)}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /**
   * The id of a folder at the top of the user's Drive with this name, made if there is none. KesherAI's
   * permission (drive.file) only lets it add files to folders it made itself, so a folder of that name the
   * user made by hand is used only when it accepts the upload; otherwise KesherAI makes its own.
   */
  async ensureFolder(name: string, fresh = false): Promise<string> {
    if (fresh) return (await this.call<{ id: string }>(`${this.endpoints.api}/files?fields=id`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME }) })).id;
    const q = encodeURIComponent(`name='${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`);
    const found = await this.call<{ files: Array<{ id: string; capabilities?: { canAddChildren?: boolean } }> }>(`${this.endpoints.api}/files?q=${q}&fields=files(id,capabilities(canAddChildren))&orderBy=createdTime`);
    const usable = found.files.find((f) => f.capabilities?.canAddChildren !== false);
    if (usable) return usable.id;
    const made = await this.call<{ id: string }>(`${this.endpoints.api}/files?fields=id`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    return made.id;
  }

  /**
   * Uploads a file of any size from this computer into a Drive folder, in 8 MB pieces (Google's resumable
   * upload), so a 200 MB game build never sits in memory whole.
   *
   * @returns The new file's id and link.
   */
  async uploadFile(path: string, folderId: string, onProgress?: (sent: number, total: number) => void): Promise<{ id: string; link: string; size: number }> {
    const size = (await stat(path)).size;
    const name = basename(path);
    const init = await fetch(`${this.endpoints.upload}/files?uploadType=resumable&fields=id,webViewLink`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size) },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    if (!init.ok) throw new Error(`Google answered ${init.status}: ${(await init.text().catch(() => "")).slice(0, 200)}`);
    const session = init.headers.get("location");
    if (!session) throw new Error("Google did not start the upload.");
    const fh = await open(path, "r");
    try {
      const CHUNK = 8 * 1024 * 1024;
      for (let at = 0; ; ) {
        const len = Math.min(CHUNK, size - at);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, at);
        const res = await fetch(session, { method: "PUT", headers: { "content-range": size === 0 ? "bytes */0" : `bytes ${at}-${at + len - 1}/${size}` }, body: buf });
        if (res.status === 308) {
          // Google says how much it has; continue from there.
          const range = res.headers.get("range");
          at = range ? Number(/-(\d+)$/.exec(range)?.[1] ?? at - 1) + 1 : at + len;
          onProgress?.(at, size);
          continue;
        }
        if (!res.ok) throw new Error(`The upload stopped: Google answered ${res.status}.`);
        const f = (await res.json()) as { id: string; webViewLink?: string };
        onProgress?.(size, size);
        return { id: f.id, link: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`, size };
      }
    } finally {
      await fh.close();
    }
  }

  /** @returns Whether a service (Gmail, Calendar) is connected. */
  has(service: GoogleService): boolean {
    return this.connected && !!this.config.services?.includes(service);
  }

  /** @returns The upload API base (Drive). */
  uploadBase(): string {
    return this.endpoints.upload;
  }

  /**
   * Calls a Google API and returns the raw response (for file contents).
   *
   * @param url - The full URL.
   * @returns The response.
   */
  async raw(url: string): Promise<Response> {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new Error(`Google answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res;
  }

  /** @returns The API base for a service. */
  base(service: GoogleService): string {
    if (service === "drive") return this.endpoints.api;
    return (service === "gmail" ? this.endpoints.gmail : this.endpoints.calendar) ?? GOOGLE_ENDPOINTS[service]!;
  }

  /**
   * Calls a Google API with the signed-in user's token.
   *
   * @param url - The full URL.
   * @param init - Fetch options.
   * @returns The JSON answer.
   */
  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    return this.call<T>(url, init);
  }

  /** @returns The id of the KesherAI folder in Drive, creating it if needed. */
  async folder(): Promise<string> {
    if (this.config.folderId) return this.config.folderId;
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    // The oldest one, so computers that sign in later all use the same folder.
    const found = await this.call<{ files: Array<{ id: string }> }>(`${this.endpoints.api}/files?q=${q}&fields=files(id)&orderBy=createdTime`);
    const id =
      found.files[0]?.id ??
      (await this.call<{ id: string }>(`${this.endpoints.api}/files?fields=id`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
      })).id;
    this.config.folderId = id;
    await this.save();
    return id;
  }

  /**
   * Reads a named JSON file from the KesherAI folder (device list, settings).
   *
   * @param name - File name, e.g. `devices.json`.
   * @returns Its content, or undefined when it does not exist yet.
   */
  async readJson<T>(name: string): Promise<T | undefined> {
    const folder = await this.folder();
    const q = encodeURIComponent(`name='${name}' and '${folder}' in parents and trashed=false`);
    const found = await this.call<{ files: Array<{ id: string }> }>(`${this.endpoints.api}/files?q=${q}&fields=files(id)`);
    const id = found.files[0]?.id;
    if (!id) return undefined;
    this.fileIds.set(name, id);
    return this.call<T>(`${this.endpoints.api}/files/${id}?alt=media`);
  }

  /**
   * Reads every file with this name that KesherAI can see in Drive, in any
   * KesherAI folder. Two computers that signed in at the same time can each
   * have made a folder of their own; reading them all lets them still find
   * each other. (KesherAI only sees files it made itself: drive.file.)
   *
   * @param name - File name, e.g. `devices.json`.
   */
  async readAllJson<T>(name: string): Promise<T[]> {
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const found = await this.call<{ files: Array<{ id: string }> }>(`${this.endpoints.api}/files?q=${q}&fields=files(id)&pageSize=20`);
    const out: T[] = [];
    for (const f of found.files) {
      try {
        out.push(await this.call<T>(`${this.endpoints.api}/files/${f.id}?alt=media`));
      } catch {
        // a file that cannot be read: skip it
      }
    }
    return out;
  }

  /**
   * Writes a named JSON file in the KesherAI folder (created the first time).
   *
   * @param name - File name.
   * @param value - The content.
   */
  async writeJson(name: string, value: unknown): Promise<void> {
    const folder = await this.folder();
    if (!this.fileIds.has(name)) {
      const q = encodeURIComponent(`name='${name}' and '${folder}' in parents and trashed=false`);
      const found = await this.call<{ files: Array<{ id: string }> }>(`${this.endpoints.api}/files?q=${q}&fields=files(id)`);
      if (found.files[0]) this.fileIds.set(name, found.files[0].id);
    }
    const existing = this.fileIds.get(name);
    const metadata = { name, ...(existing ? {} : { parents: [folder], mimeType: "application/json" }) };
    const boundary = `kesher${randomBytes(8).toString("hex")}`;
    const body =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`;
    const res = await this.call<{ id: string }>(
      existing ? `${this.endpoints.upload}/files/${existing}?uploadType=multipart&fields=id` : `${this.endpoints.upload}/files?uploadType=multipart&fields=id`,
      { method: existing ? "PATCH" : "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body },
    );
    this.fileIds.set(name, res.id);
  }

  /** @returns Every item in the KesherAI folder. */
  async list(): Promise<RemoteItem[]> {
    const folder = await this.folder();
    const items: RemoteItem[] = [];
    let page: string | undefined;
    do {
      const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
      const res = await this.call<{ files: Array<{ id: string; name: string; appProperties?: Record<string, string> }>; nextPageToken?: string }>(
        `${this.endpoints.api}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${page ? `&pageToken=${page}` : ""}`,
      );
      for (const f of res.files) {
        const a = f.appProperties ?? {};
        if ((a.kind === "projects" || a.kind === "conversations") && a.id && a.updatedAt) {
          items.push({ fileId: f.id, kind: a.kind, id: a.id, updatedAt: a.updatedAt });
          this.fileIds.set(f.name, f.id);
        }
      }
      page = res.nextPageToken;
    } while (page);
    return items;
  }

  /**
   * Downloads one item.
   *
   * @param fileId - Drive file id.
   * @returns Its JSON.
   */
  async download(fileId: string): Promise<unknown> {
    return this.call(`${this.endpoints.api}/files/${fileId}?alt=media`);
  }

  /**
   * Creates or updates an item.
   *
   * @param kind - `projects` or `conversations`.
   * @param id - Item id.
   * @param value - The item, with an `updatedAt`.
   */
  async upload(kind: "projects" | "conversations", id: string, value: { updatedAt: string }): Promise<void> {
    const folder = await this.folder();
    const name = `${kind}-${id}.json`;
    if (!this.fileIds.has(name)) await this.list();
    const existing = this.fileIds.get(name);
    const metadata = { name, appProperties: { kind, id, updatedAt: value.updatedAt }, ...(existing ? {} : { parents: [folder], mimeType: "application/json" }) };
    const boundary = `kesher${randomBytes(8).toString("hex")}`;
    const body =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`;
    const res = await this.call<{ id: string }>(
      existing ? `${this.endpoints.upload}/files/${existing}?uploadType=multipart&fields=id` : `${this.endpoints.upload}/files?uploadType=multipart&fields=id`,
      { method: existing ? "PATCH" : "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body },
    );
    this.fileIds.set(name, res.id);
  }

  /**
   * Moves an item to the Drive trash (recoverable for 30 days).
   *
   * @param kind - `projects` or `conversations`.
   * @param id - Item id.
   */
  async remove(kind: "projects" | "conversations", id: string): Promise<void> {
    const name = `${kind}-${id}.json`;
    if (!this.fileIds.has(name)) await this.list();
    const fileId = this.fileIds.get(name);
    if (!fileId) return;
    await this.call(`${this.endpoints.api}/files/${fileId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    this.fileIds.delete(name);
  }
}
