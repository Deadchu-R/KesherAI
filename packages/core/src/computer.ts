import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";

/**
 * Computer control: lets a model with vision look at the screen and click,
 * type and scroll, like a person at the keyboard.
 *
 * Safety, enforced here and not left to the model:
 * - Off until the user turns it on (Settings → Computer control).
 * - Per app: the model asks (`computer_use_app`, an approval card) before it
 *   may act in an app, per conversation. The app in front is checked before
 *   every action.
 * - Browsers are view-only (screenshots, no clicks or typing): websites go
 *   through the browser tools, where sign-ins stay the user's. Terminals and
 *   file managers are click-only (no typing), so commands go through
 *   run_command, which shows the exact command for approval.
 * - No typing in windows about passwords, sign-in, payment or banking.
 * - A Stop button and Ctrl+Alt+Esc (desktop app) stop every session at once.
 * - Every action is logged (`/api/computer/status`).
 */

/** What kind of app is in front, which decides what the model may do there. */
export type AppKind = "full" | "view-only" | "click-only";

const BROWSERS =
  /^(chrome|msedge|firefox|brave|opera|vivaldi|safari|arc|chromium|iexplore|google chrome|microsoft edge)$/i;
const CLICK_ONLY =
  /^(cmd|powershell|pwsh|windowsterminal|wt|conhost|openconsole|terminal|iterm2|alacritty|wezterm|kitty|gnome-terminal|konsole|xterm|tilix|explorer|finder|nautilus|dolphin|thunar|regedit|taskmgr|mmc)$/i;
const SENSITIVE =
  /(password|passcode|sign[ -]?in|log[ -]?in|2fa|two-factor|verification code|bank|payment|checkout|credit card|paypal|wallet|סיסמ|התחבר|כניסה לחשבון|תשלום|כרטיס אשראי|בנק)/i;

/**
 * @param app - Process name of the app in front (without `.exe`).
 * @returns What the model may do in it.
 */
export function appKind(app: string): AppKind {
  const name = app.replace(/\.exe$/i, "").trim();
  if (BROWSERS.test(name)) return "view-only";
  if (CLICK_ONLY.test(name)) return "click-only";
  return "full";
}

/**
 * @param title - The window title.
 * @returns Whether typing is refused there (passwords, sign-in, payment).
 */
export function isSensitiveWindow(title: string): boolean {
  return SENSITIVE.test(title);
}

/** The app and window in front. */
export interface Foreground {
  app: string;
  title: string;
}

/** What a platform must do. Coordinates are physical screen pixels. */
interface Backend {
  /** left/top: where the picture starts on the desktop (a monitor left of or above the main one makes them negative). */
  screenshot(
    maxWidth: number,
  ): Promise<{
    png: Buffer;
    scale: number;
    width: number;
    height: number;
    left?: number;
    top?: number;
  }>;
  /** A part of the screen (physical pixels) at up to maxWidth wide: small text and icons, readable. */
  zoom?(
    x: number,
    y: number,
    w: number,
    h: number,
    maxWidth: number,
  ): Promise<{ png: Buffer; width: number; height: number }>;
  drag?(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  /** Brings an app to the front, starting it when it is not running. Returns false when it could not. */
  activate?(app: string): Promise<boolean>;
  foreground(): Promise<Foreground>;
  click(
    x: number,
    y: number,
    button: "left" | "right",
    double: boolean,
  ): Promise<void>;
  move(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(x: number, y: number, amount: number): Promise<void>;
}

function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(
              `${cmd} failed: ${(stderr || err.message).toString().trim().slice(0, 400)}`,
            ),
          );
        else resolve(stdout.toString());
      },
    );
  });
}

