import { GcmGitHub, type GitCredential } from "./git-credential.js";

/**
 * "Connect with GitHub" without pasting a token, two ways (docs/GITHUB.md):
 *
 * - **Git Credential Manager** (on the PC, when git uses it): GCM opens the browser sign-in and keeps the token in
 *   the system's credential store; KesherAI keeps only the account name and asks GCM again when it needs the token.
 * - **Device flow** (anywhere, the phone too): the app shows a short code, the user opens github.com/login/device,
 *   signs in there and approves, and KesherAI receives a token (sealed in its config). It needs only the project's
 *   OAuth App client id (no secret).
 */

/** Saved GitHub sign-in. */
export interface GitHubConfig {
  token?: string;
  /** Signed in through Git Credential Manager: the token stays in GCM, never here. */
  via?: "gcm";
  login?: string;
  scopes?: string;
  /** The user's own OAuth App client id, used instead of the project's. */
  clientId?: string;
}

/** What the user needs to approve the sign-in. */
export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Permissions asked for: repositories (code, issues, pull requests), organisations (read), workflows. `GET /user` needs no extra scope. */
export const GITHUB_SCOPES = "repo read:org workflow";

/** A sign-in that is under way: the device code's, or Git Credential Manager's. */
interface Pending {
  kind: "device" | "gcm";
  deviceCode: string;
  interval: number;
  until: number;
  state: "waiting" | "done" | "denied" | "expired";
  error?: string;
}

/** Talks to GitHub's sign-in endpoints. */
export class GitHubAuth {
  private pending?: Pending;
  /** GCM's token, kept in memory only for a few minutes (GCM is asked again after that). */
  private gcmCache?: { token: string; until: number };
  private gcmFound?: { at: number; yes: boolean };

  /**
   * @param config - The `github` section of the app config (changed on sign-in).
   * @param save - Persists the config.
   * @param defaultClientId - The project's OAuth App client id (from repository secrets / env).
   * @param endpoints - GitHub URLs (tests pass a fake server).
   */
  constructor(
    private readonly config: GitHubConfig,
    private readonly save: () => Promise<void>,
    private readonly defaultClientId?: string,
    private readonly endpoints = { web: "https://github.com", api: "https://api.github.com" },
    /** GitHub's smallest wait between checks, in seconds (tests use less). */
    private readonly minInterval = 5,
    /** Git Credential Manager (tests pass one with a fake git). */
    private readonly gcm = new GcmGitHub(),
  ) {}

  private get clientId(): string | undefined {
    return this.config.clientId || this.defaultClientId || undefined;
  }

  /** @returns Whether a client id is available. */
  get configured(): boolean {
    return !!this.clientId;
  }

  /** @returns Whether the user is signed in (with a device token, or through GCM). */
  get connected(): boolean {
    return !!this.config.token || this.config.via === "gcm";
  }

  /** @returns The token when it is at hand without waiting (the device token, or GCM's recent one). Prefer {@link getToken}. */
  token(): string | undefined {
    return this.config.token ?? (this.gcmCache && this.gcmCache.until > Date.now() ? this.gcmCache.token : undefined);
  }

  /**
   * The token for GitHub's API and the GitHub MCP server: the device token, or GCM's (asked without any window).
   *
   * @returns The token, or undefined when not signed in (or GCM no longer has one).
   */
  async getToken(): Promise<string | undefined> {
    const now = this.token();
    if (now || this.config.via !== "gcm") return now;
    const c = await this.gcm.fill(false).catch(() => undefined);
    if (c) this.gcmCache = { token: c.password, until: Date.now() + 10 * 60_000 };
    return c?.password;
  }

  /** @returns The token git pushes need from KesherAI: the device token only (with GCM, git asks GCM itself). */
  pushToken(): string | undefined {
    return this.config.token;
  }

  /** @returns Status for the settings page (never the token). */
  status() {
    return {
      configured: this.configured,
      connected: this.connected,
      via: this.connected ? (this.config.via === "gcm" ? ("gcm" as const) : ("device" as const)) : null,
      login: this.config.login ?? null,
      scopes: this.config.scopes ?? null,
      customClient: !!this.config.clientId,
      pending: this.pending ? { kind: this.pending.kind, state: this.pending.state, ...(this.pending.error ? { error: this.pending.error } : {}) } : null,
    };
  }

  /** @returns Whether git on this computer uses Git Credential Manager (checked at most once a minute). */
  async gcmAvailable(): Promise<boolean> {
    if (!this.gcmFound || Date.now() - this.gcmFound.at > 60_000) this.gcmFound = { at: Date.now(), yes: await this.gcm.available().catch(() => false) };
    return this.gcmFound.yes;
  }

