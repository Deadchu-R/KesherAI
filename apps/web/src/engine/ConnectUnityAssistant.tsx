import { useState } from "react";
import { api, isRemote } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * "Connect to Unity AI Assistant": adds KesherAI to the project's MCP settings,
 * so Unity's own assistant can use KesherAI's local models, image generation,
 * knowledge search and transcription as tools. On the computer only.
 */
export function ConnectUnityAssistant() {
  const [busy, setBusy] = useState(false);
  if (isRemote()) return null;
  return (
    <button
      type="button"
      disabled={busy}
      title={L("מוסיף את KesherAI לשרתי ה-MCP של Unity AI Assistant בפרויקט: העוזר של Unity יוכל להשתמש במודלים המקומיים שלך, ביצירת תמונות ובמאגר הידע.", "Adds KesherAI to the project's Unity AI Assistant MCP servers: Unity's assistant can use your local models, image generation and knowledge base.")}
      onClick={() => {
        setBusy(true);
        void api<{ message: string }>("/api/unity/assistant-connect", { method: "POST" })
          .then((r) => toast(L("KesherAI נוסף ל-Unity AI Assistant. ב-Unity: Edit → Project Settings → AI → Assistant MCP Extensions → Refresh File and Servers.", r.message)), (e: Error) => toast(e.message))
          .finally(() => setBusy(false));
      }}
    >
      🔌 {L("חבר ל-Unity AI Assistant", "Connect to Unity AI Assistant")}
    </button>
  );
}
