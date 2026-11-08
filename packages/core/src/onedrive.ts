import { createHash, randomBytes } from "node:crypto";
import type { RemoteItem } from "./google.js";

/**
 * Microsoft sign-in and OneDrive sync for projects and conversations — the
 * OneDrive twin of {@link GoogleDrive}.
 *
 * Sign-in is OAuth 2.0 for desktop apps (a public client: no secret): the
 * browser opens Microsoft's consent page, Microsoft redirects to KesherAI's
 * own server on localhost, and the code is exchanged with PKCE. The only
 * file permission is `Files.ReadWrite.AppFolder`, which lets KesherAI see
 * and change only its own folder (OneDrive → Apps → KesherAI), never the
 * rest of the user's files.
 *
 * Every app that signs in with Microsoft needs an application (client) id
 * from a free app registration; docs/ONEDRIVE.md explains it.
 */

/** OneDrive settings stored in config.json. */
export interface OneDriveConfig {
  /** The user's own app registration (instead of the project's). */
  clientId?: string;
  refreshToken?: string;
  email?: string;
  name?: string;
  lastSync?: string;
  lastError?: string;
}

/** Endpoints, overridable for tests. */
export interface OneDriveEndpoints {
  /** `https://login.microsoftonline.com/common/oauth2/v2.0` */
  login: string;
  /** `https://graph.microsoft.com/v1.0` */
  graph: string;
}

/** The real Microsoft endpoints ("common": personal and work or school accounts). */
export const ONEDRIVE_ENDPOINTS: OneDriveEndpoints = {
  login: "https://login.microsoftonline.com/common/oauth2/v2.0",
  graph: "https://graph.microsoft.com/v1.0",
};

const SCOPES = "Files.ReadWrite.AppFolder offline_access openid email profile User.Read";
type Kind = RemoteItem["kind"];

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Talks to Microsoft: sign-in, tokens, and KesherAI's app folder in OneDrive.
 * Items live as `<kind>/<id>.json`; each file's "modified" time is set to
 * the item's `updatedAt`, so a list tells which side is newer without
 * downloading anything.
 */
export class OneDrive {
  private pending = new Map<string, { verifier: string; redirectUri: string; at: number }>();
  private access?: { token: string; expires: number };

  /**
   * @param config - The `onedrive` section of the app config (mutated on sign-in).
   * @param save - Persists the config.
   * @param endpoints - Microsoft URLs (tests pass a fake server).
   * @param defaultClientId - The project's app registration, used when the user set none.
   */
  constructor(
    private readonly config: OneDriveConfig,
    private readonly save: () => Promise<void>,
    private readonly endpoints: OneDriveEndpoints = ONEDRIVE_ENDPOINTS,
    private readonly defaultClientId?: string,
  ) {}

  private get clientId(): string | undefined {
    return this.config.clientId || this.defaultClientId || undefined;
  }

  /** @returns Whether an application id is set (by the user or the project). */
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
   * @param redirectUri - KesherAI's callback, e.g. `http://localhost:7420/api/onedrive/callback`.
   * @returns The Microsoft consent URL to open in the browser.
   * @throws Error if no application id is set.
   */
  authUrl(redirectUri: string): string {
    const clientId = this.clientId;
    if (!clientId) throw new Error("OneDrive sign-in needs an application id. Paste one in Settings → OneDrive (see docs/ONEDRIVE.md).");
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    this.pending.set(state, { verifier, redirectUri, at: Date.now() });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: SCOPES,
      prompt: "select_account",
      state,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    return `${this.endpoints.login}/authorize?${params}`;
  }

