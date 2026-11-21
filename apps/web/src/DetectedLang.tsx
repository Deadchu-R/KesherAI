import { getLocale, he$ } from "./i18n";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The languages offered in Settings → Speech and in "transcribe again as …" (the same list as the server's lang-detect.ts). */
export const SPEECH_LANGS: Array<{ code: string; he: string; en: string }> = [
  { code: "he", he: "עברית", en: "Hebrew" },
  { code: "en", he: "אנגלית", en: "English" },
  { code: "ar", he: "ערבית", en: "Arabic" },
  { code: "ru", he: "רוסית", en: "Russian" },
  { code: "es", he: "ספרדית", en: "Spanish" },
  { code: "fr", he: "צרפתית", en: "French" },
  { code: "de", he: "גרמנית", en: "German" },
  { code: "am", he: "אמהרית", en: "Amharic" },
  { code: "uk", he: "אוקראינית", en: "Ukrainian" },
];

/** A language's name in the app's language (the code itself when it is not in the list). */
export const langName = (code: string): string => {
  const l = SPEECH_LANGS.find((x) => x.code === code);
  return l ? (getLocale() === "he" ? l.he : l.en) : code;
};

/** What the server detected for a recording (the `detected` field of /api/speech/transcribe). */
export interface Detected {
  lang: string;
  langs: string[];
  outside: boolean;
  ranked: string[];
  retried: boolean;
  forced?: boolean;
}

/**
 * "Detected: Hebrew" under a transcript, with a "Transcribe again as …" choice when the audio is still around.
 *
 * @param props.d - What was detected.
 * @param props.onRedo - Called with the language chosen for a new transcription; leave out when the audio is gone (the line is then only shown).
 * @param props.busy - A new transcription is running.
 */
export function DetectedLang({ d, onRedo, busy }: { d: Detected; onRedo?: (lang: string) => void; busy?: boolean }) {
  const names = d.langs.map(langName).join(" + ");
  const choices = [...new Set([...d.ranked, ...SPEECH_LANGS.map((l) => l.code)])].filter((c) => c !== d.lang);
  return (
    <div className="detected-lang row small muted" role="status">
      <span>
        {d.forced ? L("תומלל כ:", "Transcribed as:") : L("זוהה:", "Detected:")} <strong>{names}</strong>
        {d.langs.length > 1 && ` (${L("מתחלפת באמצע", "switches part-way")})`}
        {d.outside && ` · ${L("מחוץ לשפות שלי", "outside my languages")}`}
        {d.retried && ` · ${L("תומלל שוב בשפה אחרת כי הכתב לא התאים", "redone in another language: the script did not fit")}`}
      </span>
      {onRedo && (
        <Select value="" disabled={busy} aria-label={L("תמלל שוב כ…", "Transcribe again as…")} onChange={(e) => e.target.value && onRedo(e.target.value)}>
          <option value="">{L("תמלל שוב כ…", "Transcribe again as…")}</option>
          {choices.map((c) => <option key={c} value={c}>{langName(c)}</option>)}
        </Select>
      )}
    </div>
  );
}
