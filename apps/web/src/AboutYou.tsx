import { useEffect, useState } from "react";
import { api } from "./api";
import { getAddress, getLocale, he$, setAddress } from "./i18n";
import type { HebrewAddress } from "@kesher/shared";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Her name and how to address her, from the computer (all her devices share it). */
interface User { name?: string; address?: HebrewAddress }

/** Loads the setting at start; when the address differs from the one this device remembered, the page reloads once. */
export async function loadUser(): Promise<User> {
  const u = await api<User>("/api/user").catch(() => ({}) as User);
  if (u.address !== getAddress()) {
    setAddress(u.address);
    location.reload();
  }
  return u;
}

const CHOICES: Array<[HebrewAddress, string, string]> = [
  ["f", "בלשון נקבה (כתבי, בחרי)", "Feminine (in Hebrew: כתבי)"],
  ["m", "בלשון זכר (כתוב, בחר)", "Masculine (in Hebrew: כתוב)"],
  ["p", "בלשון רבים (כתבו, בחרו)", "Plural or neutral (in Hebrew: כתבו)"],
];

/**
 * Settings → About you: the name the app and the models call her by, and how to address her in Hebrew (and other
 * gendered languages). The chat models get both.
 *
 * @param props.compact - The one-time question on the home screen (with a "later" button).
 * @param props.onDone - Called after saving (the home question closes).
 */
export function AboutYou({ compact, onDone }: { compact?: boolean; onDone?: () => void }) {
  const [u, setU] = useState<User | null>(null);
  const [name, setName] = useState("");
  useEffect(() => void api<User>("/api/user").then((x) => { setU(x); setName(x.name ?? ""); }, () => setU({})), []);
  if (!u) return null;
  const save = async (p: { name?: string; address?: HebrewAddress | "" }) => {
    const next = await api<User>("/api/user", { method: "PUT", body: p }).catch(() => undefined);
    if (!next) return;
    setU(next);
    onDone?.();
    // The interface's Hebrew changes form at once.
    if (next.address !== getAddress()) {
      setAddress(next.address);
      location.reload();
    }
  };
  return (
    <section className="card about-you">
      <h2>{compact ? L("רגע לפני שמתחילים", "Before we start") : L("עלייך", "About you")}</h2>
      <label className="study-field">
        <span>{L("איך לקרוא לך?", "What should I call you?")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== (u.name ?? "") && void save({ name })} placeholder={L("השם שלך", "Your name")} dir="auto" maxLength={60} />
      </label>
      <p className="muted small">{L("ובעברית, איך לפנות אלייך?", "And in Hebrew, how should I address you?")}</p>
      <div className="study-actions" role="radiogroup" aria-label={L("פנייה", "Address")}>
        {CHOICES.map(([a, he, en]) => (
          <button key={a} type="button" role="radio" aria-checked={u.address === a} className={u.address === a ? "primary" : ""} onClick={() => void save({ name, address: a })}>{getLocale() === "he" ? he : en}</button>
        ))}
        {compact && <button type="button" className="ghost" onClick={() => { try { localStorage.setItem("kesher-about-later", "1"); } catch { /* fine */ } onDone?.(); }}>{L("אחר כך", "Later")}</button>}
      </div>
      <p className="muted small">{L("גם המודלים בצ׳אט יקבלו את השם ואת צורת הפנייה. משתנה בכל רגע בהגדרות ← כללי.", "The chat models get the name and the form of address too. Change it any time in Settings → General.")}</p>
    </section>
  );
}
