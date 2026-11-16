/**
 * The server's options, what it returns, and the interface's Content-Security-Policy (types and constants only;
 * docs/ARCHITECTURE_REVIEW.md B1).
 */
import type { FastifyInstance } from "fastify";
import type { GoogleEndpoints } from "../google.js";
import type { Note } from "../notify.js";
import type { OneDriveEndpoints } from "../onedrive.js";
import type { ScreenSource } from "../journal.js";
import type { KesherServices } from "../services.js";
import type { PackagedUpdates } from "../updates.js";

/** Options for `createKesherServer`. All optional. */
export interface KesherServerOptions {
  /** Data folder. Defaults to `KESHER_DATA_DIR` or `~/.kesher`. */
  dataDir?: string;
  /** Port; defaults to the config file's `port`. */
  port?: number;
  /** Built web UI to serve at `/` (the phone uses this). */
  webDir?: string;
  /** Extra plugin folders on top of `<dataDir>/plugins`. */
  pluginRoots?: string[];
  /** Probe LM Studio, Ollama and ComfyUI on start-up (default: the feature flag). */
  autodetect?: boolean;
  /** Fastify request logging. */
  logger?: boolean;
  /** Google endpoints (tests point these at a fake server). */
  googleEndpoints?: GoogleEndpoints;
  /** The project's Google OAuth client (defaults to branding.config.ts; builds pass the one from repository secrets). */
  googleClient?: { clientId: string; clientSecret: string };
  /** Microsoft endpoints (tests point these at a fake server). */
  onedriveEndpoints?: OneDriveEndpoints;
  /** Installed copies: update from GitHub releases (the desktop app passes its version and how to run an installer). */
  updates?: PackagedUpdates;
  /** The desktop app's screen capture for "My day" (no PowerShell, which antivirus programs block). */
  screen?: ScreenSource;
  /** kesher_lipsync.py, shipped with the desktop app (the avatar camera's optional lip sync). */
  lipsyncScript?: string;
  /** The avatar camera without OBS (the Windows desktop app: softcam). */
  virtualCamera?: VirtualCamera;
  /** Shows a notification on this computer (desktop app); returns false when the window is in front. */
  notify?: (n: Note) => boolean | Promise<boolean>;
  /** Keys at rest (S2): the system's protection for connection keys and tokens in config.json (Electron safeStorage). */
  secrets?: import("../config.js").SecretBox;
  /** Brings the desktop window to the front. */
  focusApp?: () => void;
  /** Restarts the desktop app (installing a downloaded update first, if there is one). */
  restartApp?: () => void;
  /** The project's GitHub OAuth App client id, for "Connect with GitHub" (builds pass it from repository secrets). */
  githubClientId?: string;
  /**
   * Worker mode: this is a second, window-less KesherAI that runs self-work, so
   * an update of the main app never stops the work. It uses the main app's
   * models over its local API (waiting while the main app restarts), shares its
   * task board, and sends notifications through it.
   */
  worker?: { mainUrl: string; mainRoot: string; version: string };
  /** Main mode (desktop app): self-work runs in the worker; this starts it when needed and says where it is. */
  workerHost?: { ensure: () => Promise<string>; url: () => string | undefined };
}

/** What `createKesherServer` returns. */
export interface KesherServer {
  app: FastifyInstance;
  services: KesherServices;
  /** Starts listening. Returns the URL. */
  listen(): Promise<string>;
  /** Stops the server, llama-server and plugins. */
  close(): Promise<void>;
}

/**
 * The interface's Content-Security-Policy: scripts, styles, fonts, pictures
 * and connections only from KesherAI itself (and Google's profile pictures).
 * A theme's CSS, a chat's Markdown or a page someone tricked the model into
 * writing cannot load anything from outside or send data away.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Only KesherAI itself and a browser extension (its side panel) may show the app in a frame, never a web site.
  "frame-ancestors 'self' chrome-extension: moz-extension:",
].join("; ");

/** The avatar camera as a real camera device (the desktop app on Windows). */
export interface VirtualCamera {
  status(): Promise<{ available: boolean; installed: boolean; running: boolean }>;
  /** Adds the camera to Windows (Windows asks the person). */
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}