  /**
   * Finishes sign-in with the code Microsoft sent back.
   *
   * @param code - From the callback URL.
   * @param state - From the callback URL; must match {@link authUrl}'s.
   * @returns The signed-in email, if Microsoft shared it.
   * @throws Error on a state mismatch or a failed exchange.
   */
  async finish(code: string, state: string): Promise<string | undefined> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > 10 * 60_000) throw new Error("This sign-in link expired. Start again from Settings.");
    const json = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    if (!json.refresh_token) throw new Error("Microsoft did not return a refresh token. Try connecting again.");
    this.config.refreshToken = json.refresh_token;
    this.access = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
    if (json.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(json.id_token.split(".")[1] ?? "", "base64url").toString()) as { email?: string; preferred_username?: string; name?: string };
        const email = payload.email ?? payload.preferred_username;
        if (email) this.config.email = email;
        if (payload.name) this.config.name = payload.name;
      } catch {
        // the email is only for display
      }
    }
    delete this.config.lastError;
    await this.save();
    return this.config.email;
  }

  /** Signs out: forgets the token (Microsoft has no revoke call for a single public-client token). */
  async disconnect(): Promise<void> {
    delete this.config.refreshToken;
    delete this.config.email;
    delete this.config.name;
    delete this.config.lastSync;
    delete this.config.lastError;
    this.access = undefined;
    await this.save();
  }

  private async tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string }> {
    const res = await fetch(`${this.endpoints.login}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId ?? "", scope: SCOPES, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string } & Record<string, unknown>;
    if (!res.ok) throw new Error(`Microsoft sign-in failed: ${(json.error_description ?? json.error ?? res.status).toString().split("\r\n")[0]}`);
    return json as never;
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.access.expires) return this.access.token;
    if (!this.config.refreshToken) throw new Error("Not connected to OneDrive.");
    const json = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.config.refreshToken });
    // Microsoft rotates refresh tokens; keep the newest.
    if (json.refresh_token && json.refresh_token !== this.config.refreshToken) {
      this.config.refreshToken = json.refresh_token;
      await this.save();
    }
    this.access = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
    return json.access_token;
  }

  private async call<T>(url: string, init: RequestInit = {}, okMissing = false): Promise<T | undefined> {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${await this.token()}`, ...(init.headers as Record<string, string>) } });
    if (okMissing && res.status === 404) return undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OneDrive answered ${res.status}: ${text.slice(0, 200)}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private path(kind: Kind, id: string): string {
    return `${this.endpoints.graph}/me/drive/special/approot:/${kind}/${encodeURIComponent(id)}.json`;
  }

  /** @returns Every item in KesherAI's app folder. */
  async list(): Promise<RemoteItem[]> {
    const items: RemoteItem[] = [];
    for (const kind of ["projects", "conversations"] as const) {
      type Page = { value: Array<{ id: string; name: string; fileSystemInfo?: { lastModifiedDateTime?: string } }>; "@odata.nextLink"?: string };
      let url: string | undefined = `${this.endpoints.graph}/me/drive/special/approot:/${kind}:/children?$select=id,name,fileSystemInfo&$top=999`;
      while (url) {
        const page: Page | undefined = await this.call<Page>(url, {}, true);
        if (!page) break; // the folder does not exist yet
        for (const f of page.value) {
          const at = f.fileSystemInfo?.lastModifiedDateTime;
          if (f.name.endsWith(".json") && at) items.push({ fileId: f.id, kind, id: decodeURIComponent(f.name.slice(0, -5)), updatedAt: at });
        }
        url = page["@odata.nextLink"];
      }
    }
    return items;
  }

  /**
   * Downloads one item.
   *
   * @param fileId - OneDrive item id.
   * @returns Its JSON.
   */
  async download(fileId: string): Promise<unknown> {
    return this.call(`${this.endpoints.graph}/me/drive/items/${encodeURIComponent(fileId)}/content`);
  }

  /**
   * Creates or updates an item (folders are created on the way).
   *
   * @param kind - `projects` or `conversations`.
   * @param id - Item id.
   * @param value - The item, with an `updatedAt`.
   */
  async upload(kind: Kind, id: string, value: { updatedAt: string }): Promise<void> {
    const item = await this.call<{ id: string }>(`${this.path(kind, id)}:/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!item) return;
    await this.call(`${this.endpoints.graph}/me/drive/items/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileSystemInfo: { lastModifiedDateTime: value.updatedAt } }),
    });
  }

  /**
   * Moves an item to the OneDrive recycle bin (recoverable).
   *
   * @param kind - `projects` or `conversations`.
   * @param id - Item id.
   */
  async remove(kind: Kind, id: string): Promise<void> {
    await this.call(this.path(kind, id), { method: "DELETE" }, true);
  }
}
