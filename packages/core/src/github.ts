/**
 * "Connect with GitHub" without pasting a token: GitHub's device flow. The
 * app shows a short code, the user opens github.com/login/device, signs in
 * there and approves, and KesherAI receives a token. It needs only the
 * project's OAuth App client id (no secret); see docs/GITHUB.md.
 */

/** Saved GitHub sign-in. */
export interface GitHubConfig {
  token?: string;
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

/** Permissions asked for: repositories (code, issues, pull requests), organisations (read), workflows. */
export const GITHUB_SCOPES = "repo read:org workflow";

/** Talks to GitHub's sign-in endpoints. */
export class GitHubAuth {
  private pending?: { deviceCode: string; interval: number; until: number; state: "waiting" | "done" | "denied" | "expired"; error?: string };

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
  ) {}

  private get clientId(): string | undefined {
    return this.config.clientId || this.defaultClientId || undefined;
  }

  /** @returns Whether a client id is available. */
  get configured(): boolean {
    return !!this.clientId;
  }

  /** @returns Whether the user is signed in. */
  get connected(): boolean {
    return !!this.config.token;
  }

  /** @returns The token, for tools and the GitHub MCP server. */
  token(): string | undefined {
    return this.config.token;
  }

  /** @returns Status for the settings page (never the token). */
  status() {
    return { configured: this.configured, connected: this.connected, login: this.config.login ?? null, customClient: !!this.config.clientId, pending: this.pending ? { state: this.pending.state, ...(this.pending.error ? { error: this.pending.error } : {}) } : null };
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
    this.pending = { deviceCode: j.device_code, interval, until: Date.now() + (j.expires_in ?? 900) * 1000, state: "waiting" };
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
        if (j.scope !== undefined) this.config.scopes = j.scope;
        try {
          const me = await fetch(`${this.endpoints.api}/user`, { headers: { authorization: `Bearer ${j.access_token}`, accept: "application/vnd.github+json", "user-agent": "KesherAI" } });
          if (me.ok) this.config.login = ((await me.json()) as { login?: string }).login;
        } catch {
          /* the name is only for display */
        }
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

  /** Signs out (the user can also revoke KesherAI on github.com → Settings → Applications). */
  async disconnect(): Promise<void> {
    delete this.config.token;
    delete this.config.login;
    delete this.config.scopes;
    this.pending = undefined;
    await this.save();
  }
}