// ---------- Windows: PowerShell + user32, no extra software ----------
const WIN_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class K {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
}
'@
[K]::SetProcessDPIAware() | Out-Null
`;
const ps = (script: string) =>
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WIN_PRELUDE + script,
  ]);
const psStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Turns text into SendKeys syntax (special characters wrapped in braces). */
export function sendKeysText(text: string): string {
  return text
    .replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
    .replace(/\r?\n/g, "{ENTER}")
    .replace(/\t/g, "{TAB}");
}

const SENDKEYS_NAMES: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  esc: "{ESC}",
  escape: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  space: " ",
  f1: "{F1}",
  f2: "{F2}",
  f3: "{F3}",
  f4: "{F4}",
  f5: "{F5}",
  f6: "{F6}",
  f7: "{F7}",
  f8: "{F8}",
  f9: "{F9}",
  f10: "{F10}",
  f11: "{F11}",
  f12: "{F12}",
};

/**
 * @param combo - e.g. `ctrl+s`, `alt+f4`, `enter`, `ctrl+shift+t`.
 * @returns SendKeys syntax, e.g. `^s`.
 */
export function sendKeysCombo(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = parts
    .map((m) =>
      m === "ctrl" || m === "control"
        ? "^"
        : m === "shift"
          ? "+"
          : m === "alt"
            ? "%"
            : "",
    )
    .join("");
  const k =
    SENDKEYS_NAMES[key] ??
    (key.length === 1 ? sendKeysText(key) : `{${key.toUpperCase()}}`);
  return mods + k;
}

const windows: Backend = {
  async screenshot(maxWidth) {
    const file = join(tmpdir(), `kesher-shot-${randomUUID()}.png`);
    const out = await ps(`
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
$scale = [Math]::Min(1.0, ${maxWidth} / $b.Width)
$w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
$small = New-Object System.Drawing.Bitmap $bmp, $w, $h
$small.Save(${psStr(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$scale $w $h $($b.Left) $($b.Top)"`);
    const [scale, w, h, left, top] = out.trim().split(/\s+/).map(Number);
    const png = await readFile(file);
    await rm(file, { force: true });
    return {
      png,
      scale: scale || 1,
      width: w || 0,
      height: h || 0,
      left: left || 0,
      top: top || 0,
    };
  },
  async zoom(x, y, w, h, maxWidth) {
    const file = join(tmpdir(), `kesher-zoom-${randomUUID()}.png`);
    const [X, Y, W, H] = [x, y, w, h].map((n) => Math.round(n));
    const out = await ps(`
$bmp = New-Object System.Drawing.Bitmap ${W}, ${H}
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${X}, ${Y}, 0, 0, $bmp.Size); $g.Dispose()
$s = [Math]::Min(2.0, ${maxWidth} / ${W}); $w = [int](${W} * $s); $h = [int](${H} * $s)
$big = New-Object System.Drawing.Bitmap $bmp, $w, $h
$big.Save(${psStr(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$w $h"`);
    const [width = 0, height = 0] = out.trim().split(/\s+/).map(Number);
    const png = await readFile(file);
    await rm(file, { force: true });
    return { png, width, height };
  },
  async drag(x1, y1, x2, y2) {
    const steps = [0.25, 0.5, 0.75, 1]
      .map(
        (t) =>
          `[K]::SetCursorPos(${Math.round(x1 + (x2 - x1) * t)}, ${Math.round(y1 + (y2 - y1) * t)}) | Out-Null; Start-Sleep -Milliseconds 40`,
      )
      .join("; ");
    await ps(
      `[K]::SetCursorPos(${Math.round(x1)}, ${Math.round(y1)}) | Out-Null; Start-Sleep -Milliseconds 60; [K]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80; ${steps}; [K]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)`,
    );
  },
  async activate(app) {
    // The newest window of a running process with that name; else start the app by name (Start menu's App Paths).
    const out = await ps(`
$p = Get-Process -Name ${psStr(app)} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { [K]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; [K]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Write-Output "front" }
else { try { Start-Process ${psStr(app)}; Start-Sleep -Milliseconds 1500; Write-Output "started" } catch { Write-Output "none" } }`).catch(
      () => "none",
    );
    return /front|started/.test(out);
  },
  async foreground() {
    const out = await ps(`
$h = [K]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512; [K]::GetWindowText($h, $sb, 512) | Out-Null
$p = 0; [K]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
$name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
Write-Output "$name"; Write-Output $sb.ToString()`);
    const [app = "", ...title] = out.split(/\r?\n/);
    return { app: app.trim(), title: title.join(" ").trim() };
  },
  async click(x, y, button, double) {
    const [down, up] = button === "right" ? [0x0008, 0x0010] : [0x0002, 0x0004];
    const once = `[K]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [K]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`;
    await ps(
      `[K]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; Start-Sleep -Milliseconds 60; ${once}${double ? `; Start-Sleep -Milliseconds 90; ${once}` : ""}`,
    );
  },
  async move(x, y) {
    await ps(
      `[K]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`,
    );
  },
  async type(text) {
    await ps(
      `[System.Windows.Forms.SendKeys]::SendWait(${psStr(sendKeysText(text))})`,
    );
  },
  async key(combo) {
    await ps(
      `[System.Windows.Forms.SendKeys]::SendWait(${psStr(sendKeysCombo(combo))})`,
    );
  },
  async scroll(x, y, amount) {
    await ps(
      `[K]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; [K]::mouse_event(0x0800,0,0,${Math.round(-amount * 120)},[UIntPtr]::Zero)`,
    );
  },
};

// ---------- macOS: screencapture + System Events (needs Accessibility and Screen Recording permission) ----------
const osa = (script: string) => run("osascript", ["-e", script]);
const mac: Backend = {
  async screenshot(maxWidth) {
    const file = join(tmpdir(), `kesher-shot-${randomUUID()}.png`);
    await run("screencapture", ["-x", "-C", file]);
    const info = await run("sips", [
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      file,
    ]);
    const width = Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 0);
    const height = Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 0);
    const scale = width > maxWidth ? maxWidth / width : 1;
    if (scale < 1)
      await run("sips", ["--resampleWidth", String(maxWidth), file]);
    const png = await readFile(file);
    await rm(file, { force: true });
    // System Events uses points; Retina screenshots are in pixels (usually 2×).
    const points = Number(
      (
        await osa(
          'tell application "Finder" to get bounds of window of desktop',
        )
      ).split(",")[2] ?? width,
    );
    return {
      png,
      scale: scale * (points ? width / points : 1),
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  },
  async foreground() {
    const out = await osa(
      'tell application "System Events" to set p to first application process whose frontmost is true\ntell application "System Events" to return (name of p) & "\\n" & (name of front window of p)',
    ).catch(() => "");
    const [app = "", title = ""] = out.split("\n");
    return { app: app.trim(), title: title.trim() };
  },
  async click(x, y, button, double) {
    const what =
      button === "right" ? "right click" : double ? "double click" : "click";
    // `cliclick` is precise when installed; System Events otherwise.
    try {
      await run("cliclick", [
        `${button === "right" ? "rc" : double ? "dc" : "c"}:${Math.round(x)},${Math.round(y)}`,
      ]);
    } catch {
      await osa(
        `tell application "System Events" to ${what.replace("right click", "click")} at {${Math.round(x)}, ${Math.round(y)}}`,
      );
    }
  },
  async move(x, y) {
    await run("cliclick", [`m:${Math.round(x)},${Math.round(y)}`]).catch(
      () => undefined,
    );
  },
  async type(text) {
    await osa(
      `tell application "System Events" to keystroke ${JSON.stringify(text)}`,
    );
  },
  async key(combo) {
    const parts = combo
      .toLowerCase()
      .split("+")
      .map((p) => p.trim());
    const key = parts.pop() ?? "";
    const mods = parts
      .map((m) =>
        m === "ctrl" || m === "control"
          ? "control down"
          : m === "cmd" || m === "command" || m === "meta"
            ? "command down"
            : m === "shift"
              ? "shift down"
              : m === "alt" || m === "option"
                ? "option down"
                : "",
      )
      .filter(Boolean);
    const codes: Record<string, number> = {
      enter: 36,
      return: 36,
      tab: 48,
      space: 49,
      backspace: 51,
      delete: 117,
      esc: 53,
      escape: 53,
      left: 123,
      right: 124,
      down: 125,
      up: 126,
      home: 115,
      end: 119,
      pageup: 116,
      pagedown: 121,
    };
    const using = mods.length ? ` using {${mods.join(", ")}}` : "";
    await osa(
      codes[key] !== undefined
        ? `tell application "System Events" to key code ${codes[key]}${using}`
        : `tell application "System Events" to keystroke ${JSON.stringify(key)}${using}`,
    );
  },
  async activate(app) {
    return osa(`tell application ${JSON.stringify(app)} to activate`).then(
      () => true,
      () => false,
    );
  },
  async drag(x1, y1, x2, y2) {
    await run("cliclick", [
      `dd:${Math.round(x1)},${Math.round(y1)}`,
      `du:${Math.round(x2)},${Math.round(y2)}`,
    ]);
  },
  async scroll(x, y, amount) {
    await this.move(x, y);
    await osa(
      `tell application "System Events" to key code ${amount > 0 ? 121 : 116}`,
    );
  },
};

