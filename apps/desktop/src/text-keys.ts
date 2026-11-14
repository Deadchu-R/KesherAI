/**
 * The Text Helper's two keystrokes in another app: Copy (to read what is selected there) and Paste (to put the
 * answer in its place), as AnythingLLM's Magic Beacon and PopClip do. Nothing is read until the user presses the
 * Text Helper's key, and the clipboard is put back as it was.
 *
 * Windows: one small PowerShell helper (started on first use, gone after 15 idle minutes) presses the keys with
 * keybd_event after the user lets go of Ctrl/Alt, so the copy is not read as Ctrl+Alt+C. macOS: System Events
 * (asks once for Accessibility). Linux: the selection is read directly (PRIMARY), and the answer is only copied.
 */
import { clipboard } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const PS_HELPER = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Threading;
public static class KesherKeys {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  static bool Down(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }
  public static void Chord(byte key) {
    for (int i = 0; i < 80 && (Down(0x10) || Down(0x11) || Down(0x12) || Down(0x5B) || Down(0x5C)); i++) Thread.Sleep(25);
    keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
"@
[Console]::Out.WriteLine('ready')
while (($l = [Console]::In.ReadLine()) -ne $null) {
  if ($l -eq 'copy') { [KesherKeys]::Chord(0x43) } elseif ($l -eq 'paste') { [KesherKeys]::Chord(0x56) }
  [Console]::Out.WriteLine('ok')
}
`;

let ps: ChildProcessWithoutNullStreams | undefined;
let idle: NodeJS.Timeout | undefined;
let waiting: Array<() => void> = [];

/** Starts (or reuses) the Windows helper; resolves when it can take a key. */
function winHelper(): Promise<ChildProcessWithoutNullStreams> {
  if (ps && !ps.killed && ps.exitCode === null) return Promise.resolve(ps);
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true });
  ps = child;
  return new Promise((resolve, reject) => {
    let ready = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (line === "ready" && !ready) {
          ready = true;
          resolve(child);
        } else if (line === "ok") waiting.shift()?.();
      }
    });
    child.on("exit", () => {
      if (ps === child) ps = undefined;
      for (const w of waiting) w();
      waiting = [];
      if (!ready) reject(new Error("The keyboard helper did not start."));
    });
    child.stdin.write(`${PS_HELPER}\n`);
  });
}

/** Presses Ctrl+C or Ctrl+V in the app in front (Cmd on a Mac). Resolves when done (or after 2.5 s). */
async function press(key: "copy" | "paste"): Promise<void> {
  if (process.platform === "win32") {
    const child = await winHelper();
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => ps?.kill(), 15 * 60_000);
    idle.unref?.();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2500);
      waiting.push(() => {
        clearTimeout(t);
        resolve();
      });
      child.stdin.write(`${key}\n`);
    });
    return;
  }
  if (process.platform === "darwin") {
    const letter = key === "copy" ? "c" : "v";
    await new Promise<void>((resolve) => {
      const p = spawn("osascript", ["-e", `tell application "System Events" to keystroke "${letter}" using command down`]);
      p.on("exit", () => resolve());
      p.on("error", () => resolve());
    });
  }
}

/** Everything on the clipboard that can be put back (text, HTML, RTF, a picture). */
function saveClipboard(): () => void {
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  return () => {
    const data: Electron.Data = {};
    if (text) data.text = text;
    if (html) data.html = html;
    if (rtf) data.rtf = rtf;
    if (!image.isEmpty()) data.image = image;
    if (Object.keys(data).length) clipboard.write(data);
    else clipboard.clear();
  };
}

/**
 * The text selected in the app in front, read through a Copy (the clipboard is put back after).
 *
 * @returns The text, or "" when nothing was selected (or the app would not copy).
 */
export async function readSelection(): Promise<string> {
  if (process.platform === "linux") return clipboard.readText("selection").trim();
  const restore = saveClipboard();
  clipboard.clear();
  try {
    await press("copy");
    // Some apps fill the clipboard a moment after the key.
    for (let i = 0; i < 12; i++) {
      const t = clipboard.readText();
      if (t) return t.trim();
      await new Promise((r) => setTimeout(r, 40));
    }
    return "";
  } finally {
    restore();
  }
}

/**
 * Puts text in place of the selection in the app in front (a Paste), then the clipboard back as it was.
 * On Linux it is only copied.
 *
 * @param text - The answer.
 * @returns Whether it was pasted (false: it is on the clipboard).
 */
export async function pasteText(text: string): Promise<boolean> {
  if (process.platform === "linux") {
    clipboard.writeText(text);
    return false;
  }
  const restore = saveClipboard();
  clipboard.writeText(text);
  await press("paste");
  // The app reads the clipboard after the key arrives.
  await new Promise((r) => setTimeout(r, 500));
  restore();
  return true;
}
