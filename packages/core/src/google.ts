import { createHash, randomBytes } from "node:crypto";

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
  folderId?: string;
  lastSync?: string;
  lastError?: string;
}

/** Endpoints, overridable for tests. */
export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  api: string;
  upload: string;
}

/** The real Google endpoints. */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  api: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3",
};

const SCOPES = "https://www.googleapis.com/auth/drive.file openid email";
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
  private pending = new Map<string, { verifier: string; redirectUri: string; at: number }>();
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
   * @returns The Google consent URL to open in the browser.
   * @throws Error if no client id is configured.
   */
  authUrl(redirectUri: string): string {
    const clientId = this.clientId;
    if (!clientId) throw new Error("Add a Google OAuth client id first (see docs/GOOGLE_DRIVE.md).");
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    this.pending.set(state, { verifier, redirectUri, at: Date.now() });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
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
    this.access = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
    if (json.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(json.id_token.split(".")[1] ?? "", "base64url").toString()) as { email?: string };
        if (payload.email) this.config.email = payload.email;
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
    delete this.config.folderId;
    delete this.config.lastSync;
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
      throw new Error(`Google Drive answered ${res.status}: ${text.slice(0, 200)}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** @returns The id of the KesherAI folder in Drive, creating it if needed. */
  async folder(): Promise<string> {
    if (this.config.folderId) return this.config.folderId;
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`);
    const found = await this.call<{ files: Array<{ id: string }> }>(`${this.endpoints.api}/files?q=${q}&fields=files(id)`);
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