// ---------- Linux (X11): xdotool + ImageMagick ----------
const linux: Backend = {
  async screenshot(maxWidth) {
    const file = join(tmpdir(), `kesher-shot-${randomUUID()}.png`);
    await run("import", [
      "-window",
      "root",
      "-resize",
      `${maxWidth}x>`,
      file,
    ]).catch(() => run("scrot", ["-o", file]));
    const geo = await run("xdotool", ["getdisplaygeometry"]).catch(() => "0 0");
    const [w = 0] = geo.trim().split(/\s+/).map(Number);
    const png = await readFile(file);
    await rm(file, { force: true });
    const scale = w > maxWidth ? maxWidth / w : 1;
    return { png, scale, width: Math.round(w * scale), height: 0 };
  },
  async foreground() {
    const id = (
      await run("xdotool", ["getactivewindow"]).catch(() => "")
    ).trim();
    if (!id) return { app: "", title: "" };
    const title = (
      await run("xdotool", ["getwindowname", id]).catch(() => "")
    ).trim();
    const pid = (
      await run("xdotool", ["getwindowpid", id]).catch(() => "")
    ).trim();
    const app = pid
      ? (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim()
      : "";
    return { app, title };
  },
  async click(x, y, button, double) {
    await run("xdotool", [
      "mousemove",
      String(Math.round(x)),
      String(Math.round(y)),
      "click",
      ...(double ? ["--repeat", "2"] : []),
      button === "right" ? "3" : "1",
    ]);
  },
  async move(x, y) {
    await run("xdotool", [
      "mousemove",
      String(Math.round(x)),
      String(Math.round(y)),
    ]);
  },
  async type(text) {
    await run("xdotool", ["type", "--delay", "20", "--", text]);
  },
  async key(combo) {
    await run("xdotool", [
      "key",
      combo
        .replace(/\bctrl\b/gi, "ctrl")
        .replace(/\benter\b/gi, "Return")
        .replace(/\besc\b/gi, "Escape"),
    ]);
  },
  async activate(app) {
    return run("xdotool", [
      "search",
      "--onlyvisible",
      "--class",
      app,
      "windowactivate",
    ]).then(
      () => true,
      () => false,
    );
  },
  async drag(x1, y1, x2, y2) {
    await run("xdotool", [
      "mousemove",
      String(Math.round(x1)),
      String(Math.round(y1)),
      "mousedown",
      "1",
      "mousemove",
      String(Math.round(x2)),
      String(Math.round(y2)),
      "mouseup",
      "1",
    ]);
  },
  async scroll(x, y, amount) {
    await run("xdotool", [
      "mousemove",
      String(Math.round(x)),
      String(Math.round(y)),
      "click",
      "--repeat",
      String(Math.min(20, Math.abs(Math.round(amount)) || 1)),
      amount > 0 ? "5" : "4",
    ]);
  },
};

/** The screen backend for this platform (also used by the journal). */
export function screenBackend(): Pick<Backend, "screenshot" | "foreground"> {
  return backend();
}

function backend(): Backend {
  return process.platform === "win32"
    ? windows
    : process.platform === "darwin"
      ? mac
      : linux;
}

/** One logged action. */
export interface ComputerAction {
  at: string;
  conversationId: string;
  action: string;
  app: string;
  ok: boolean;
  note?: string;
}

/** Keeps per-conversation app approvals, the stop switch and the action log. */
export class ComputerControl {
  private readonly allowed = new Map<string, Set<string>>();
  /** Per conversation: how the last screenshot maps to the desktop (scale, and where it starts). */
  private readonly scales = new Map<
    string,
    { scale: number; left: number; top: number; width: number; height: number }
  >();
  private readonly log: ComputerAction[] = [];
  private stoppedAt = 0;
  private lastActionAt = 0;
  private lastApp = "";

  /**
   * @param enabled - Whether the user turned computer control on.
   * @param onStop - Stops the conversations that used it.
   * @param be - Platform backend (tests pass a fake).
   */
  constructor(
    private readonly enabled: () => boolean,
    private readonly onStop: (conversationIds: string[]) => void,
    private readonly be: Backend = backend(),
  ) {}

  /** @returns Whether it is on, whether it acted in the last 15 s, the app, and the last 30 actions. */
  status(): {
    enabled: boolean;
    active: boolean;
    app: string;
    log: ComputerAction[];
  } {
    return {
      enabled: this.enabled(),
      active: Date.now() - this.lastActionAt < 15_000,
      app: this.lastApp,
      log: this.log.slice(-30),
    };
  }

  /**
   * A picture of the screen for the user to watch (from the phone, say),
   * only while computer control is on.
   *
   * @param maxWidth - Width at most.
   * @returns PNG bytes.
   */
  async watch(maxWidth = 960): Promise<Buffer> {
    if (!this.enabled()) throw new Error("Computer control is off.");
    if (Date.now() - this.lastWatch < 400)
      return this.lastShot ?? (await this.be.screenshot(maxWidth)).png;
    this.lastWatch = Date.now();
    this.lastShot = (
      await this.be.screenshot(Math.min(1600, Math.max(320, maxWidth)))
    ).png;
    return this.lastShot;
  }

  private lastWatch = 0;
  private lastShot?: Buffer;

  /** Stops every conversation that controls the computer, and refuses actions for 10 seconds. */
  stop(): void {
    this.stoppedAt = Date.now();
    const ids = [
      ...new Set(
        this.log
          .filter((a) => Date.now() - Date.parse(a.at) < 10 * 60_000)
          .map((a) => a.conversationId),
      ),
    ];
    this.onStop(ids);
    this.record({
      conversationId: "-",
      action: "stop",
      app: "",
      ok: true,
      note: "Stopped by the user",
    });
  }

  /**
   * Allows a conversation to act in an app (after the user approved it).
   *
   * @param conversationId - Conversation.
   * @param app - Process name, e.g. `notepad`.
   */
  allow(conversationId: string, app: string): void {
    const set = this.allowed.get(conversationId) ?? new Set<string>();
    set.add(app.replace(/\.exe$/i, "").toLowerCase());
    this.allowed.set(conversationId, set);
  }

  private record(a: Omit<ComputerAction, "at">): void {
    this.log.push({ at: new Date().toISOString(), ...a });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.lastActionAt = Date.now();
    if (a.app) this.lastApp = a.app;
  }

  private gate(conversationId: string): void {
    if (!this.enabled())
      throw new Error(
        "Computer control is off. The user can turn it on in Settings → Computer control.",
      );
    if (Date.now() - this.stoppedAt < 10_000)
      throw new Error(
        "The user pressed Stop. Do not continue controlling the computer; tell the user what you were doing.",
      );
    if (!this.allowed.get(conversationId)?.size)
      throw new Error(
        "First ask the user which app you may use: call computer_use_app with its name.",
      );
  }

  /**
   * Checks the app in front before an action.
   *
   * @returns The app and what may be done there.
   * @throws Error if the app is not allowed for this conversation or the action is not allowed in it.
   */
  private async check(
    conversationId: string,
    need: "click" | "type",
  ): Promise<Foreground> {
    this.gate(conversationId);
    const fg = await this.be.foreground();
    const key = fg.app.replace(/\.exe$/i, "").toLowerCase();
    const kind = appKind(fg.app);
    if (kind === "view-only")
      throw new Error(
        `${fg.app} is a web browser: KesherAI only looks at browsers, it does not click or type in them. Use the web tools (web_fetch, web_search), or ask the user.`,
      );
    if (need === "type" && kind === "click-only")
      throw new Error(
        `${fg.app} is a terminal or file manager: typing there is not allowed. Run commands with run_command (the user sees and approves them).`,
      );
    if (need === "type" && isSensitiveWindow(fg.title))
      throw new Error(
        `The window "${fg.title}" looks like a password, sign-in or payment screen. KesherAI never types there: ask the user to do this part.`,
      );
    if (!this.allowed.get(conversationId)?.has(key))
      throw new Error(
        `The app in front is ${fg.app || "unknown"} ("${fg.title}"), which the user has not allowed. Call computer_use_app for it, or bring an allowed app to the front.`,
      );
    return fg;
  }

  /**
   * The computer-control tools for one conversation.
   *
   * @param conversationId - Conversation.
   * @returns Tools; empty when computer control is off.
   */
  tools(conversationId: string): AgentTool[] {
    if (!this.enabled()) return [];
    const view = () =>
      this.scales.get(conversationId) ?? {
        scale: 1,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      };
    // Screenshot pixels → desktop pixels: undo the shrink, then add where the picture starts (other monitors).
    const toScreen = (x: unknown, y: unknown) => {
      const X = Number(x),
        Y = Number(y);
      if (!Number.isFinite(X) || !Number.isFinite(Y))
        throw new Error(
          "Give x and y in screenshot pixels (from the last computer_screenshot).",
        );
      const v = view();
      if (
        v.width &&
        (X < 0 || Y < 0 || X > v.width || (v.height && Y > v.height))
      )
        throw new Error(
          `(${X},${Y}) is outside the last screenshot (${v.width}×${v.height}).`,
        );
      return { x: X / v.scale + v.left, y: Y / v.scale + v.top };
    };
    const pt = (input: Record<string, unknown>) => toScreen(input.x, input.y);
    const shoot = async () => {
      const shot = await this.be.screenshot(1280);
      this.scales.set(conversationId, {
        scale: shot.scale,
        left: shot.left ?? 0,
        top: shot.top ?? 0,
        width: shot.width,
        height: shot.height,
      });
      const fg = await this.be
        .foreground()
        .catch(() => ({ app: "", title: "" }));
      return { shot, fg };
    };
    const act = async (
      name: string,
      need: "click" | "type",
      input: Record<string, unknown>,
      fn: () => Promise<void>,
      describe: string,
    ) => {
      let fg: Foreground = { app: "", title: "" };
      try {
        fg = await this.check(conversationId, need);
        await fn();
        this.record({
          conversationId,
          action: describe,
          app: fg.app,
          ok: true,
        });
        await new Promise((r) => setTimeout(r, 350));
        return {
          output: `Done: ${describe} in ${fg.app}. Take a screenshot to see the result.`,
        };
      } catch (err) {
        this.record({
          conversationId,
          action: describe,
          app: fg.app,
          ok: false,
          note: (err as Error).message,
        });
        throw err;
      }
    };
    const xy = {
      x: {
        type: "integer",
        description: "From the left, in screenshot pixels.",
      },
      y: {
        type: "integer",
        description: "From the top, in screenshot pixels.",
      },
    };
    return [
      {
        risk: "exec",
        spec: {
          name: "computer_use_app",
          description:
            "Ask the user to let you see the screen and control one app (by its name, e.g. Notepad, Excel, Unity, Blender). Needed once per app per conversation before clicking or typing. Browsers can only be looked at; terminals and file managers only clicked.",
          inputSchema: {
            type: "object",
            properties: {
              app: {
                type: "string",
                description:
                  "The app's name or process name, e.g. notepad, excel, unity.",
              },
              why: {
                type: "string",
                description:
                  "One sentence for the user: what you will do there.",
              },
            },
            required: ["app"],
          },
        },
        preview: async (input) =>
          `Let the model see your screen and control ${String(input.app)}.${input.why ? `\n${String(input.why)}` : ""}\n\nStop at any time with the Stop button or Ctrl+Alt+Esc. It never types passwords or payment details.`,
        run: async (input) => {
          const app = String(input.app ?? "").trim();
          if (!app) throw new Error("Name the app.");
          this.allow(conversationId, app);
          this.record({
            conversationId,
            action: `allowed ${app}`,
            app,
            ok: true,
          });
          return {
            output: `The user allowed ${app}. Bring it to the front if needed (it must be the active window), take a screenshot, then act.`,
          };
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_screenshot",
          description:
            "See the screen now. Returns a picture; coordinates in it are what click/scroll/move use.",
          inputSchema: { type: "object", properties: {} },
        },
        run: async () => {
          this.gate(conversationId);
          const { shot, fg } = await shoot();
          this.record({
            conversationId,
            action: "screenshot",
            app: fg.app,
            ok: true,
          });
          return {
            output: `Screenshot ${shot.width}×${shot.height}. In front: ${fg.app} "${fg.title}" (${appKind(fg.app)}).`,
            images: [
              { mimeType: "image/png", data: shot.png.toString("base64") },
            ],
          };
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_click",
          description: "Click at a point of the last screenshot.",
          inputSchema: {
            type: "object",
            properties: {
              ...xy,
              button: { type: "string", enum: ["left", "right"] },
              double: { type: "boolean" },
            },
            required: ["x", "y"],
          },
        },
        run: async (input) => {
          const p = pt(input);
          return act(
            "click",
            "click",
            input,
            () =>
              this.be.click(
                p.x,
                p.y,
                input.button === "right" ? "right" : "left",
                input.double === true,
              ),
            `${input.double ? "double-" : ""}${input.button === "right" ? "right-" : ""}click at ${input.x},${input.y}`,
          );
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_type",
          description: "Type text into the focused field of the app in front.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        run: async (input) => {
          const text = String(input.text ?? "");
          return act(
            "type",
            "type",
            input,
            () => this.be.type(text),
            `typed ${text.length} characters`,
          );
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_key",
          description:
            "Press a key or shortcut, e.g. enter, tab, esc, ctrl+s, ctrl+shift+n, alt+tab.",
          inputSchema: {
            type: "object",
            properties: { keys: { type: "string" } },
            required: ["keys"],
          },
        },
        run: async (input) => {
          const keys = String(input.keys ?? "");
          // Shortcuts are typing as far as safety goes (they can paste, save, run).
          return act(
            "key",
            /^(up|down|left|right|tab|esc|escape|pageup|pagedown|home|end)$/i.test(
              keys,
            )
              ? "click"
              : "type",
            input,
            () => this.be.key(keys),
            `pressed ${keys}`,
          );
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_scroll",
          description:
            "Scroll at a point: positive amount = down, negative = up (in notches).",
          inputSchema: {
            type: "object",
            properties: { ...xy, amount: { type: "integer" } },
            required: ["x", "y", "amount"],
          },
        },
        run: async (input) => {
          const p = pt(input);
          return act(
            "scroll",
            "click",
            input,
            () => this.be.scroll(p.x, p.y, Number(input.amount ?? 3)),
            `scrolled ${input.amount} at ${input.x},${input.y}`,
          );
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_open_app",
          description:
            "Bring an app the user already allowed (computer_use_app) to the front, starting it if it is not running. Use it instead of clicking the taskbar or alt+tab.",
          inputSchema: {
            type: "object",
            properties: {
              app: {
                type: "string",
                description:
                  "The allowed app's process name, e.g. notepad, Unity.",
              },
            },
            required: ["app"],
          },
        },
        run: async (input) => {
          this.gate(conversationId);
          const app = String(input.app ?? "")
            .trim()
            .replace(/\.exe$/i, "");
          if (!/^[A-Za-z0-9 ._-]{1,60}$/.test(app))
            throw new Error(
              "Give the app's name (letters, digits, spaces, . _ -).",
            );
          if (!this.allowed.get(conversationId)?.has(app.toLowerCase()))
            throw new Error(
              `${app} is not allowed yet: call computer_use_app for it first.`,
            );
          if (appKind(app) === "view-only")
            throw new Error(
              `${app} is a web browser: use the browser tools for websites.`,
            );
          if (!this.be.activate)
            throw new Error(
              "Bringing apps to the front is not supported on this computer: ask the user to.",
            );
          const ok = await this.be.activate(app);
          this.record({ conversationId, action: `opened ${app}`, app, ok });
          return {
            output: ok
              ? `${app} is in front (or starting). Take a screenshot.`
              : `Could not find or start ${app}. Ask the user to open it.`,
          };
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_zoom",
          description:
            "See a part of the last screenshot larger, for small text or icons. x, y, width, height are in screenshot pixels. Coordinates for clicking stay those of the full screenshot.",
          inputSchema: {
            type: "object",
            properties: {
              ...xy,
              width: { type: "integer" },
              height: { type: "integer" },
            },
            required: ["x", "y", "width", "height"],
          },
        },
        run: async (input) => {
          this.gate(conversationId);
          if (!this.be.zoom)
            throw new Error(
              "Zoom is not supported on this computer; take a screenshot instead.",
            );
          const a = toScreen(input.x, input.y);
          const v = view();
          const w = Math.max(8, Number(input.width) / v.scale),
            h = Math.max(8, Number(input.height) / v.scale);
          if (!Number.isFinite(w) || !Number.isFinite(h))
            throw new Error("Give width and height.");
          const z = await this.be.zoom(a.x, a.y, w, h, 1280);
          this.record({
            conversationId,
            action: `zoom ${input.x},${input.y} ${input.width}×${input.height}`,
            app: "",
            ok: true,
          });
          return {
            output: `Zoomed ${input.width}×${input.height} at ${input.x},${input.y} → ${z.width}×${z.height}.`,
            images: [{ mimeType: "image/png", data: z.png.toString("base64") }],
          };
        },
      },
      {
        risk: "read",
        spec: {
          name: "computer_batch",
          description:
            "Do several actions in a row, then get ONE screenshot at the end: fewer steps and tokens than one tool call per action. Use it when you can predict the steps (e.g. click a field, type, press enter). Each action is checked like the single tools; it stops at the first one that fails. Actions: {action:'click',x,y,button?,double?}, {action:'type',text}, {action:'key',keys}, {action:'scroll',x,y,amount}, {action:'drag',x,y,to_x,to_y}, {action:'wait',seconds}.",
          inputSchema: {
            type: "object",
            properties: {
              actions: {
                type: "array",
                items: { type: "object" },
                maxItems: 20,
              },
            },
            required: ["actions"],
          },
        },
        run: async (input) => {
          const list = Array.isArray(input.actions)
            ? (input.actions as Array<Record<string, unknown>>).slice(0, 20)
            : [];
          if (!list.length) throw new Error("Give the actions.");
          const done: string[] = [];
          let failed = "";
          for (const a of list) {
            try {
              const kind = String(a.action ?? "");
              if (kind === "click") {
                const p = pt(a);
                await act(
                  "click",
                  "click",
                  a,
                  () =>
                    this.be.click(
                      p.x,
                      p.y,
                      a.button === "right" ? "right" : "left",
                      a.double === true,
                    ),
                  `${a.double ? "double-" : ""}click at ${a.x},${a.y}`,
                );
              } else if (kind === "type") {
                const text = String(a.text ?? "");
                await act(
                  "type",
                  "type",
                  a,
                  () => this.be.type(text),
                  `typed ${text.length} characters`,
                );
              } else if (kind === "key") {
                const keys = String(a.keys ?? "");
                await act(
                  "key",
                  /^(up|down|left|right|tab|esc|escape|pageup|pagedown|home|end)$/i.test(
                    keys,
                  )
                    ? "click"
                    : "type",
                  a,
                  () => this.be.key(keys),
                  `pressed ${keys}`,
                );
              } else if (kind === "scroll") {
                const p = pt(a);
                await act(
                  "scroll",
                  "click",
                  a,
                  () => this.be.scroll(p.x, p.y, Number(a.amount ?? 3)),
                  `scrolled ${a.amount} at ${a.x},${a.y}`,
                );
              } else if (kind === "drag") {
                const p = pt(a),
                  q = toScreen(a.to_x, a.to_y);
                if (!this.be.drag)
                  throw new Error(
                    "Dragging is not supported on this computer.",
                  );
                await act(
                  "drag",
                  "type",
                  a,
                  () => this.be.drag!(p.x, p.y, q.x, q.y),
                  `dragged ${a.x},${a.y} → ${a.to_x},${a.to_y}`,
                );
              } else if (kind === "wait") {
                this.gate(conversationId);
                await new Promise((r) =>
                  setTimeout(
                    r,
                    Math.min(Math.max(Number(a.seconds) || 1, 0.1), 10) * 1000,
                  ),
                );
              } else throw new Error(`Unknown action "${kind}".`);
              done.push(kind);
            } catch (err) {
              failed = `Action ${done.length + 1} (${String(a.action)}) failed: ${(err as Error).message}`;
              break;
            }
          }
          if (/pressed Stop|is off/.test(failed))
            return {
              output: `${done.length} of ${list.length} actions done. ${failed}`,
              isError: true,
            };
          const { shot, fg } = await shoot();
          return {
            output: `${done.length} of ${list.length} actions done.${failed ? ` ${failed}` : ""} Screenshot ${shot.width}×${shot.height}. In front: ${fg.app} "${fg.title}".`,
            isError: !!failed,
            images: [
              { mimeType: "image/png", data: shot.png.toString("base64") },
            ],
          };
        },
      },
    ];
  }
}