  /** Who the token belongs to and what it may do (from `GET /user`). */
  private async whoAmI(token: string): Promise<{ ok: boolean; login?: string; scopes?: string }> {
    try {
      const me = await fetch(`${this.endpoints.api}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) });
      if (!me.ok) return { ok: false };
      const scopes = me.headers.get("x-oauth-scopes");
      const login = ((await me.json()) as { login?: string }).login;
      return { ok: true, ...(login ? { login } : {}), ...(scopes !== null ? { scopes } : {}) };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Signs in through Git Credential Manager: GCM opens its browser sign-in on this computer (or answers at once
   * when it already has the account). Runs in the background; {@link status} shows the progress.
   */
  startGcm(): void {
    const p: Pending = { kind: "gcm", deviceCode: "", interval: 0, until: Date.now() + 5 * 60_000, state: "waiting" };
    this.pending = p;
    void (async () => {
      let c: GitCredential | undefined;
      try {
        c = await this.gcm.fill(true);
      } catch {
        c = undefined;
      }
      if (this.pending !== p) return;
      if (!c) {
        p.state = "denied";
        p.error = "Git Credential Manager did not sign in (the window was closed, or it timed out).";
        return;
      }
      const me = await this.whoAmI(c.password);
      await this.gcm.report(c, me.ok).catch(() => undefined);
      if (this.pending !== p) return;
      if (!me.ok) {
        p.state = "denied";
        p.error = "GitHub did not accept the account Git Credential Manager gave. Try again to sign in afresh.";
        return;
      }
      delete this.config.token;
      this.config.via = "gcm";
      if (me.login) this.config.login = me.login;
      if (me.scopes !== undefined) this.config.scopes = me.scopes;
      else delete this.config.scopes;
      this.gcmCache = { token: c.password, until: Date.now() + 10 * 60_000 };
      await this.save();
      p.state = "done";
    })();
  }

  /**
   * The repositories the account can reach, for the settings card.
   *
   * @returns How many (up to 100, `more` past that) and the most recently pushed names.
   */
  async repos(): Promise<{ count: number; more: boolean; names: string[] }> {
    const token = await this.getToken();
    if (!token) throw new Error("Not signed in to GitHub.");
    const res = await fetch(`${this.endpoints.api}/user/repos?per_page=100&sort=pushed`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const list = (await res.json()) as Array<{ full_name?: string }>;
    return { count: list.length, more: list.length >= 100, names: list.slice(0, 6).map((r) => r.full_name ?? "").filter(Boolean) };
  }

  private async post<T>(path: string, body: Record<string, string>): Promise<T> {
    const res = await fetch(`${this.endpoints.web}${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string };
    if (!res.ok && !j.error) throw new Error(`GitHub answered ${res.status}.`);
    return j;
  }

  /**
   * Starts signing in: returns the code to show; KesherAI then waits for the
   * user to approve on github.com.
   *
   * @returns The code and where to enter it.
   */
  async start(): Promise<DeviceStart> {
    const clientId = this.clientId;
    if (!clientId) throw new Error("GitHub sign-in is not set up in this build. See docs/GITHUB.md.");
    const j = await this.post<{ device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string }>("/login/device/code", { client_id: clientId, scope: GITHUB_SCOPES });
    if (j.error || !j.device_code || !j.user_code) {
      if (j.error === "device_flow_disabled") throw new Error("Device sign-in is turned off for this GitHub app: tick Enable Device Flow in its settings on GitHub.");
      if (/not found/i.test(j.error ?? "")) throw new Error(`GitHub does not know this app's Client ID (${clientId.slice(0, 8)}…). Use the Client ID from the OAuth App's page on GitHub (it starts with Ov23 or Iv1), not its secret.`);
      throw new Error(j.error_description ?? j.error ?? "GitHub did not start the sign-in.");
    }
    const interval = Math.max(this.minInterval, j.interval ?? 5);
    this.pending = { kind: "device", deviceCode: j.device_code, interval, until: Date.now() + (j.expires_in ?? 900) * 1000, state: "waiting" };
    void this.poll(clientId);
    return { userCode: j.user_code, verificationUri: j.verification_uri ?? "https://github.com/login/device", expiresIn: j.expires_in ?? 900, interval };
  }

  private async poll(clientId: string): Promise<void> {
    const p = this.pending;
    while (p && this.pending === p && p.state === "waiting") {
      await new Promise((r) => setTimeout(r, p.interval * 1000));
      if (this.pending !== p) return;
      if (Date.now() > p.until) {
        p.state = "expired";
        return;
      }
      let j: { access_token?: string; scope?: string; error?: string; interval?: number; error_description?: string };
      try {
        j = await this.post("/login/oauth/access_token", { client_id: clientId, device_code: p.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      } catch {
        continue; // offline for a moment: try again
      }
      if (j.access_token) {
        this.config.token = j.access_token;
        delete this.config.via;
        this.gcmCache = undefined;
        if (j.scope !== undefined) this.config.scopes = j.scope;
        // The name is only for display.
        const me = await this.whoAmI(j.access_token);
        if (me.login) this.config.login = me.login;
        await this.save();
        p.state = "done";
        return;
      }
      if (j.error === "slow_down") p.interval = (j.interval ?? p.interval) + 5;
      else if (j.error === "access_denied") p.state = "denied";
      else if (j.error === "expired_token") p.state = "expired";
      else if (j.error && j.error !== "authorization_pending") {
        p.state = "denied";
        p.error = j.error_description ?? j.error;
      }
    }
  }

  /** Cancels a sign-in that is waiting. */
  cancel(): void {
    this.pending = undefined;
  }

  /**
   * Signs out of KesherAI (the user can also revoke KesherAI on github.com → Settings → Applications). With GCM,
   * git itself stays signed in: KesherAI only stops using the account.
   */
  async disconnect(): Promise<void> {
    delete this.config.token;
    delete this.config.via;
    this.gcmCache = undefined;
    delete this.config.login;
    delete this.config.scopes;
    this.pending = undefined;
    await this.save();
  }
}
