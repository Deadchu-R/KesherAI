/**
 * "Chats at once" for the built-in engine (llama.cpp's slots): how many chats it answers at the same time. One
 * by default: the whole context goes to one chat (measured on an RTX 3090: about 75K tokens instead of 49K each
 * for two, at the same writing speed). More lets a phone chat, self-work and another chat run together, each with
 * a smaller context. Shown in Settings → Computer and graphics card, and on the Models page.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, t } from "./i18n";
import { Select } from "./ui/Select";
import { FitMargin } from "./FitPreview";

interface Engine { installed: boolean; running: boolean; parallel?: number; runningParallel?: number; slotTokens?: number }

/**
 * The picker, 1–8. Changing it loads the running model again with the new number.
 *
 * @param p.card - Drawn as its own card (Settings) or as a row (the Models page).
 */
export function ChatsAtOnce({ card = false }: { card?: boolean }) {
  const he = getLocale() === "he";
  const [e, setE] = useState<Engine | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    void api<Engine>("/api/engines/llamacpp").then(setE, () => undefined);
  }, []);
  if (!e?.installed) return null;
  const set = (n: number) => void api<Engine>("/api/engines/llamacpp/settings", { method: "PUT", body: { parallel: n } }).then((x) => (setErr(""), setE(x)), (x: Error) => setErr(x.message));
  const pick = (
    <label className="row parallel-pick" title={t("parallelHint")}>
      <span className={card ? "" : "muted small"}>{t("parallelLabel")}</span>
      <Select value={e.parallel ?? 1} onChange={(ev) => set(Number(ev.target.value))}>
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}{n === 1 ? (he ? " (ברירת מחדל)" : " (default)") : ""}</option>)}
      </Select>
    </label>
  );
  if (!card) return pick;
  return (
    <section className="card stack">
      <h2>{he ? "צ׳אטים במקביל (המנוע המובנה)" : "Chats at once (built-in engine)"}</h2>
      {pick}
      <p className="muted small">
        {he
          ? "אחד: כל ההקשר הולך לצ׳אט אחד (הכי ארוך). יותר: כמה צ׳אטים עונים בבת אחת (טלפון, עבודה עצמית ועוד צ׳אט), וכל אחד מקבל הקשר קצר יותר. המהירות כמעט לא משתנה. המודל ייטען מחדש עם המספר החדש."
          : "One: the whole context goes to one chat (the longest). More: several chats answer at once (phone, self-work and another chat), each with a shorter context. Speed hardly changes. The model loads again with the new number."}
        {e.running && e.slotTokens ? ` ${he ? `עכשיו: ${Math.round(e.slotTokens / 1000)}K טוקנים לכל צ׳אט.` : `Now: ${Math.round(e.slotTokens / 1000)}K tokens per chat.`}` : ""}
      </p>
      {e.running && e.runningParallel !== undefined && e.parallel !== undefined && e.runningParallel < e.parallel && <p className="muted small">{t("parallelFellBack")}</p>}
      <FitMargin />
      <p className="muted small">{he ? "כשמשחק, Unreal או Unity רצים על אותו כרטיס: השאירו להם יותר. המודל ייטען מחדש." : "When a game, Unreal or Unity runs on the same card: leave them more. The model loads again."}</p>
      {err && <p className="error small">{err}</p>}
    </section>
  );
}
