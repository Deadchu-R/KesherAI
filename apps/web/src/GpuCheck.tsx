/**
 * "Check the graphics card" on the Models page: which cards KesherAI found, which engine build it uses, whether
 * Linux has the Vulkan driver the card needs (with the command for this distribution), and what the engine said
 * about the card when it started. Copyable, to send when something is wrong.
 */
import { useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Check {
  gpus: Array<{ name: string; vendor: string; vramGb: number }>;
  platform: { platform: string; arch: string; nvidia: boolean; vulkan?: boolean; vulkanMissing?: boolean; vulkanHint?: string };
  vulkanDrivers: string[];
  build: string;
  engineLibs: string[];
  engineLog: string[];
}

export function GpuCheck() {
  const [c, setC] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setC(await api<Check>("/api/engines/gpu-check"));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const text = c ? JSON.stringify(c, null, 2) : "";
  const onCard = c ? c.engineLibs.some((f) => /cuda|vulkan|hip|sycl|metal|opencl/i.test(f)) : false;
  return (
    <details className="gpu-check" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !c && void run()}>
      <summary className="muted small">{L("בדיקת כרטיס מסך", "Check the graphics card")}</summary>
      {busy && <p className="muted small">{L("בודק…", "Checking…")}</p>}
      {c && (
        <div className="stack small">
          <p dir="auto">{c.gpus.length ? c.gpus.map((g) => `${g.name} (${g.vendor || "?"}, ${g.vramGb} GB)`).join(", ") : L("לא נמצא כרטיס מסך.", "No graphics card was found.")}</p>
          <p dir="auto">{L("המנוע: ", "Engine: ")}{c.build || (onCard ? L("גרסה לכרטיס", "a graphics card build") : L("לא ידוע", "unknown"))}{" · "}{onCard ? L("משתמש בכרטיס", "uses the card") : L("רץ על המעבד בלבד", "runs on the processor only")}</p>
          {c.platform.vulkanMissing && (
            <div className="stack">
              <p className="error" dir="auto">{L("לכרטיס חסר מנהל ההתקן של Vulkan. הריצו בטרמינל, ואז פתחו את KesherAI מחדש:", "The card is missing its Vulkan driver. Run this in a terminal, then open KesherAI again:")}</p>
              <div className="row"><code className="grow" dir="ltr">{c.platform.vulkanHint}</code><button type="button" className="small" onClick={() => void navigator.clipboard.writeText(c.platform.vulkanHint ?? "").then(() => toast(L("הועתק", "Copied")))}>{L("העתק", "Copy")}</button></div>
            </div>
          )}
          {c.platform.platform === "linux" && <p className="muted" dir="ltr">Vulkan drivers: {c.vulkanDrivers.join(", ") || "none"}</p>}
          {c.engineLog.length > 0 && <pre className="ctx-text" dir="ltr">{c.engineLog.join("\n")}</pre>}
          <div className="row">
            <button type="button" className="small" onClick={() => void run()}>{L("בדוק שוב", "Check again")}</button>
            <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(text).then(() => toast(L("הועתק: אפשר להדביק ולשלוח", "Copied: paste it to send")))}>{L("העתק את כל הבדיקה", "Copy the whole check")}</button>
          </div>
        </div>
      )}
    </details>
  );
}
