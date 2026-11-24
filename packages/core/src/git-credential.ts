import { spawn } from "node:child_process";

/**
 * GitHub sign-in through git's own credential system (docs/GITHUB.md):
 *
 * - **Git Credential Manager** (ships with Git for Windows): `git credential fill` for github.com makes GCM open the
 *   browser sign-in; GCM keeps the token in the system's credential store, and KesherAI asks it again whenever it
 *   needs one. KesherAI never writes that token to its own files or logs.
 * - **A one-shot helper for pushes** with the token from KesherAI's device sign-in: given in the environment
 *   (`GIT_CONFIG_*` + {@link TOKEN_ENV}), so the token is never in a URL, a remote, the command line or a log.
 */

/** A user name and password (a token, for GitHub) from git's credential system. */
export interface GitCredential {
  username?: string;
  password: string;
}

/** Runs git with text on stdin; tests pass a fake or a git with a fake helper. */
export type GitRun = (args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; out: string }>;

/** The environment variable the push helper reads the token from (set only for that one git process). */
export const TOKEN_ENV = "KESHER_GITHUB_TOKEN";

/** What `git credential` is asked about: GitHub over https. */
const GITHUB_INPUT = "protocol=https\nhost=github.com\n\n";

/** Settings for every credential call: no terminal prompt and no askpass window (only GCM's own sign-in may show). */
const QUIET = ["-c", "core.askPass="];

/**
 * Runs git (no shell) with text on stdin.
 *
 * @param base - The environment to start from (tests pass one with a fake helper).
 * @returns A {@link GitRun}.
 */
export function gitRunner(base: NodeJS.ProcessEnv = process.env): GitRun {
  return (args, opts) =>
    new Promise((resolve) => {
      let out = "";
      let err = "";
      const child = spawn("git", args, { windowsHide: true, env: { ...base, ...opts.env } });
      const timer = setTimeout(() => child.kill(), opts.timeoutMs);
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: -1, out: "git was not found." });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // stdout carries the secret: it is returned to the caller only, never logged.
        resolve({ code: code ?? -1, out: code === 0 ? out : err.trim().slice(0, 300) });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input ?? "");
    });
}

/**
 * Reads `git credential fill` output (`key=value` lines).
 *
 * @param text - Its stdout.
 * @returns The credential, or undefined when there is no password.
 */
export function parseCredential(text: string): GitCredential | undefined {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
  }
  const password = kv.get("password");
  if (!password) return undefined;
  const username = kv.get("username");
  return username ? { username, password } : { password };
}

/**
 * Whether a helper is Git Credential Manager (`manager`, `manager-core`, or a path to `git-credential-manager`).
 *
 * @param helpers - `git config --get-all credential.helper` output (one per line).
 * @returns Whether GCM is set up for git.
 */
export function isGcmHelper(helpers: string): boolean {
  return helpers.split(/\r?\n/).some((h) => /(^|[\s/\\"'-])manager(-core)?(\.exe)?["']?(\s|$)|git-credential-manager/i.test(h.trim()));
}

/** Git Credential Manager for github.com. */
export class GcmGitHub {
  /** @param run - Runs git (a fake in tests). */
  constructor(private readonly run: GitRun = gitRunner()) {}

  /** @returns Whether git uses GCM for github.com (Git for Windows sets it up by default). */
  async available(): Promise<boolean> {
    const all = await this.run(["config", "--get-all", "credential.helper"], { timeoutMs: 10_000 });
    const gh = await this.run(["config", "--get-all", "credential.https://github.com.helper"], { timeoutMs: 10_000 });
    return isGcmHelper(`${all.code === 0 ? all.out : ""}\n${gh.code === 0 ? gh.out : ""}`);
  }

  /**
   * Asks for the github.com credential.
   *
   * @param interactive - True: GCM may open its browser sign-in (on this computer). False: only a saved one.
   * @param timeoutMs - How long to wait (the user signs in within it when interactive).
   * @returns The credential, or undefined when there is none (or the sign-in was closed).
   */
  async fill(interactive: boolean, timeoutMs = interactive ? 5 * 60_000 : 20_000): Promise<GitCredential | undefined> {
    const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: interactive ? "auto" : "never", GIT_ASKPASS: "", SSH_ASKPASS: "" };
    const r = await this.run([...QUIET, "credential", "fill"], { input: GITHUB_INPUT, env, timeoutMs });
    return r.code === 0 ? parseCredential(r.out) : undefined;
  }

  /**
   * Tells the helpers a credential worked (approve) or did not (reject), as git does after a request.
   *
   * @param c - The credential.
   * @param ok - Whether GitHub accepted it.
   */
  async report(c: GitCredential, ok: boolean): Promise<void> {
    const input = `protocol=https\nhost=github.com\n${c.username ? `username=${c.username}\n` : ""}password=${c.password}\n\n`;
    await this.run([...QUIET, "credential", ok ? "approve" : "reject"], { input, env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, timeoutMs: 20_000 });
  }
}

/**
 * The environment that makes one git process sign in to github.com with a token: a credential helper given as
 * `GIT_CONFIG_*` variables (git 2.31+) that answers from {@link TOKEN_ENV}. Other helpers for github.com are skipped
 * for that process; ssh remotes and other hosts are not touched.
 *
 * @param token - The token (from the device sign-in).
 * @param base - The environment it adds to (keeps `GIT_CONFIG_*` entries already there).
 * @returns Variables to add to the git process's environment.
 */
export function githubTokenEnv(token: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const n = Number.parseInt(base.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const key = "credential.https://github.com.helper";
  // An empty value clears the helpers set before it; the next one reads the token from the environment.
  const helper = `!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: "",
    [`GIT_CONFIG_KEY_${n + 1}`]: key,
    [`GIT_CONFIG_VALUE_${n + 1}`]: helper,
    [TOKEN_ENV]: token,
  };
}
